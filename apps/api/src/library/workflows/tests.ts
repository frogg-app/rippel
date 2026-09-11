/** Test prompt IDs are persisted before polling, allowing API restarts while
 * ComfyUI runs. Only verified output changes a revision to Ready. */
import { query, queryOne } from '../../db.js';
import { objectInfoFor } from '../../orchestrator/preflight.js';
import { getImported, importedTemplate } from './store.js';
import { inspectSmoke, submitSmoke } from './smoke.js';
export async function startWorkflowTest(workflowId: string, backendId: string) {
  const row = await getImported(workflowId);
  const host = await queryOne<{ base_url: string }>('SELECT base_url FROM backends WHERE id=$1 AND enabled', [backendId]);
  const template = row ? importedTemplate(row) : undefined;
  if (!template || !host) throw new Error('Workflow controls or backend are unavailable.');
  const claim = await queryOne(`INSERT INTO workflow_backend_tests (workflow_id,backend_id,status,tested_at)
    VALUES ($1,$2,'testing',now()) ON CONFLICT (workflow_id,backend_id) DO UPDATE
    SET status='testing',prompt_id=NULL,result=NULL,tested_at=now()
    WHERE workflow_backend_tests.status <> 'testing' RETURNING workflow_id`, [workflowId, backendId]);
  if (!claim) throw new Error('A test is already running on this backend.');
  try {
    const started = await submitSmoke(template, host.base_url, await objectInfoFor(host.base_url));
    await query('UPDATE workflow_backend_tests SET prompt_id=$3,result=$4::jsonb WHERE workflow_id=$1 AND backend_id=$2',
      [workflowId, backendId, started.promptId, JSON.stringify(started)]);
    return started;
  } catch (error) {
    await query("UPDATE workflow_backend_tests SET status='failed',result=$3::jsonb WHERE workflow_id=$1 AND backend_id=$2",
      [workflowId, backendId, JSON.stringify({ error: (error as Error).message })]);
    throw error;
  }
}
export function startWorkflowTestPoller(log: (message: string) => void) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await query(`UPDATE workflow_backend_tests SET status='failed',result='{"error":"Test submission was interrupted; inspect the backend queue before testing again."}'::jsonb
        WHERE status='testing' AND prompt_id IS NULL AND tested_at < now() - interval '2 minutes'`);
      const tests = await query<{ workflow_id: string; backend_id: string; prompt_id: string; base_url: string }>(
        `SELECT t.*,b.base_url FROM workflow_backend_tests t JOIN backends b ON b.id=t.backend_id
         WHERE t.status='testing' AND t.prompt_id IS NOT NULL`);
      for (const test of tests) {
        try {
          const result = await inspectSmoke(test.base_url, test.prompt_id);
          if (result.status === 'running') continue;
          await query(`UPDATE workflow_backend_tests SET status=$3,result=coalesce(result,'{}'::jsonb) || $4::jsonb,
            tested_at=now() WHERE workflow_id=$1 AND backend_id=$2 AND prompt_id=$5`,
          [test.workflow_id,test.backend_id,result.status,JSON.stringify({ ...result, finishedAt: new Date().toISOString() }),test.prompt_id]);
        } catch (error) { log(`Workflow test ${test.workflow_id}: ${(error as Error).message}`); }
      }
    } finally { busy = false; }
  };
  const timer = setInterval(() => void tick().catch((error) => log(String(error))), 3000);
  return () => clearInterval(timer);
}
