/** A real smoke test compiles the normal manifest, submits it to ComfyUI and
 * verifies a downloadable output. HTTP acceptance alone is never success. */
import sharp from 'sharp';
import type { AspectRatio, GenerationParams } from '@comfy/shared';
import { compile } from '../../compiler/compile.js';
import { ComfyClient, comboOptions, type ObjectInfo } from '../../lib/comfy.js';
import { checkGraph } from '../../orchestrator/preflight.js';
import { sendInitImageToBackend, withInitImage } from '../../workflows/init-image.js';
import { withResolvedRequirements } from '../../workflows/requirements.js';
import { videoLimitsFor } from '../../workflows/video-limits.js';
import type { WorkflowTemplate } from '../../workflows/types.js';

export function cheapestParams(template: WorkflowTemplate): GenerationParams {
  const manifest = template.manifest;
  const aspect = (Object.entries(manifest.resolutions).sort(([, a], [, b]) => a.width * a.height - b.width * b.height)[0]![0]) as AspectRatio;
  const limits = videoLimitsFor(manifest);
  const frames = limits ? Math.ceil((limits.frames.min - 1) / limits.frameQuantum) * limits.frameQuantum + 1 : 0;
  return { kind: manifest.capability, modelId: 'smoke-model', prompt: 'A small boat on calm water.',
    quality: 'fast', aspect, batchSize: 1, advanced: { seed: 1 },
    ...(['img2img', 'img2vid'].includes(manifest.capability) ? { references: [{ role: 'init' as const, influence: 0.7,
      source: { from: 'upload' as const, uploadId: '00000000-0000-4000-8000-000000000001' } }] } : {}),
    ...(limits ? { video: { lengthSeconds: frames / limits.fps.min, fps: limits.fps.min } } : {}) };
}
export async function submitSmoke(template: WorkflowTemplate, baseUrl: string, info: ObjectInfo, filename?: string) {
  const binding = template.manifest.inputs.find((input) => input.source === 'checkpointFilename');
  const [nodeId, , inputName] = binding?.path.split('.') ?? [];
  const node = nodeId ? template.graph[nodeId] : undefined;
  if (!node || !inputName) throw new Error('Workflow has no model binding.');
  const spec = info[node.class_type];
  const offered = comboOptions(spec?.input?.required?.[inputName] ?? spec?.input?.optional?.[inputName]) ?? [];
  const literal = node.inputs[inputName];
  const chosen = filename ?? (typeof literal === 'string' && offered.includes(literal) ? literal : undefined);
  if (!chosen) throw new Error(`Missing file: ${literal ?? 'primary model'}`);
  const params = cheapestParams(template);
  let graph = compile({ template, params, modelFilenames: { 'smoke-model': chosen }, jobId: crypto.randomUUID() }).graph;
  graph = withResolvedRequirements(graph, template, info);
  const checks = checkGraph(graph, info);
  if (checks.missingNodeClasses.length) throw new Error(`Missing node: ${checks.missingNodeClasses.join(', ')}`);
  if (checks.missingFiles.length) throw new Error(`Missing file: ${checks.missingFiles.map((file) => file.filename).join(', ')}`);
  if (params.kind === 'img2img' || params.kind === 'img2vid') {
    const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#4b8699' } }).png().toBuffer();
    const uploaded = await sendInitImageToBackend({ backendUrl: baseUrl, bytes });
    graph = withInitImage(graph, uploaded.reference, template.manifest.initImageNodeId);
  }
  const response = await fetch(`${baseUrl}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'rippel-smoke' }), signal: AbortSignal.timeout(30_000) });
  const body = await response.json() as { prompt_id?: string; node_errors?: Record<string, unknown>; error?: unknown };
  if (!response.ok || !body.prompt_id || Object.keys(body.node_errors ?? {}).length) throw new Error(`ComfyUI rejected workflow: ${JSON.stringify(body)}`);
  return { promptId: body.prompt_id, params, startedAt: new Date().toISOString() };
}
export async function inspectSmoke(baseUrl: string, promptId: string): Promise<{ status: 'running' | 'ready' | 'failed'; output?: string; error?: string }> {
  const response = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`History returned HTTP ${response.status}.`);
  const history = await response.json() as Record<string, { status?: { completed?: boolean; status_str?: string }; outputs?: Record<string, Record<string, unknown>> }>;
  const entry = history[promptId];
  if (!entry) return { status: 'running' };
  if (entry.status?.status_str === 'error') return { status: 'failed', error: 'ComfyUI execution failed. Check its execution log.' };
  if (!entry.status?.completed) return { status: 'running' };
  for (const output of Object.values(entry.outputs ?? {})) {
    for (const value of Object.values(output)) {
      if (!Array.isArray(value)) continue;
      for (const ref of value) {
        if (!ref || typeof ref.filename !== 'string' || ref.type !== 'output') continue;
        const file = await new ComfyClient(baseUrl).viewImage(ref);
        if (file.bytes.length) return { status: 'ready', output: ref.filename };
      }
    }
  }
  return { status: 'failed', error: 'Job completed without a downloadable output file.' };
}
