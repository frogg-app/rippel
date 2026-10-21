/** Agent-managed model downloads need no ComfyUI custom node. Catalogue data
 * comes from the public upstream list; executable extensions are never fetched. */
import type { ModelCatalogEntry, AgentTask } from '@comfy/shared';
import { query, queryOne } from '../../db.js';
import { agentClient, type AgentTarget } from '../../deploy/agent-client.js';
import { folderForType } from '../../workflows/folders.js';
import { workflowCatalogue } from '../workflow-catalogue.js';
import { verifiedFile } from '../download-metadata.js';
import { getOperation, planOperation, startOperation } from '../operations.js';
import { TransportBusy, TransportError, type InstallRequest, type ModelTransport, type InstallProgress } from '../transport.js';
import { parseCatalogue, type RawCatalogueEntry } from './comfy-manager.js';

export const AGENT_CATALOGUE_URL = 'https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/model-list.json';
let catalogueCache: { until: number; entries: ModelCatalogEntry[] } | undefined;
let cataloguePending: Promise<ModelCatalogEntry[]> | undefined;
const folders = new Set(['checkpoints', 'loras', 'vae', 'controlnet', 'upscale_models', 'text_encoders', 'clip_vision', 'diffusion_models', 'embeddings']);

/** Normalize legacy folder aliases, while refusing paths outside model roots. */
export function agentModelPath(entry: Pick<ModelCatalogEntry, 'savePath' | 'filename' | 'type'>): string | null {
  if (/[\\/]/.test(entry.filename)) return null;
  let folder = entry.savePath === 'default' ? folderForType(entry.type) : entry.savePath;
  if (!folder) return null;
  folder = folder.replace(/\\/g, '/').replace(/^unet(?=\/|$)/, 'diffusion_models').replace(/^clip(?=\/|$)/, 'text_encoders');
  const path = `${folder}/${entry.filename}`;
  const parts = path.split('/');
  if (!folders.has(parts[0]!) || parts.some(p => !p || p === '.' || p === '..' || /[:\\\x00-\x1f]/.test(p))) return null;
  if (!/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(entry.filename)) return null;
  return path;
}

export async function agentCatalogue(): Promise<ModelCatalogEntry[]> {
  if (catalogueCache && catalogueCache.until > Date.now()) return catalogueCache.entries;
  if (cataloguePending) return cataloguePending;
  cataloguePending = (async () => {
    const response = await fetch(AGENT_CATALOGUE_URL, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new TransportError('The model catalogue is temporarily unavailable. Try again shortly.', true);
    const body = await response.json() as { models?: RawCatalogueEntry[] };
    if (!Array.isArray(body.models)) throw new TransportError('The model catalogue could not be read.', true);
    const entries = parseCatalogue(body.models).flatMap(entry => {
      let url: URL;
      try { url = new URL(entry.url); } catch { return []; }
      // HF supplies file SHA-256 through its publisher metadata. Other sources
      // are not offered until they have an equally verifiable metadata path.
      if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.username || url.password || url.port || url.hash || !url.pathname.includes('/resolve/')) return [];
      const path = agentModelPath(entry);
      if (!path) return [];
      return [{ ...entry, ref: path, savePath: path.slice(0, -entry.filename.length - 1), installed: false }];
    });
    const unique = [...new Map(entries.map(entry => [entry.ref, entry])).values()];
    catalogueCache = { until: Date.now() + 5 * 60_000, entries: unique };
    return unique;
  })();
  try { return await cataloguePending; } finally { cataloguePending = undefined; }
}

export class AgentModelTransport implements ModelTransport {
  readonly kind = 'rippel-agent';
  constructor(private readonly backendId: string, private readonly target: AgentTarget, private readonly baseUrl: string) {}
  async available(): Promise<boolean> {
    try {
      const ping = await agentClient.ping(this.target);
      const [major, minor] = ping.version.split('.').map(Number);
      return major! > 0 || (major === 0 && minor! >= 3);
    } catch { return false; }
  }
  async catalogue(): Promise<ModelCatalogEntry[]> {
    const upstream = await agentCatalogue();
    const entries = [...new Map([...workflowCatalogue(this.backendId, this.baseUrl), ...upstream].map(entry => [entry.ref, entry])).values()];
    const present = new Set<string>();
    await Promise.all([...new Set(entries.map(entry => entry.savePath.split('/')[0]!))].map(async folder => {
      const response = await fetch(`${this.baseUrl}/api/models/${encodeURIComponent(folder)}`, { signal: AbortSignal.timeout(5000) });
      if (response.status === 404) return;
      if (!response.ok) throw new Error('Engine model listing failed');
      const files: unknown = await response.json();
      if (Array.isArray(files)) for (const name of files) if (typeof name === 'string') present.add(`${folder}/${name.replace(/\\/g, '/')}`);
    })).catch(() => { throw new TransportError('The generation engine is not responding. Start it in Settings.', true); });
    return entries.map(entry => ({ ...entry, installed: present.has(entry.ref) }));
  }

  async install(request: InstallRequest): Promise<void> {
    if (!request.installId) throw new TransportError('The download could not be tracked. Try again.');
    const path = agentModelPath({ ...request, type: request.type as ModelCatalogEntry['type'] });
    if (!path) throw new TransportError('This model cannot be installed by the agent yet.');
    try {
      const file = await verifiedFile({ name: request.filename, directory: request.folder!, paths: [], url: request.url });
      const row = await queryOne<{ requested_by: string }>('SELECT requested_by FROM model_installs WHERE id = $1', [request.installId]);
      if (!row) throw new Error('Download record is missing.');
      const operation = await planOperation({ backendId: this.backendId, actorId: row.requested_by,
        steps: [{ kind: 'download', request: { url: file.url, path, sha256: file.sha256, sizeBytes: file.sizeBytes } }] });
      if (!operation) throw new Error('Download could not be recorded.');
      // Journal the association before dispatch; never replay a lost response.
      await query('UPDATE model_installs SET operation_id = $2, bytes_total = $3 WHERE id = $1', [request.installId, operation.id, file.sizeBytes]);
      const started = await startOperation(operation.id, true);
      if (!started) throw new Error('Download could not be started.');
      if (started.status === 'failed') throw new Error(started.error ?? 'Agent could not start the download.');
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') throw new TransportBusy('This machine is already installing a model. Wait for it to finish, then try again.');
      throw new TransportError(error instanceof Error ? error.message : 'The download could not start.');
    }
  }
  async progress(request: InstallRequest): Promise<InstallProgress> {
    const row = await queryOne<{ operation_id: string | null; created_at: Date }>('SELECT operation_id, created_at FROM model_installs WHERE id = $1', [request.installId]);
    if (!row?.operation_id) {
      if (row && Date.now() - row.created_at.getTime() < 120_000) return { state: 'queued', detail: 'Preparing download' };
      return { state: 'failed', detail: null, error: 'Download setup was interrupted. Please try again.' };
    }
    const operation = await getOperation(row.operation_id);
    if (!operation) return { state: 'failed', detail: null, error: 'Download record is missing.' };
    if (operation.status === 'planned') return { state: 'queued', detail: 'Waiting for this machine’s current downloads or file operations to finish' };
    if (operation.status === 'starting') return { state: 'queued', detail: 'Starting download' };
    const task = operation.progress as AgentTask | null;
    return { state: operation.status === 'done' ? 'complete' : operation.status === 'failed' ? 'failed' : 'downloading',
      detail: task?.approvalRequired ? 'Approval needed' : operation.status === 'done' ? 'Download verified' : 'Downloading model',
      approvalRequired: task?.status === 'running' ? task.approvalRequired ?? null : null,
      bytesReceived: task?.bytesReceived, error: operation.error ?? undefined };
  }
}
