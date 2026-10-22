/**
 * Running a job on a stable-diffusion.cpp backend.
 *
 * The ComfyUI path compiles a graph, POSTs it and listens on a socket. This
 * path has less to do and does it differently in two places that matter:
 *
 *  1. **The model has to be loaded first.** sd-server holds one model at a
 *     time, and loading it is a request that blocks until the weights are in
 *     memory — minutes for a 14B video model, and longer than the agent tunnel
 *     keeps a request open. So dispatch never waits for a load. If the server
 *     already holds the right model the job is submitted at once; otherwise the
 *     load is *asked for* and the job records a `load:` prompt id. Every tick
 *     after that polls the model status, says "Loading <model>" to the user,
 *     and submits the real job the moment the server reports ready. A load
 *     that fails fails the job with the server's own words.
 *
 *  2. **Progress is polled, not pushed.** `GET /sdcpp/v1/jobs/:id` carries the
 *     step counter and the latest preview frame; the orchestrator's one-second
 *     tick is the right cadence for that. The same poll carries the result as
 *     base64, so there is no second download.
 *
 * Everything the post-load submit needs is written to `jobs.resolved` at
 * dispatch, so an API restart mid-load loses nothing: the next process reads
 * the plan back and carries on.
 */

import { randomUUID } from 'node:crypto';
import type { Asset, JobProgress, Uuid } from '@comfy/shared';
import { queryOne, query } from '../db.js';
import { isVideoResult, SdcppClient, SdcppError, type SdcppJob } from '../lib/sdcpp.js';
import { persistOutput } from '../storage/persist.js';
import { chooseTemplate } from '../models/workflow-choice.js';
import { dimensionsFor, videoFrameCount } from '../compiler/compile.js';
import { resolveSeed } from '../compiler/seed.js';
import type { JobRow } from './jobs.js';
import { DispatchError } from './dispatch.js';
import type { Candidate } from './select.js';
import {
  fallbackDimensions,
  planFor,
  sdcppSampler,
  sdcppScheduler,
  type SdcppKind,
  type SdcppPlan,
} from './sdcpp-plan.js';

/** The prefix of a prompt id that means "waiting for the model to load". */
export const LOAD_PREFIX = 'load:';

/** How long a load may take before the job is failed. Big models off slow disks are slow. */
const LOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** How often the load is re-asked for when the server sits idle without it. */
const RELOAD_EVERY_MS = 60 * 1000;

/**
 * What the dispatcher wrote down for the ticks that follow. Lives inside
 * `jobs.resolved` under `sdcpp`, beside the seed and dimensions the rest of
 * rippel reads from that column.
 */
export interface SdcppJobSpec {
  recipe: string;
  models: Record<string, string>;
  kind: SdcppKind;
  request: Record<string, unknown>;
  modelLabel: string;
  steps: number;
  frames: number | null;
  fps: number | null;
}

export interface SdcppResolved {
  templateId: string;
  seed: number;
  checkpoint: string;
  loras: { filename: string; weight: number }[];
  width: number;
  height: number;
  values: Record<string, string | number | boolean>;
  loraNodeIds: string[];
  sdcpp: SdcppJobSpec;
}

export interface SdcppDispatched {
  promptId: string;
  templateId: string;
  resolved: SdcppResolved;
  modelLabel: string;
  totalFrames: number | null;
}

/** The last load we asked for, per load token, so it is not re-asked every tick. */
const loadRequests = new Map<string, number>();

/** True when the server holds exactly the recipe and files the plan wants. */
export function holdsPlan(
  status: { state: string; recipe: string | null; models: Record<string, string> },
  plan: Pick<SdcppPlan, 'recipe' | 'models'>,
): boolean {
  if (status.state !== 'ready' || status.recipe !== plan.recipe) return false;
  return Object.entries(plan.models).every(([slot, fileId]) => status.models[slot] === fileId);
}

/**
 * The request body for `img_gen` or `vid_gen`.
 *
 * Steps, guidance, sampler and resolution come from the same template presets
 * ComfyUI uses when a template exists for the family, so the two engines give
 * the same answer to "fast / balanced / high". Without a template the recipe's
 * own defaults apply, scaled by quality only when the recipe is not a few-step
 * distilled model (inflating a 4-step turbo to 8 steps burns the image).
 */
export function buildSdcppRequest(input: {
  job: JobRow;
  plan: SdcppPlan;
  preset: { steps: number; cfg: number; sampler?: string; scheduler?: string } | null;
  dimensions: { width: number; height: number };
  seed: number;
  frames: number | null;
  initImage: string | null;
  loras: { path: string; multiplier: number }[];
}): Record<string, unknown> {
  const { job, plan } = input;
  const params = job.params;
  const advanced = (params.advanced ?? {}) as Record<string, unknown>;
  const defaults = plan.defaults;

  const defaultSteps = typeof defaults.steps === 'number' ? defaults.steps : 20;
  // A few-step distilled recipe (SD-Turbo at 1, Z-Image Turbo at 9) knows its
  // own numbers better than the family template does: the SD 2.x template's
  // "fast" is 16 steps at cfg 7, which burns a turbo checkpoint. The user's
  // explicit advanced values still win.
  const distilled = defaultSteps <= 9;
  const preset = distilled ? null : input.preset;
  const qualityScale = params.quality === 'fast' ? 0.6 : params.quality === 'high' ? 1.5 : 1;
  const steps =
    typeof advanced.steps === 'number'
      ? advanced.steps
      : preset
        ? preset.steps
        : distilled
          ? defaultSteps
          : Math.max(1, Math.round(defaultSteps * qualityScale));
  const cfg =
    typeof advanced.guidance === 'number'
      ? advanced.guidance
      : preset
        ? preset.cfg
        : typeof defaults.cfg_scale === 'number'
          ? defaults.cfg_scale
          : 7;

  const sampler = sdcppSampler(
    (typeof advanced.sampler === 'string' ? advanced.sampler : undefined) ??
      preset?.sampler ??
      (typeof defaults.sampling_method === 'string' ? defaults.sampling_method : undefined),
  );
  const scheduler = sdcppScheduler(
    (typeof advanced.scheduler === 'string' ? advanced.scheduler : undefined) ??
      preset?.scheduler ??
      (typeof defaults.scheduler === 'string' ? defaults.scheduler : undefined),
  );

  const sampleParams: Record<string, unknown> = {
    sample_steps: steps,
    guidance: {
      txt_cfg: cfg,
      ...(typeof defaults.distilled_guidance === 'number' ? { distilled_guidance: defaults.distilled_guidance } : {}),
    },
    ...(sampler ? { sample_method: sampler } : {}),
    ...(scheduler ? { scheduler } : {}),
    ...(typeof defaults.flow_shift === 'number' ? { flow_shift: defaults.flow_shift } : {}),
  };

  const init = params.references?.find((r) => r.role === 'init');
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    negative_prompt: params.negativePrompt ?? '',
    width: input.dimensions.width,
    height: input.dimensions.height,
    seed: input.seed,
    sample_params: sampleParams,
    lora: input.loras,
    // `proj` is the cheap latent projection: a recognisable frame per step for
    // the cost of nothing. `tae` would be prettier and needs a file.
    preview: 'proj',
    preview_interval: 1,
    ...(input.initImage ? { init_image: input.initImage, strength: init?.influence ?? 0.75 } : {}),
  };

  if (plan.kind === 'img_gen') {
    body.batch_count = params.batchSize;
    body.output_format = 'png';
  } else {
    body.video_frames = input.frames ?? (typeof defaults.video_frames === 'number' ? defaults.video_frames : 33);
    body.fps = params.video?.fps ?? (typeof defaults.fps === 'number' ? defaults.fps : 16);
    // Animated WebP rather than WebM: every release build can encode it, the
    // library's thumbnailer can read it, and the browser plays it inline.
    body.output_format = 'webp';
  }
  return body;
}

async function initImageDataUrl(job: JobRow): Promise<string | null> {
  const init = job.params.references?.find((r) => r.role === 'init');
  if (!init) return null;
  const row =
    init.source.from === 'asset'
      ? await queryOne<{ storage_key: string }>(
          `SELECT storage_key FROM assets WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [init.source.assetId, job.user_id],
        )
      : await queryOne<{ storage_key: string }>('SELECT storage_key FROM uploads WHERE id = $1 AND user_id = $2', [
          init.source.uploadId,
          job.user_id,
        ]);
  if (!row) throw new DispatchError('That reference image is no longer in your library.', false);
  const driver = (await import('../storage/index.js')).storage();
  const bytes = await driver.get(row.storage_key);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

/**
 * Compile-equivalent for sd.cpp: plan, build the request, and either submit
 * or ask for the load. Returns once the backend has accepted one or the other.
 */
export async function dispatchSdcpp(
  job: JobRow,
  backend: Candidate,
  model: { base_model: string | null; display_name: string; filename: string },
): Promise<SdcppDispatched> {
  const client = new SdcppClient(backend.base_url);
  let files, recipes, status;
  try {
    [files, recipes, status] = await Promise.all([client.modelFiles(), client.recipes(), client.modelStatus()]);
  } catch (err) {
    throw new DispatchError(`Could not reach ${backend.name}: ${err instanceof Error ? err.message : String(err)}`, true);
  }

  const planned = planFor({
    family: model.base_model,
    checkpointFilename: model.filename,
    modelLabel: model.display_name,
    capability: job.params.kind,
    files,
    recipes,
  });
  if (!planned.ok) throw new DispatchError(planned.reason, false);
  const plan = planned.plan;

  // One model at a time per server: a job that needs a different model than
  // the one another in-flight job is using waits its turn rather than
  // unloading the weights from under it.
  const other = await queryOne<{ id: string }>(
    `SELECT id FROM jobs
      WHERE backend_id = $1 AND id <> $2
        AND status IN ('dispatched', 'running', 'uploading')
        AND resolved->'sdcpp'->>'recipe' IS DISTINCT FROM $3
      LIMIT 1`,
    [backend.id, job.id, plan.recipe],
  );
  if (other) throw new DispatchError(`${backend.name} is busy with a different model.`, true);

  // Presets and sizes from the ComfyUI template for the family, when there is
  // one — the numbers behind "fast / balanced / high" should not depend on the
  // engine. The template is chosen without a backend on purpose: its graph is
  // never used here, only its manifest.
  const choice = await chooseTemplate({
    modelId: job.params.modelId,
    capability: job.params.kind,
    family: model.base_model,
    filename: model.filename,
  }).catch(() => null);
  const manifest = choice?.template.manifest ?? null;
  const preset = manifest?.quality[job.params.quality] ?? null;
  const dimensions = manifest ? dimensionsFor(job.params.aspect, manifest) : fallbackDimensions(job.params.aspect, plan.defaults);
  const frames =
    plan.kind === 'vid_gen'
      ? (manifest ? videoFrameCount(job.params, manifest) ?? null : job.params.video ? Math.round(job.params.video.lengthSeconds * job.params.video.fps) : null)
      : null;

  const advanced = (job.params.advanced ?? {}) as { seed?: number };
  const seed = resolveSeed(advanced.seed);

  // Style add-ons by path under loras/, which is how sd-server names them.
  const loraRows = job.params.loras?.length
    ? await query<{ id: string; filename: string }>('SELECT id, filename FROM models WHERE id = ANY($1::uuid[])', [
        job.params.loras.map((l) => l.modelId),
      ])
    : [];
  const loras = (job.params.loras ?? []).flatMap((selection) => {
    const row = loraRows.find((r) => r.id === selection.modelId);
    return row ? [{ path: row.filename.replace(/\\/g, '/'), multiplier: selection.weight }] : [];
  });

  const request = buildSdcppRequest({
    job,
    plan,
    preset: preset ? { steps: preset.steps, cfg: preset.cfg, sampler: preset.sampler, scheduler: preset.scheduler } : null,
    dimensions,
    seed,
    frames,
    initImage: await initImageDataUrl(job),
    loras,
  });

  const spec: SdcppJobSpec = {
    recipe: plan.recipe,
    models: plan.models,
    kind: plan.kind,
    request,
    modelLabel: model.display_name,
    steps: Number((request.sample_params as { sample_steps: number }).sample_steps),
    frames: plan.kind === 'vid_gen' ? Number(request.video_frames) : null,
    fps: plan.kind === 'vid_gen' ? Number(request.fps) : null,
  };
  const resolved: SdcppResolved = {
    templateId: `sdcpp:${plan.recipe}`,
    seed,
    checkpoint: model.filename,
    loras: loras.map((l) => ({ filename: l.path, weight: l.multiplier })),
    width: dimensions.width,
    height: dimensions.height,
    values: {
      prompt: job.params.prompt,
      steps: spec.steps,
      guidance: Number((request.sample_params as { guidance: { txt_cfg: number } }).guidance.txt_cfg),
      ...(spec.frames !== null ? { frameCount: spec.frames } : {}),
    },
    loraNodeIds: [],
    sdcpp: spec,
  };

  let promptId: string;
  if (holdsPlan(status, plan)) {
    promptId = await submit(client, backend.name, spec);
  } else {
    promptId = LOAD_PREFIX + randomUUID();
    requestLoad(client, promptId, plan);
  }

  return { promptId, templateId: resolved.templateId, resolved, modelLabel: model.display_name, totalFrames: spec.frames };
}

async function submit(client: SdcppClient, backendName: string, spec: SdcppJobSpec): Promise<string> {
  try {
    const accepted = await client.submit(spec.kind, spec.request);
    if (!accepted.id) throw new DispatchError('The backend accepted the job but returned no id.', true);
    return accepted.id;
  } catch (err) {
    if (err instanceof DispatchError) throw err;
    if (err instanceof SdcppError) {
      // 400 is our request; 429 is a full queue; 503 is a model mid-load. Only
      // the first is permanent.
      throw new DispatchError(`${backendName} rejected the job: ${err.message}`, err.status !== 400);
    }
    throw new DispatchError(`Could not reach ${backendName}: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

/**
 * Ask the server to load, and do not wait. The request is held open by the
 * server until the load ends, which is why its result is ignored here: the
 * ticks read `models/status` instead, and that call answers during a load.
 */
function requestLoad(client: SdcppClient, token: string, plan: Pick<SdcppPlan, 'recipe' | 'models'>): void {
  loadRequests.set(token, Date.now());
  client.load(plan.recipe, plan.models).catch(() => {
    // A 409 (busy), a cut tunnel, a 422 the status will also report: all are
    // read from the status on the next tick.
  });
}

// ---------------------------------------------------------------- polling

export type SdcppTick =
  | { state: 'unreachable' }
  | { state: 'loading'; label: string }
  | { state: 'queued'; position: number }
  | { state: 'running'; step: number | null; totalSteps: number | null; previewUrl: string | null }
  | { state: 'submitted'; promptId: string }
  | { state: 'failed'; message: string }
  | { state: 'completed'; assets: Asset[] };

/**
 * One look at an in-flight sd.cpp job. Pure with respect to the job row: the
 * caller applies the outcome (status, progress, events).
 */
export async function pollSdcpp(row: JobRow, baseUrl: string, backendName: string, dispatchedAt: number): Promise<SdcppTick> {
  const spec = (row as JobRow & { resolved?: SdcppResolved | null }).resolved?.sdcpp;
  const promptId = row.comfy_prompt_id!;
  const client = new SdcppClient(baseUrl);

  if (promptId.startsWith(LOAD_PREFIX)) {
    if (!spec) return { state: 'failed', message: 'This job has no record of what to load. Please run it again.' };
    let status;
    try {
      status = await client.modelStatus();
    } catch {
      return { state: 'unreachable' };
    }
    if (holdsPlan(status, spec)) {
      try {
        const id = await submit(client, backendName, spec);
        loadRequests.delete(promptId);
        return { state: 'submitted', promptId: id };
      } catch (err) {
        if (err instanceof DispatchError && !err.retryable) return { state: 'failed', message: err.message };
        return { state: 'unreachable' };
      }
    }
    if (status.state === 'error' && status.error) {
      loadRequests.delete(promptId);
      return { state: 'failed', message: `${backendName} could not load ${spec.modelLabel}: ${status.error}` };
    }
    if (Date.now() - dispatchedAt > LOAD_TIMEOUT_MS) {
      loadRequests.delete(promptId);
      return { state: 'failed', message: `${backendName} did not finish loading ${spec.modelLabel} in time.` };
    }
    // Idle with the wrong model, or nothing at all: ask again, but not every
    // second — a load request that is still being served answers 409.
    if (status.state !== 'loading') {
      const asked = loadRequests.get(promptId) ?? 0;
      if (Date.now() - asked > RELOAD_EVERY_MS) requestLoad(client, promptId, spec);
    }
    return { state: 'loading', label: `Loading ${spec.modelLabel} on ${backendName}` };
  }

  let job: SdcppJob;
  try {
    job = await client.job(promptId);
  } catch (err) {
    if (err instanceof SdcppError && (err.status === 404 || err.status === 410)) {
      return { state: 'failed', message: 'The backend has no record of this job. It was most likely restarted.' };
    }
    return { state: 'unreachable' };
  }

  switch (job.status) {
    case 'queued':
      return { state: 'queued', position: job.queue_position };
    case 'generating': {
      const preview = job.preview ?? null;
      return {
        state: 'running',
        step: preview?.step ?? null,
        totalSteps: preview?.total_steps ?? null,
        previewUrl: preview?.b64_json ? `data:image/png;base64,${preview.b64_json}` : null,
      };
    }
    case 'failed':
      return { state: 'failed', message: job.error?.message ? `${backendName}: ${job.error.message}` : 'The backend reported the job failed.' };
    case 'cancelled':
      return { state: 'failed', message: 'The backend cancelled the job.' };
    case 'completed':
      return { state: 'completed', assets: await persistResult(row, job) };
    default:
      return { state: 'unreachable' };
  }
}

/**
 * The result is in the poll body as base64, so storing it is decode and
 * persist. `persistOutput` is idempotent on (jobId, filename), which makes a
 * tick that stores half a batch and then fails safe to repeat.
 */
async function persistResult(row: JobRow, job: SdcppJob): Promise<Asset[]> {
  const result = job.result;
  if (!result) throw new Error('completed without a result');
  const assets: Asset[] = [];
  if (isVideoResult(result)) {
    const spec = (row as JobRow & { resolved?: SdcppResolved | null }).resolved?.sdcpp;
    const fps = result.fps || spec?.fps || 16;
    assets.push(
      await persistOutput({
        userId: row.user_id,
        jobId: row.id,
        source: { filename: `${row.id}.${result.output_format || 'webp'}`, type: 'output' },
        bytes: Buffer.from(result.b64_json, 'base64'),
        kind: 'video',
        duration: result.frame_count ? result.frame_count / fps : null,
        visibility: row.params.visibility,
      }),
    );
    return assets;
  }
  for (const image of result.images) {
    assets.push(
      await persistOutput({
        userId: row.user_id,
        jobId: row.id,
        source: { filename: `${row.id}-${image.index}.${result.output_format || 'png'}`, type: 'output' },
        bytes: Buffer.from(image.b64_json, 'base64'),
        kind: 'image',
        visibility: row.params.visibility,
      }),
    );
  }
  return assets;
}

/** Ask an sd.cpp backend to drop a job. A load token has nothing to cancel. */
export async function cancelSdcpp(baseUrl: string, promptId: string): Promise<void> {
  if (promptId.startsWith(LOAD_PREFIX)) {
    loadRequests.delete(promptId);
    return;
  }
  await new SdcppClient(baseUrl).cancel(promptId).catch(() => {});
}

/** For the progress label: what a tick says while waiting in sd-server's queue. */
export function queuedLabel(position: number, backendName: string): string {
  return position > 0 ? `Waiting behind ${position} on ${backendName}` : `Starting on ${backendName}`;
}

export type { Uuid };
