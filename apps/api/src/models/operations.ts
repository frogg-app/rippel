/** Step execution is journalled before contacting the agent. A lost start
 * response is never retried automatically: the remote file action may have
 * succeeded. Polling known task IDs is safe across API/browser restarts. */
import { query, queryOne, transaction } from '../db.js';
import { AgentError, agentClient, type ModelDownloadRequest, type ModelMoveRequest } from '../deploy/agent-client.js';
import { clearObjectInfoCache } from '../orchestrator/preflight.js';
import { pollBackendNow } from '../lib/backend-poller.js';
export type ModelOperationStep = { kind: 'move'; request: ModelMoveRequest } | { kind: 'download'; request: ModelDownloadRequest };
export interface ModelOperation {
  id: string; backend_id: string | null; model_id: string | null; workflow_id: string | null;
  steps: ModelOperationStep[]; step_index: number; agent_task_id: string | null;
  status: 'planned' | 'starting' | 'running' | 'done' | 'failed'; progress: unknown; error: string | null;
}
export async function planOperation(input: { backendId: string; modelId?: string; workflowId?: string; actorId: string; steps: ModelOperationStep[] }) {
  if (!input.steps.length) throw new Error('There are no file operations to perform.');
  return queryOne<ModelOperation>(`INSERT INTO model_operations (backend_id,model_id,workflow_id,actor_id,steps)
    VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
  [input.backendId, input.modelId ?? null, input.workflowId ?? null, input.actorId, JSON.stringify(input.steps)]);
}
export const getOperation = (id: string) => queryOne<ModelOperation>('SELECT * FROM model_operations WHERE id = $1', [id]);
export async function startOperation(id: string, queue = false): Promise<ModelOperation | null> {
  let claimed: ModelOperation | null;
  try {
    claimed = await queryOne<ModelOperation>(`UPDATE model_operations AS candidate SET status = 'starting', updated_at = now()
      WHERE id = $1 AND status = 'planned'
      ${queue ? `AND EXISTS (SELECT 1 FROM model_installs i WHERE i.operation_id = candidate.id AND i.status IN ('queued','downloading'))
      AND NOT EXISTS (SELECT 1 FROM model_operations active WHERE active.backend_id = candidate.backend_id AND active.status IN ('starting','running'))
      AND NOT EXISTS (SELECT 1 FROM model_operations earlier JOIN model_installs i ON i.operation_id = earlier.id
        WHERE earlier.backend_id = candidate.backend_id AND earlier.status = 'planned' AND i.status IN ('queued','downloading')
          AND (earlier.created_at, earlier.id) < (candidate.created_at, candidate.id))` : ''}
      RETURNING *`, [id]);
  } catch (error) {
    // Another dispatcher can claim this backend between the check and update.
    // The unique index is the final arbiter; no remote action was sent yet.
    const conflict = error as { code?: string; constraint?: string };
    if (!queue || conflict.code !== '23505' || conflict.constraint !== 'model_operation_active_backend') throw error;
    return getOperation(id);
  }
  if (claimed) await dispatchStep(claimed, queue);
  return getOperation(id);
}
/** How to reach a backend agent, from its latest deployment. */
export async function agentTarget(backendId: string) {
  const row = await queryOne<{ host: string; agent_url?: string | null; agent_port: number; token: string }>(
    'SELECT host, agent_port, agent_url, token FROM deployments WHERE backend_id = $1 ORDER BY created_at DESC LIMIT 1', [backendId]);
  if (!row) throw new Error('This backend has no rippel agent.');
  return { host: row.host, agentPort: row.agent_port, token: row.token, ...(row.agent_url ? {agentUrl:row.agent_url} : {}) };
}
async function dispatchStep(operation: ModelOperation, queue = false) {
  try {
    if (!operation.backend_id) throw new Error('This backend has been removed.');
    const step = operation.steps[operation.step_index];
    if (!step) throw new Error('Operation has no current step.');
    const host = await agentTarget(operation.backend_id);
    const task = step.kind === 'move' ? await agentClient.moveModel(host, step.request) : await agentClient.downloadModel(host, step.request);
    await query(`UPDATE model_operations SET status = 'running', agent_task_id = $2, progress = $3::jsonb, updated_at = now() WHERE id = $1`,
      [operation.id, task.id, JSON.stringify(task)]);
  } catch (error) {
    // A definite busy refusal means nothing started. Keep queued downloads
    // durable until the agent's other task ends; never replay lost responses.
    if (queue && error instanceof AgentError && error.kind === 'busy' && operation.steps[operation.step_index]?.kind === 'download') {
      await query(`UPDATE model_operations SET status='planned', agent_task_id=NULL, progress=NULL, error=NULL, updated_at=now() WHERE id=$1`, [operation.id]);
      return;
    }
    await query(`UPDATE model_operations SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
      [operation.id, `Could not confirm the file operation: ${(error as Error).message} Re-check the backend before retrying.`]);
  }
}
export async function recheck(backendId: string) {
  const host = await queryOne<{ base_url: string }>('SELECT base_url FROM backends WHERE id = $1', [backendId]);
  if (host) clearObjectInfoCache(host.base_url);
  await pollBackendNow(backendId);
}
export async function pollOperation(operation: ModelOperation) {
  if (!operation.agent_task_id || !operation.backend_id) return;
  let task;
  try {
    ({ task } = await agentClient.task(await agentTarget(operation.backend_id), operation.agent_task_id, 0));
  } catch (error) {
    if (!(error instanceof AgentError) || error.status !== 404) throw error;
    // Agent tasks are held in memory. After a restart an unknown task is a
    // definite loss of tracking, not evidence that the file action can replay.
    // Match the task ID to avoid failing a newer step claimed by another poll.
    await query(`UPDATE model_operations SET status='failed',
      error='File tracking was lost when the agent restarted. Check installed files before retrying.',
      updated_at=now() WHERE id=$1 AND status='running' AND agent_task_id=$2`,
    [operation.id, operation.agent_task_id]);
    await recheck(operation.backend_id).catch(() => {});
    return;
  }
  if (task.status === 'running') {
    await query('UPDATE model_operations SET progress = $2::jsonb, updated_at = now() WHERE id = $1', [operation.id, JSON.stringify(task)]);
    return;
  }
  const next = await transaction(async (client) => {
    const locked = await client.query<ModelOperation>('SELECT * FROM model_operations WHERE id = $1 FOR UPDATE', [operation.id]);
    const current = locked.rows[0];
    if (!current || current.status !== 'running' || current.agent_task_id !== task.id) return null;
    const stepIndex = current.step_index + (task.status === 'done' ? 1 : 0);
    const status = task.status === 'failed' ? 'failed' : stepIndex === current.steps.length ? 'done' : 'starting';
    const updated = await client.query<ModelOperation>(`UPDATE model_operations SET status=$2, step_index=$3,
      progress=$4::jsonb, error=$5, agent_task_id=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
    [current.id, status, stepIndex, JSON.stringify(task), task.error]);
    return updated.rows[0];
  });
  if (!next) return;
  await recheck(operation.backend_id).catch(() => {});
  if (next.status === 'starting') await dispatchStep(next);
}
export function startModelOperationPoller(log: (message: string) => void) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // Starting is normally a few seconds. After an API crash it is ambiguous,
      // so do not silently replay an action against a shared machine.
      await query(`UPDATE model_operations SET status='failed', error='Agent start was interrupted. Re-check files before retrying.'
        WHERE status='starting' AND updated_at < now() - interval '2 minutes'`);
      for (const operation of await query<ModelOperation>("SELECT * FROM model_operations WHERE status='running'")) {
        await pollOperation(operation).catch((error) => log(`File operation ${operation.id}: ${(error as Error).message}`));
      }
      // Only accepted, live installs belong to the queue. Unlinked plans and
      // plans belonging to old failed attempts must never start implicitly.
      for (const operation of await query<ModelOperation>(`SELECT o.* FROM model_operations o
        JOIN model_installs i ON i.operation_id=o.id
        WHERE o.status='planned' AND i.status IN ('queued','downloading')
        ORDER BY o.created_at, o.id`)) {
        await startOperation(operation.id, true).catch((error) => log(`Queued download ${operation.id}: ${(error as Error).message}`));
      }
    } finally { busy = false; }
  };
  const timer = setInterval(() => void tick().catch((error) => log(String(error))), 2000);
  return () => clearInterval(timer);
}
