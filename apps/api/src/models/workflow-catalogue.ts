import type { ModelCatalogEntry, ModelType } from '@comfy/shared';
import { workflowLibrary, type LibraryEntry } from '../library/workflows/catalogue.js';
import { FOLDER_READ_BY } from '../workflows/folders.js';

const types: Record<string, ModelType> = { checkpoints: 'checkpoint', diffusion_models: 'checkpoint', loras: 'lora', vae: 'vae', text_encoders: 'clip', clip_vision: 'clip', controlnet: 'controlnet', upscale_models: 'upscaler' };
/** Read declared model files only, including declarations inside subgraphs. */
export function workflowModelEntries(graph: unknown, workflow: LibraryEntry): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  function visit(value: unknown, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 20) return;
    const root = value as { nodes?: { type?: string; properties?: { models?: unknown[] } }[]; definitions?: { subgraphs?: unknown[] } };
    for (const node of Array.isArray(root.nodes) ? root.nodes : []) {
      for (const raw of Array.isArray(node.properties?.models) ? node.properties.models : []) {
        const file = raw as { name?: string; url?: string; directory?: string } | null;
        if (!file || typeof file.name !== 'string' || typeof file.url !== 'string' || typeof file.directory !== 'string') continue;
        if (!node.type || FOLDER_READ_BY[node.type] !== file.directory || !types[file.directory]) continue;
        if (!/^[^/\\\x00-\x1f:]+\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(file.name) || file.name === '..') continue;
        let url: URL;
        try { url = new URL(file.url); } catch { continue; }
        if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.username || url.password || url.port || url.hash || !/^\/[^/]+\/[^/]+\/resolve\//.test(url.pathname)) continue;
        entries.push({ sourceWorkflow: { name: workflow.name, title: workflow.title }, ref: `${file.directory}/${file.name}`, name: `${workflow.models.join(' / ') || workflow.title} · ${file.name}`,
          filename: file.name, type: types[file.directory]!, base: workflow.models.join(' / ') || 'Unknown',
          description: `Referenced by ${workflow.title}. Check this workflow and its required files before generating.`,
          size: null, url: url.href, reference: `${url.origin}/${url.pathname.split('/').slice(1,3).join('/')}`,
          savePath: file.directory, installed: false, info: null, runnability: null });
      }
    }
    for (const subgraph of root.definitions?.subgraphs ?? []) visit(subgraph, depth + 1);
  }
  visit(graph);
  return entries;
}
interface Snapshot { entries: ModelCatalogEntry[]; pending: number; until: number }
const snapshots = new Map<string, Snapshot>();
export function workflowCataloguePending(backendId: string, baseUrl: string): number {
  return snapshots.get(`${backendId}|${baseUrl}`)?.pending ?? 0;
}
/** Fill progressively so a large workflow library never blocks the model grid. */
export function workflowCatalogue(backendId: string, baseUrl: string): ModelCatalogEntry[] {
  const key = `${backendId}|${baseUrl}`;
  let snapshot = snapshots.get(key);
  if (snapshot && (snapshot.pending || snapshot.until > Date.now())) return snapshot.entries;
  snapshot = { entries: snapshot?.entries ?? [], pending: 1, until: Date.now() + 300_000 };
  if (snapshots.size >= 32 && !snapshots.has(key)) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(key, snapshot);
  const current = snapshot;
  void (async () => {
    const catalogue = await workflowLibrary.catalogue(backendId, baseUrl);
    const waiting = catalogue.entries.filter(entry => entry.openSource).sort((a,b) => b.date.localeCompare(a.date));
    current.pending = waiting.length;
    const found = new Map<string, ModelCatalogEntry>();
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (waiting.length) {
        const entry = waiting.shift()!;
        try {
          const graph = await workflowLibrary.workflow(backendId, baseUrl, entry.name, catalogue.version);
          for (const file of workflowModelEntries(graph, entry)) if (!found.has(file.ref)) found.set(file.ref, file);
          current.entries = [...found.values()];
        } catch { /* One unavailable template must not hide the remaining models. */ }
        finally { current.pending--; }
      }
    }));
  })().catch(() => { current.until = Date.now() + 30_000; }).finally(() => { current.pending = 0; });
  return current.entries;
}
