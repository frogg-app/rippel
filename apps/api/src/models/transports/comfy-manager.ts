/**
 * ModelTransport backed by ComfyUI-Manager.
 *
 * Manager is a custom node that adds its own routes to the ComfyUI server, so
 * it lives at the same origin and port. The endpoints used here, all verified
 * against Manager's source at commit f82970b (2026-09-04):
 *
 *   GET  /manager/queue/status          -> {total_count, done_count, in_progress_count, is_processing}
 *   GET  /externalmodel/getlist?mode=   -> {models: [...]} with an `installed` flag per entry
 *   POST /manager/queue/install_model   -> 200 accepted, 400 not whitelisted, 403 security
 *   POST /manager/queue/start           -> 200 started, 201 already running
 *
 * Two behaviours of Manager's shape the design here:
 *
 *  1. **Installs are whitelisted.** `install_model` matches the request against
 *     Manager's own model-list.json on (save_path, base, filename) and rejects
 *     anything absent with a 400. We therefore install only entries we read
 *     back out of its catalogue, which makes a rejection a bug rather than a
 *     thing an operator can trip over.
 *  2. **Progress is per-task, not per-byte.** The queue reports how many tasks
 *     are done, so a single 7 GB checkpoint is one task that is either running
 *     or finished. There is no honest percentage to report, and this driver
 *     does not invent one.
 */

import type { ModelCatalogEntry, ModelType } from '@comfy/shared';
import type { InstallProgress, InstallRequest, ModelTransport } from '../transport.js';
import { TransportError } from '../transport.js';

/** Manager's queue counters. */
interface QueueStatus {
  total_count: number;
  done_count: number;
  in_progress_count: number;
  is_processing: boolean;
}

interface RawCatalogueEntry {
  name?: string;
  type?: string;
  base?: string;
  save_path?: string;
  description?: string;
  filename?: string;
  url?: string;
  /** The model *page*: a HuggingFace repo, a Civitai model, a GitHub project. */
  reference?: string;
  size?: string;
  installed?: string | boolean;
}

/**
 * Manager's catalogue `type` words mapped onto ours. Anything unrecognised is
 * skipped rather than guessed at: offering to install a file into a category
 * our job scheduler would then misuse is worse than not offering it.
 */
const TYPE_MAP: Record<string, ModelType> = {
  checkpoints: 'checkpoint',
  checkpoint: 'checkpoint',
  lora: 'lora',
  loras: 'lora',
  vae: 'vae',
  controlnet: 'controlnet',
  upscale: 'upscaler',
  clip: 'clip',
  unet: 'checkpoint',
  diffusion_model: 'checkpoint',
};

export class ComfyManagerTransport implements ModelTransport {
  readonly kind = 'comfyui-manager';

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async request(path: string, init?: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A network-level failure against a LAN box is usually transient.
      throw new TransportError(`Could not reach ${this.baseUrl}${path}: ${reason}`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Manager's routes simply do not exist on a stock ComfyUI, so a 404 here is
   * the difference between "Manager is not installed" and "the box is down".
   */
  async available(): Promise<boolean> {
    try {
      const res = await this.request('/manager/queue/status', undefined, 5_000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async catalogue(): Promise<ModelCatalogEntry[]> {
    // `mode=cache` uses Manager's local copy; it does not go to the network on
    // every call, which matters because the UI lists this on page load.
    const res = await this.request('/externalmodel/getlist?mode=cache');
    if (!res.ok) {
      throw new TransportError(`Model catalogue returned ${res.status}`, res.status >= 500);
    }

    const body = (await res.json()) as { models?: RawCatalogueEntry[] };
    const entries: ModelCatalogEntry[] = [];

    for (const raw of body.models ?? []) {
      const type = raw.type ? TYPE_MAP[raw.type.toLowerCase()] : undefined;
      if (!type || !raw.filename || !raw.url || !raw.base || raw.save_path === undefined) continue;

      entries.push({
        // save_path + filename is exactly the tuple Manager's whitelist matches
        // on, so using it as the ref means an install request we build from a
        // catalogue entry can never fail that check.
        ref: `${raw.save_path}/${raw.filename}`,
        name: raw.name ?? raw.filename,
        filename: raw.filename,
        type,
        base: raw.base,
        description: raw.description ?? null,
        size: raw.size ?? null,
        url: raw.url,
        // Manager states this for every entry in its list (562/562 on the live
        // box) and it is the only handle we have on anything a human wrote
        // about the model — see models/metadata.ts.
        reference: raw.reference ?? null,
        savePath: raw.save_path,
        // Manager reports this as the string "True"/"False" in some versions
        // and a boolean in others.
        installed: raw.installed === true || raw.installed === 'True',
        // Both are filled in by the route, which is where the cache and the
        // backend's /object_info live. A transport talks to one backend and
        // knows nothing about either.
        info: null,
        runnability: null,
      });
    }

    return entries;
  }

  async install(request: InstallRequest): Promise<void> {
    const res = await this.request('/manager/queue/install_model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: request.name,
        type: request.type,
        base: request.base,
        save_path: request.savePath,
        filename: request.filename,
        url: request.url,
        ui_id: request.filename,
      }),
    });

    if (res.status === 403) {
      throw new TransportError(
        'ComfyUI-Manager refused the install: its security level is set too high. ' +
          'It must be "normal" or lower for model installs to be permitted.',
      );
    }
    if (res.status === 400) {
      throw new TransportError(
        `ComfyUI-Manager does not recognise "${request.filename}" as an installable model. ` +
          'Only models on its own list can be installed.',
      );
    }
    if (!res.ok) {
      throw new TransportError(`Install request returned ${res.status}`, res.status >= 500);
    }

    // Queueing and starting are separate calls in Manager: install_model only
    // enqueues, and nothing downloads until the worker is started. 201 means a
    // worker is already running and will pick our task up, which is a success
    // for us, not a conflict.
    const started = await this.request('/manager/queue/start', { method: 'POST' });
    if (!started.ok && started.status !== 201) {
      throw new TransportError(`Could not start the install queue: ${started.status}`, true);
    }
  }

  /**
   * Manager's queue is global rather than per-task addressable — there is no
   * "how is *my* download going" endpoint — so this reports the queue's state
   * and leaves deciding whether *this* file arrived to the caller, which checks
   * ComfyUI's own model listing. That check is the one that matters anyway.
   */
  async progress(_request: InstallRequest): Promise<InstallProgress> {
    const res = await this.request('/manager/queue/status', undefined, 5_000);
    if (!res.ok) {
      throw new TransportError(`Queue status returned ${res.status}`, res.status >= 500);
    }

    const status = (await res.json()) as QueueStatus;

    if (status.is_processing || status.in_progress_count > 0) {
      return {
        state: 'downloading',
        detail:
          status.total_count > 1
            ? `Downloading (${status.done_count} of ${status.total_count} queued tasks done)`
            : 'Downloading',
      };
    }

    // An idle queue does not mean our file arrived — it may have failed, or the
    // worker may not have started yet. The caller corroborates against
    // /object_info before calling anything complete.
    return { state: 'queued', detail: 'Waiting for the backend to start the download' };
  }
}
