/**
 * A thin client for one stable-diffusion.cpp `sd-server`.
 *
 * Like ComfyUI it has no authentication of its own, so it is only ever reached
 * from this process — directly on the LAN or through the agent tunnel. Unlike
 * ComfyUI it has a native async job API (`/sdcpp/v1`): submit answers with a
 * job id, the job is polled, and the result comes back as bytes in the poll
 * body. There is no socket and no `/history`, which is why the orchestrator's
 * sd.cpp path (`orchestrator/sdcpp.ts`) is a poll loop and nothing else.
 */

import type { ModelType, SdcppModelStatus } from '@comfy/shared';

export class SdcppError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SdcppError';
  }
}

/** One file sd-server found under a `--model-dir`, as `/model-files` lists it. */
export interface SdcppModelFile {
  /** Opaque, and the only thing a load request may name. */
  id: string;
  name: string;
  category: string;
  root: string;
  relative_path: string;
}

/** One recipe, trimmed to what the planner reads. */
export interface SdcppRecipe {
  id: string;
  name: string;
  slots: { id: string; category: string; categories?: string[]; required: boolean; label?: string }[];
  required_any?: string[][];
  defaults?: Record<string, unknown>;
}

export type SdcppJobStatus = 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';

export interface SdcppJob {
  id: string;
  kind: 'img_gen' | 'vid_gen' | string;
  status: SdcppJobStatus;
  created: number;
  started: number | null;
  completed: number | null;
  queue_position: number;
  preview?: { pass: number; step: number; total_steps: number; b64_json: string } | null;
  result?: SdcppImageResult | SdcppVideoResult | null;
  error?: { code?: string; message?: string } | null;
}

export interface SdcppImageResult {
  output_format: string;
  images: { index: number; b64_json: string }[];
}

export interface SdcppVideoResult {
  output_format: string;
  mime_type: string;
  fps: number;
  frame_count: number;
  b64_json: string;
}

export function isVideoResult(result: SdcppImageResult | SdcppVideoResult): result is SdcppVideoResult {
  return typeof (result as SdcppVideoResult).b64_json === 'string';
}

export class SdcppClient {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = 8000,
  ) {}

  private async call<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
      if (!res.ok) {
        const message = typeof payload?.error === 'string' ? payload.error : `${path} returned ${res.status}`;
        throw new SdcppError(message, res.status, payload?.code);
      }
      return payload as T;
    } catch (err) {
      if (err instanceof SdcppError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new SdcppError(`Could not reach ${this.baseUrl}${path}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Alive, and what it holds. The one call the poller treats as a heartbeat. */
  async modelStatus(): Promise<SdcppModelStatus> {
    const raw = await this.call<{
      state: SdcppModelStatus['state'];
      recipe: string | null;
      models: Record<string, string> | null;
      error: string | null;
      load_elapsed_seconds?: number | null;
    }>('/sdcpp/v1/models/status');
    return {
      state: raw.state,
      recipe: raw.recipe ?? null,
      models: raw.models ?? {},
      error: raw.error ?? null,
      loadElapsedSeconds: raw.load_elapsed_seconds ?? null,
    };
  }

  async modelFiles(): Promise<SdcppModelFile[]> {
    const raw = await this.call<{ files?: SdcppModelFile[] }>('/sdcpp/v1/model-files');
    return raw.files ?? [];
  }

  async recipes(): Promise<SdcppRecipe[]> {
    const raw = await this.call<{ recipes?: SdcppRecipe[] }>('/sdcpp/v1/recipes');
    return raw.recipes ?? [];
  }

  refresh(): Promise<void> {
    return this.call<void>('/sdcpp/v1/models/refresh', { method: 'POST' });
  }

  /**
   * Ask for a load. The HTTP request itself waits for completion, which can be
   * minutes for a 14B model off a spinning disk — longer than the tunnel will
   * hold a request open. Callers therefore treat this as fire-and-forget and
   * poll `modelStatus` for the outcome; see `orchestrator/sdcpp.ts`.
   */
  load(recipe: string, models: Record<string, string>): Promise<SdcppModelStatus> {
    return this.call('/sdcpp/v1/models/load', { method: 'POST', body: { recipe, models }, timeoutMs: 30 * 60_000 });
  }

  unload(): Promise<void> {
    return this.call<void>('/sdcpp/v1/models/unload', { method: 'POST', timeoutMs: 60_000 });
  }

  submit(kind: 'img_gen' | 'vid_gen', body: Record<string, unknown>): Promise<{ id: string }> {
    return this.call<{ id: string }>(`/sdcpp/v1/${kind}`, { method: 'POST', body, timeoutMs: 30_000 });
  }

  /** The poll. A finished image batch is a few megabytes of base64, hence the budget. */
  job(id: string): Promise<SdcppJob> {
    return this.call<SdcppJob>(`/sdcpp/v1/jobs/${encodeURIComponent(id)}`, { timeoutMs: 120_000 });
  }

  cancel(id: string): Promise<void> {
    return this.call<void>(`/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }
}

/**
 * sd-server's category folders onto rippel's model types.
 *
 * `diffusion_models` is a checkpoint here for the same reason `UNETLoader`
 * feeds `checkpoint` in `lib/comfy.ts`: rippel's catalogue has one row per
 * generative model regardless of whether the file is a whole checkpoint or
 * bare diffusion weights. The planner tells the two apart by folder when it
 * chooses a recipe slot.
 */
const CATEGORY_TYPES: Record<string, ModelType> = {
  checkpoints: 'checkpoint',
  diffusion_models: 'checkpoint',
  loras: 'lora',
  vae: 'vae',
  vae_approx: 'vae',
  text_encoders: 'clip',
  clip: 'clip',
  controlnet: 'controlnet',
  upscale_models: 'upscaler',
};

export interface DiscoveredSdcppModel {
  type: ModelType;
  /**
   * The filename rippel files the model under: the path below the category
   * folder, which is what ComfyUI reports for the same file (modulo slash
   * direction), so a machine that runs both engines gets one `models` row.
   */
  filename: string;
  /** The id sd-server wants back in a load request. */
  fileId: string;
  category: string;
}

export function discoverSdcppModels(files: SdcppModelFile[]): DiscoveredSdcppModel[] {
  const found = new Map<string, DiscoveredSdcppModel>();
  for (const file of files) {
    const type = CATEGORY_TYPES[file.category.toLowerCase()];
    if (!type) continue;
    const relative = file.relative_path.replace(/\\/g, '/');
    const filename = relative.replace(new RegExp(`^${file.category}/`, 'i'), '');
    if (!filename) continue;
    found.set(`${type}:${filename}`, { type, filename, fileId: file.id, category: file.category.toLowerCase() });
  }
  return [...found.values()];
}
