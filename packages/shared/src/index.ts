/**
 * Types shared between the API and the web app.
 *
 * The web app never sees a ComfyUI node graph. It sees a *capability* (what the
 * user is trying to do) and a *manifest* (which knobs that capability exposes).
 * The API turns those into a real graph. Adding a model family means adding a
 * template + manifest on the server; nothing here has to change.
 */

export type Uuid = string;

// ---------------------------------------------------------------- users

export interface User {
  id: Uuid;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  createdAt: string;
}

// ---------------------------------------------------------------- backends

export type BackendStatus = 'online' | 'offline' | 'unknown';

export interface Backend {
  id: Uuid;
  name: string;
  baseUrl: string;
  enabled: boolean;
  status: BackendStatus;
  /** e.g. "cuda:0 AMD Radeon(TM) Graphics : native" */
  deviceName: string | null;
  /**
   * Memory the backend *reports*, in bytes. This is a usable budget, not the
   * card's physical size: ROCm with DynamicVRAM and unified-memory systems pool
   * host RAM into the figure, so a 16 GB card can report 36 GB. No field in
   * ComfyUI's API distinguishes the two, so never label this "VRAM installed" —
   * show it as reported, and prefer `vramLimitMb` when an operator has set one.
   */
  vramFree: number | null;
  vramTotal: number | null;
  /** Host memory, for context alongside the above. */
  ramFree: number | null;
  ramTotal: number | null;
  /** Admin override in MB, when the reported figure is misleading. */
  vramLimitMb: number | null;
  lastSeenAt: string | null;
  /** How many of our jobs this backend is currently running or holding. */
  queueDepth: number;
}

// ---------------------------------------------------------------- models

export type ModelType =
  | 'checkpoint'
  | 'lora'
  | 'vae'
  | 'controlnet'
  | 'upscaler'
  | 'clip'
  | 'video';

export interface Model {
  id: Uuid;
  type: ModelType;
  /** The filename ComfyUI knows it by, e.g. "flux1-dev.safetensors". */
  filename: string;
  /** Human name, from the source registry when we have one. */
  displayName: string;
  /** Base family this is compatible with, e.g. "flux.1", "sdxl". */
  baseModel: string | null;
  previewUrl: string | null;
  sizeBytes: number | null;
  source: 'local' | 'civitai' | 'huggingface';
  sourceRef: string | null;
  /** Backends that actually have this file on disk. */
  backendIds: Uuid[];
}

// ---------------------------------------------------------------- jobs

export type JobKind = 'txt2img' | 'img2img' | 'txt2vid' | 'img2vid' | 'upscale';

export type JobStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'uploading'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface JobProgress {
  /** Current diffusion step, when the backend is reporting them. */
  step: number | null;
  totalSteps: number | null;
  /** For video: frames rendered so far. */
  frame: number | null;
  totalFrames: number | null;
  /** 0..1, our best single number for a progress bar. */
  fraction: number;
  /** Seconds remaining, estimated from observed step rate. */
  etaSeconds: number | null;
  /** Data URL of the latest live preview frame, when the backend sends one. */
  previewUrl: string | null;
  /**
   * Which part of the run this is, when the backend reports it.
   *
   * Added by API_CONTRACT.md "Progress detail". Optional and additive: a
   * client must tolerate its absence, and must not treat `fraction` as
   * meaningful outside `sampling` — most of a run's wall clock is spent
   * loading weights and decoding the VAE, where there is no number to show.
   */
  phase?: JobPhase | null;
  /** Human text for the phase, e.g. "Loading SDXL", "Decoding image". */
  phaseLabel?: string | null;
}

/** The phases a job passes through; see API_CONTRACT.md, "Progress detail". */
export type JobPhase = 'queued' | 'preparing' | 'sampling' | 'decoding' | 'saving';

export interface Job {
  id: Uuid;
  userId: Uuid;
  kind: JobKind;
  status: JobStatus;
  /** Position in our queue while status is 'queued'. 0 = next. */
  queuePosition: number | null;
  params: GenerationParams;
  backendId: Uuid | null;
  progress: JobProgress;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  assets: Asset[];
}

// ---------------------------------------------------------------- assets

export interface Asset {
  id: Uuid;
  jobId: Uuid;
  kind: 'image' | 'video';
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  /** Seconds, video only. */
  duration: number | null;
  starred: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------- generation

export type QualityPreset = 'fast' | 'balanced' | 'high';

export type AspectRatio = '1:1' | '3:2' | '2:3' | '16:9' | '9:16';

export interface LoraSelection {
  modelId: Uuid;
  weight: number;
}

/**
 * Where an input image comes from. The two cases are deliberately equal
 * citizens: anything you can do with a file you just dropped, you can do with
 * something already in your library, and vice versa.
 */
export type ImageSource =
  | { from: 'asset'; assetId: Uuid }
  | { from: 'upload'; uploadId: Uuid };

/**
 * What an input image is *for*. `init` is the classic img2img starting point;
 * the others condition the result without being the canvas. Which roles are
 * actually offered depends on the selected model's manifest — a family with no
 * IP-Adapter or ControlNet templates only offers `init`.
 */
export type ReferenceRole =
  | 'init'
  | 'style'
  | 'composition'
  | 'face'
  | 'depth'
  | 'pose';

export interface ImageReference {
  source: ImageSource;
  role: ReferenceRole;
  /** 0..1. For `init` this is denoise strength; for the rest, conditioning weight. */
  influence: number;
}

/** A file the user dropped, before it belongs to any job. */
export interface Upload {
  id: Uuid;
  userId: Uuid;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  mimeType: string;
  createdAt: string;
}

/**
 * Everything the Create screen can send. The preset fields are what the UI
 * shows by default; the `advanced` block is the collapsible drawer, and every
 * field in it is optional — omitted means "let the quality preset decide".
 */
export interface GenerationParams {
  kind: JobKind;
  prompt: string;
  negativePrompt?: string;
  modelId: Uuid;
  quality: QualityPreset;
  aspect: AspectRatio;
  batchSize: number;
  loras?: LoraSelection[];
  /**
   * Input images. Empty for pure txt2img. At most one `init` reference; the
   * conditioning roles may repeat if the model's manifest allows it.
   */
  references?: ImageReference[];
  advanced?: AdvancedParams;
  video?: VideoParams;
}

export interface AdvancedParams {
  steps?: number;
  guidance?: number;
  sampler?: string;
  scheduler?: string;
  /** Omit or null for a fresh random seed. */
  seed?: number | null;
  seedLocked?: boolean;
}

export interface VideoParams {
  /** Seconds of finished video. */
  lengthSeconds: number;
  fps: number;
  /** Backend-specific motion amount, 0..255 for SVD-style models. */
  motion: number;
  cameraPreset?: 'static' | 'push-in' | 'orbit' | 'pan-left' | 'crane-up';
  /**
   * The frame the video starts from — an existing generation or a file the user
   * just dropped. Required for img2vid, omitted for txt2vid.
   */
  firstFrame?: ImageSource;
  /**
   * Optional target frame. Models that support keyframe interpolation animate
   * from `firstFrame` to this; the UI only offers it when the manifest says so.
   */
  lastFrame?: ImageSource;
}

// ---------------------------------------------------------------- realtime

/** Frames pushed over the job WebSocket. Always scoped to one user. */
export type JobEvent =
  | { type: 'job.created'; job: Job }
  | { type: 'job.status'; jobId: Uuid; status: JobStatus; queuePosition: number | null }
  | { type: 'job.progress'; jobId: Uuid; progress: JobProgress }
  | { type: 'job.complete'; jobId: Uuid; assets: Asset[] }
  | { type: 'job.failed'; jobId: Uuid; error: string }
  | { type: 'backend.status'; backend: Backend };

// ---------------------------------------------------------------- api envelope

export interface ApiError {
  error: string;
  message: string;
}

// ---------------------------------------------------------------- model installs

/**
 * One model a backend could install, as offered by that backend's catalogue.
 *
 * This is deliberately per-backend rather than global: what can be installed
 * depends on what the backend's transport will accept. ComfyUI-Manager, for
 * one, refuses any download that is not on its own whitelist, so the honest
 * answer to "what can I install here" comes from the backend itself.
 */
export interface ModelCatalogEntry {
  /** Stable within one backend's catalogue; not a database id. */
  ref: string;
  name: string;
  filename: string;
  type: ModelType;
  /** Family, as the catalogue spells it, e.g. "SDXL". */
  base: string;
  description: string | null;
  /** Human size string from the catalogue, e.g. "6.94GB". Not always present. */
  size: string | null;
  /** Where the bytes come from; shown so an operator can see what they are pulling. */
  url: string;
  /** True when this backend already has the file on disk. */
  installed: boolean;
}

export type ModelInstallStatus =
  | 'queued'
  | 'downloading'
  | 'complete'
  | 'failed'
  | 'cancelled';

/**
 * A request to put a model onto a backend.
 *
 * Progress is coarse on purpose. The only transport we have reports per-task
 * state rather than bytes transferred, so there is no honest percentage to show
 * for a multi-gigabyte download — see `ModelInstall.detail`, which carries what
 * the transport actually told us instead of a fabricated number.
 */
export interface ModelInstall {
  id: Uuid;
  backendId: Uuid;
  /** Who asked for it. Installs are admin-only, but we still record who. */
  requestedBy: Uuid;
  filename: string;
  displayName: string;
  type: ModelType;
  base: string;
  url: string;
  status: ModelInstallStatus;
  /** What the transport last said, verbatim-ish. Null while queued. */
  detail: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
