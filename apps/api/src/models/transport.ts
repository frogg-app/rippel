/**
 * Getting model files onto a backend.
 *
 * ComfyUI core has no way to download anything: `/api/models` is read-only and
 * answers 405 to a POST. So every route to putting a file on a backend's disk
 * is some *other* mechanism sitting alongside ComfyUI — an extension, a file
 * share, a companion agent — and which of those exists is a property of how
 * that particular machine was set up, not of ComfyUI.
 *
 * Hence a driver interface, in the same shape as the storage drivers: the
 * service layer asks a backend "can you install things, and if so what", and
 * never learns which mechanism answered.
 *
 * Two things every implementation must respect:
 *
 *  - Installing is **asynchronous and slow**. A checkpoint is several
 *    gigabytes; nothing here may block a request.
 *  - The transport's own idea of "done" is not authoritative. What matters is
 *    whether ComfyUI can *see* the file, which is a separate question answered
 *    by `/object_info`. A transport that says "success" for a file ComfyUI
 *    never lists has not installed anything useful.
 */

import type { ModelCatalogEntry } from '@comfy/shared';

export class TransportError extends Error {
  constructor(
    message: string,
    /** True when retrying might work: a timeout, a 5xx, a busy queue. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Raised when the backend has no install mechanism at all. */
export class TransportUnavailable extends TransportError {
  constructor(message: string) {
    super(message, false);
    this.name = 'TransportUnavailable';
  }
}

/**
 * What we hand a transport to install. It mirrors a catalogue entry rather than
 * being free-form: the only transport we have refuses anything not on its own
 * whitelist, so "install this arbitrary URL" is not a capability we can
 * honestly offer, and an interface that implied otherwise would be a lie.
 */
export interface InstallRequest {
  name: string;
  filename: string;
  /** The catalogue's own type word, e.g. "checkpoint". */
  type: string;
  base: string;
  savePath: string;
  url: string;
}

export type InstallState = 'queued' | 'downloading' | 'complete' | 'failed';

export interface InstallProgress {
  state: InstallState;
  /**
   * Whatever the transport actually said. Deliberately a string and not a
   * percentage: the ComfyUI-Manager transport reports per-task state, so any
   * number we produced for a 7 GB download would be invented.
   */
  detail: string | null;
  error?: string;
}

export interface ModelTransport {
  /** For logs and for telling an operator why installs are unavailable. */
  readonly kind: string;

  /** Cheap probe. False means this backend cannot install models at all. */
  available(): Promise<boolean>;

  /** What this backend is willing to install. */
  catalogue(): Promise<ModelCatalogEntry[]>;

  /** Enqueue a download. Returns as soon as the transport has accepted it. */
  install(request: InstallRequest): Promise<void>;

  /**
   * Coarse state of the transport's work queue. Callers must corroborate a
   * `complete` against ComfyUI's own model listing before trusting it.
   */
  progress(request: InstallRequest): Promise<InstallProgress>;
}
