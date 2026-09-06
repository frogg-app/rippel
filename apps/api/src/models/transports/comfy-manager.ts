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
 *  2. **Manager's own progress is per-task, not per-byte.** The queue reports
 *     how many tasks are done, so a single 7 GB checkpoint is one task that is
 *     either running or finished. Nothing Manager exposes counts bytes: not
 *     `queue/status`, and not the `cm-queue-status` frame it pushes over
 *     ComfyUI's WebSocket, which carries only {status, target, ui_target,
 *     total_count, done_count}. This driver still does not invent a number
 *     from any of that.
 *
 *     The bytes come from somewhere else entirely - see `measureBytes` below.
 */

import type { ModelCatalogEntry, ModelType } from '@comfy/shared';
import type { InstallProgress, InstallRequest, ModelTransport } from '../transport.js';
import { TransportError } from '../transport.js';

/** One entry from ComfyUI's `/api/experiment/models/<folder>` listing. */
interface FolderFile {
  name: string;
  size?: number;
}

/** Long enough to coalesce concurrent installs, short enough to look live. */
const LISTING_TTL_MS = 1_500;

/** Last path segment, for either separator - the backend may be Windows. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

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

  /** Folder listings, briefly, keyed by ComfyUI folder name. */
  private readonly listings = new Map<string, { at: number; files: FolderFile[] | null }>();

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

  /**
   * How much of the file is on the backend's disk.
   *
   * Manager cannot tell us, but it does not have to. It downloads *in place* -
   * the default path is torchvision's `download_url`, which opens the final
   * destination and writes chunks straight into it, with no temp file and no
   * rename - so the target file exists from the first chunk and grows. And
   * ComfyUI core will happily stat its own model folders:
   * `GET /api/experiment/models/<folder>` walks the folder and returns
   * `{name, pathIndex, modified, created, size}` per file.
   *
   * That listing is not cached, despite appearances. `ModelFileManager` keeps a
   * cache dict, but its validity check compares `os.path.getmtime(folder)` (a
   * float) against the cache's *directory map* (a dict); the two are never
   * equal, so the check always misses and every request re-walks the tree and
   * re-stats every file. Verified against the live backend at 3 Hz while a
   * 327 MB LoRA downloaded: 0, 32768, 229376, 917504, ... 327309314.
   *
   * Returns null rather than 0 when the file is not listed at all, because a
   * download that has created its file but written nothing is legitimately at
   * zero and the two must not be confused.
   */
  async measureBytes(request: InstallRequest): Promise<number | null> {
    if (!request.folder) return null;

    let files: FolderFile[] | null;
    try {
      files = await this.folderListing(request.folder);
    } catch {
      // Progress is decoration; it must never turn a healthy install into a
      // failed one. An unreadable listing simply means "not measured".
      return null;
    }
    if (!files) return null;

    // Names come back relative to the model folder, so an entry saved under
    // "loras/ltxv/ltx2" is listed as "ltxv\ltx2\file.safetensors" on a
    // Windows backend. Match on the basename, for either separator.
    const target = basename(request.filename);
    const hit = files.find((f) => basename(f.name) === target);
    if (!hit || typeof hit.size !== 'number' || !Number.isFinite(hit.size)) return null;
    return Math.max(0, Math.trunc(hit.size));
  }

  /**
   * One folder listing, cached for a moment.
   *
   * Each call makes the backend walk a model tree and stat every file in it,
   * which on a machine with a few thousand models is not free - and the web
   * client polls every live install every three seconds. The TTL is short
   * enough that a progress bar still moves smoothly and long enough that four
   * concurrent installs into `loras` cost one walk rather than four.
   */
  private async folderListing(folder: string): Promise<FolderFile[] | null> {
    const cached = this.listings.get(folder);
    if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.files;

    const res = await this.request(
      `/api/experiment/models/${encodeURIComponent(folder)}`,
      undefined,
      10_000,
    );
    // 404 is the honest answer for a folder this backend does not have (a stock
    // install has no `xlabs/`), and older ComfyUI builds have no experiment
    // routes at all. Either way: no measurement, and not an error.
    if (!res.ok) {
      this.listings.set(folder, { at: Date.now(), files: null });
      return null;
    }

    const body = (await res.json()) as unknown;
    const files = Array.isArray(body)
      ? body.filter(
          (f): f is FolderFile =>
            typeof f === 'object' && f !== null && typeof (f as FolderFile).name === 'string',
        )
      : null;
    this.listings.set(folder, { at: Date.now(), files });
    return files;
  }

  /**
   * The exact size of the download, from a HEAD of its URL.
   *
   * Exact is the whole point. Manager's catalogue states a size too, but to
   * three significant figures - it calls a 327,309,314-byte LoRA "0.30GB",
   * which is 9% out. As prose that is fine; as the denominator of a percentage
   * it would leave the bar sitting at 100% with a tenth of the file still to
   * come. So the catalogue string is never used here, and a URL that will not
   * answer with a `Content-Length` yields null, which means the UI shows no
   * percentage at all.
   *
   * Redirects are followed because the interesting hosts use them: HuggingFace
   * answers the `/resolve/` URL with a 302 to a CDN, and only the final
   * response carries the real length.
   */
  async totalBytes(request: InstallRequest): Promise<number | null> {
    try {
      const res = await fetch(request.url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const raw = res.headers.get('content-length');
      if (!raw) return null;
      const size = Number(raw);
      return Number.isFinite(size) && size > 0 ? Math.trunc(size) : null;
    } catch {
      // No network, a host that refuses HEAD, a timeout: all mean "no exact
      // total", which the caller renders as no percentage rather than a guess.
      return null;
    }
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
  async progress(request: InstallRequest): Promise<InstallProgress> {
    const res = await this.request('/manager/queue/status', undefined, 5_000);
    if (!res.ok) {
      throw new TransportError(`Queue status returned ${res.status}`, res.status >= 500);
    }

    const status = (await res.json()) as QueueStatus;

    // Measured every tick regardless of what the queue claims, because the two
    // answers are independent and the bytes are the more trustworthy of them.
    // Manager's `in_progress_count` is a set it adds to before a task and
    // removes from after, with no `finally` — a worker thread that dies inside a
    // download leaks its entry and the count never returns to zero. (Seen on
    // the live backend: `in_progress_count: 1` for eight and a half hours after
    // a stalled fetch left a 15-byte file behind.) A file sitting at exactly its
    // `Content-Length` is the better evidence, and the caller uses it.
    const bytesReceived = await this.measureBytes(request);

    if (status.is_processing || status.in_progress_count > 0) {
      return {
        state: 'downloading',
        bytesReceived,
        detail:
          status.total_count > 1
            ? `Downloading (${status.done_count} of ${status.total_count} queued tasks done)`
            : 'Downloading',
      };
    }

    // An idle queue does not mean our file arrived — it may have failed, or the
    // worker may not have started yet. The caller corroborates against ComfyUI's
    // own model listing before calling anything complete.
    return {
      state: 'queued',
      bytesReceived,
      detail: 'Waiting for the backend to start the download',
    };
  }
}
