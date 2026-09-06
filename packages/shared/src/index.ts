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

/**
 * Which part of a generation is happening right now.
 *
 * A generation spends most of its wall clock outside sampling — loading
 * weights (minutes on a cold model), then sampling, then a VAE decode that on
 * some hardware runs on the CPU, then our own download and thumbnail. Reporting
 * only sampler steps leaves a bar at 0% and then at 100% for long stretches,
 * which reads as a hang; the phase is what makes those stretches explicable.
 */
export type JobPhase = 'queued' | 'preparing' | 'sampling' | 'decoding' | 'saving';

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
   * Optional, and additive: older clients and older stored rows simply have no
   * phase. `fraction` remains 0..1 within *sampling* and means nothing outside
   * it, so a client that sees a phase other than 'sampling' should show an
   * indeterminate bar rather than a number.
   */
  phase?: JobPhase | null;
  /**
   * Human sentence for the phase — "Loading SDXL", "Decoding image",
   * "Storing 1 of 2". Deliberately not a restatement of `phase`: it is the
   * only place the user learns *what* is being loaded or stored.
   */
  phaseLabel?: string | null;
}

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

// ---------------------------------------------------------------- model catalogue

/**
 * What we could find out about a catalogue entry from the place it comes from.
 *
 * ComfyUI-Manager's list gives a filename, a size and a sentence. That is not
 * enough to choose between 145 checkpoints, so the API resolves each entry's
 * `reference` — a HuggingFace or Civitai *model page* — against that site's
 * public API and caches the answer. Every field here is therefore third-party
 * and every one of them is nullable: most entries get some of this, plenty get
 * none of it, and a UI that assumes otherwise will render holes.
 *
 * `previewUrl` is **our own** URL, never the third party's. The bytes are
 * fetched, downscaled and stored server-side; the browser must never be asked
 * to fetch a picture from huggingface.co on behalf of 372 tiles.
 */
export interface ModelCatalogInfo {
  /** `/api/model-previews/<id>` on this API, or null when we found no image. */
  previewUrl: string | null;
  /**
   * Where that picture came from, as a human string ("huggingface.co/x/y").
   * Shown, not linked: provenance for an image we chose out of a repo.
   */
  previewFrom: string | null;
  /**
   * Set when the picture is of the model this one is *derived from* — a GGUF
   * quantisation showing the original's sample, say. Names that model, so the
   * card can say so rather than implying the file itself was rendered here.
   */
  previewBorrowedFrom: string | null;
  /** SPDX-ish licence id as the source states it, e.g. "apache-2.0". */
  license: string | null;
  /** Lifetime downloads at the source. A crude but real popularity signal. */
  downloads: number | null;
  likes: number | null;
  /** The source's own task tag, e.g. "text-to-image". */
  pipelineTag: string | null;
  /** The model page this came from, for a "read more" link. */
  referenceUrl: string | null;
}

/**
 * Whether a model will actually run here — answered *before* a 7 GB download.
 *
 * The gap this closes: the catalogue happily offers files this studio has no
 * workflow for, files that need a companion model the backend does not have,
 * and files that install into a folder the workflow's loader cannot read. All
 * three look identical on a card until the job fails.
 *
 *   ready             a hand-authored workflow exists and the backend can load
 *                     everything it names
 *   generic           it will run, but on the generic Stable-Diffusion graph
 *                     rather than one authored for this family
 *   needs-companion   the workflow exists; the backend is missing something
 *                     else it needs — a companion model file (`missing` names
 *                     them) or a custom node (`detail` names it)
 *   wrong-folder      the file installs somewhere the workflow's loader does
 *                     not read — the LTX-Video case
 *   no-workflow       no template for this kind of model yet
 *   support           not a thing that runs on its own: a VAE, LoRA, CLIP,
 *                     ControlNet or upscaler that a workflow *uses*
 *   unknown           the backend could not be asked (offline, /object_info
 *                     unreadable). Never a refusal — see the fail-open rule.
 */
export type RunnabilityStatus =
  | 'ready'
  | 'generic'
  | 'needs-companion'
  | 'wrong-folder'
  | 'no-workflow'
  | 'support'
  | 'unknown';

export interface MissingCompanion {
  filename: string;
  /** "T5 text encoder", "VAE" — what it is for, when we can name it. */
  purpose: string | null;
  /** The loader node that would look for it, e.g. "CLIPLoader". */
  loader: string;
}

export interface ModelRunnability {
  status: RunnabilityStatus;
  /** Our canonical family spelling, e.g. "sdxl", or null if we could not tell. */
  family: string | null;
  /** What this model could be used for, if it runs. */
  capabilities: JobKind[];
  /** One sentence, written to be rendered verbatim. */
  summary: string;
  /** A second sentence with the specifics, when there are any. */
  detail: string | null;
  missing: MissingCompanion[];
  /** The backend this verdict is about; a verdict is never global. */
  backendId: Uuid | null;
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
  /**
   * The model *page* this file belongs to, as the catalogue states it — almost
   * always a HuggingFace repo, occasionally Civitai or GitHub. Distinct from
   * `url`, which is the weights themselves, and the key to everything in
   * `info`: a page has a description, a licence and pictures; a .safetensors
   * has none of those.
   */
  reference: string | null;
  /**
   * Where the file lands on the backend, as the catalogue states it, e.g.
   * "diffusion_models/FLUX1". Its first segment is the ComfyUI model folder,
   * which is what decides whether a given loader node will ever see the file —
   * see `runnability`.
   */
  savePath: string;
  /** True when this backend already has the file on disk. */
  installed: boolean;
  /** Resolved from `reference` and cached server-side. Null until it is. */
  info: ModelCatalogInfo | null;
  /** Whether this would run on the backend that offered it. */
  runnability: ModelRunnability | null;
}

// ---------------------------------------------------------------- readiness

/**
 * Whether one thing a workflow needs is actually usable on a backend.
 *
 * The three states are not a severity scale, they are three *different repairs*:
 *
 *  - `satisfied`  — nothing to do.
 *  - `missing`    — the backend does not have the file. We can fix this: hand
 *                   the user a list of catalogue entries and an install button.
 *  - `misfiled`   — the backend has the file, in a folder the loader that needs
 *                   it does not read. **We cannot fix this from here.** ComfyUI
 *                   exposes no API that moves a file, and ComfyUI-Manager's
 *                   installer is the only writer we have — and it will refuse
 *                   to re-fetch a file it already believes is installed. So the
 *                   only honest answer is an instruction for a human, which is
 *                   what `MisfiledModel` carries.
 */
export type RequirementStatus = 'satisfied' | 'missing' | 'misfiled';

/**
 * A file the backend has *somewhere* but not where the workflow's loader reads
 * from. This is the LTX-Video case on the reference machine, verbatim: the
 * weights are in `models/diffusion_models/`, only `UNETLoader` can see them,
 * and `CheckpointLoaderSimple` — the loader that also yields the VAE inside
 * that same file — cannot.
 */
export interface MisfiledModel {
  /** As the backend reports it, subfolder included. */
  filename: string;
  /** ComfyUI folders that do list this file today, e.g. ["diffusion_models"]. */
  foundInFolders: string[];
  /** The folder the loader that needs it reads from, e.g. "checkpoints". */
  requiredFolder: string;
  /** The loader that cannot see it, e.g. "CheckpointLoaderSimple". */
  loaderClass: string;
  /**
   * The catalogue entry that claims to have installed it, when there is one.
   * Its presence is why re-installing will not help: ComfyUI-Manager matched
   * the filename somewhere, marked the entry installed, and now refuses to
   * download it again.
   */
  catalogueRef: string | null;
  /** Where the catalogue's own entry says the file belongs. */
  catalogueSavePath: string | null;
  /** One sentence naming the file, the folder it is in, and where to put it. */
  instruction: string;
}

/** One thing a workflow needs, and whether this backend can supply it. */
export interface ModelRequirementReport {
  /** Stable within a template. `checkpoint` is always the user's chosen model. */
  id: string;
  label: string;
  /** Why the workflow needs it, in plain words. */
  why: string;
  type: ModelType;
  /** The node class that loads it, and the input it reads. */
  loaderClass: string;
  loaderInput: string;
  status: RequirementStatus;
  /**
   * The filename that satisfies it. For a resolved companion model this is the
   * file the graph will actually name — which is frequently *not* the literal
   * the template ships with, and that is the point.
   */
  resolved: string | null;
  /** Everything the backend offers for that loader input. Empty means nothing. */
  available: string[];
  misfiled: MisfiledModel | null;
  /**
   * Catalogue entries that would close this gap, best first. Empty for a
   * non-admin (installs are an operator action) and for a backend with no
   * install transport; `BackendReadiness.catalogueError` says which.
   */
  offers: ModelCatalogEntry[];
}

/**
 * What a given model + capability needs on a given backend, what is there, what
 * is not, and what would fix it.
 *
 * Answered per backend rather than globally because every part of it is a
 * property of one machine: which files it has, which folders they are in, and
 * which catalogue its transport offers.
 */
export interface BackendReadiness {
  backendId: Uuid;
  backendName: string;
  templateId: string;
  templateLabel: string;
  capability: JobKind;
  /** True when the graph is a generic best guess rather than authored. */
  isFallback: boolean;
  /** Null when readiness was asked about a template rather than a model. */
  modelId: Uuid | null;
  modelLabel: string | null;
  /** True only when every requirement is satisfied and no node class is absent. */
  ready: boolean;
  requirements: ModelRequirementReport[];
  /** Custom nodes the backend has never heard of. No download here fixes these. */
  missingNodeClasses: string[];
  /**
   * The *recommended* download for each `missing` gap — one entry per gap, best
   * first, and exactly what `POST /backends/:id/readiness/install` queues when
   * it is given no `refs`. This is the "fix it for me" list, so it is short on
   * purpose: the alternatives live on each requirement's `offers`, and asking
   * for one of those is a deliberate act with an explicit ref.
   *
   * A `misfiled` gap contributes nothing here. Downloading a different build of
   * the model the user picked is not the repair; moving the file is, and that
   * is in `manualSteps`.
   */
  installable: ModelCatalogEntry[];
  /**
   * Things only a person at the backend's keyboard can do: move a misfiled
   * file, install a custom node. Each is one actionable sentence.
   */
  manualSteps: string[];
  /** Why `offers` is empty, when it is: no Manager, no permission, a 502. */
  catalogueError: string | null;
}

/** The result of asking a backend to close its gaps. */
export interface ReadinessInstallResult {
  /** Installs queued by this call, plus any already in flight it found. */
  installs: ModelInstall[];
  /** Gaps this call could not queue, each with the reason in plain words. */
  skipped: { ref: string; filename: string; reason: string }[];
  /** Carried through so a UI can re-render the gap list from one response. */
  manualSteps: string[];
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

// ---------------------------------------------------------------- queue

/**
 * A job as the shared queue shows it.
 *
 * Identical to `Job` except that `params` can be withheld. There is one GPU and
 * several people, so the queue is visible to everyone — but only its owner (and
 * an admin) may read what somebody typed into it. `null` is that withholding,
 * made explicit in the type rather than left as a field that mysteriously
 * disappears: a client can tell "not allowed to see this" from "empty".
 */
export type QueueJob = Omit<Job, 'params'> & { params: GenerationParams | null };

/** A `Job` plus who owns it and where it sits. */
export interface QueueEntry {
  job: QueueJob;
  /**
   * Global place in the queue, 1 = next to be dispatched. Deliberately not the
   * same number as `Job.queuePosition`, which is per-user and 0-based: one
   * answers "how busy is the machine", the other "how long until *mine*".
   */
  position: number;
  ownerName: string | null;
  ownerId: Uuid;
}

/**
 * What `GET /queue` returns. `running` is the job on the GPU right now, which
 * is not in `entries` — it is no longer waiting — and is null when the box is
 * idle. A job caught mid-dispatch appears in exactly one of the two.
 */
export interface QueueView {
  entries: QueueEntry[];
  running: QueueEntry | null;
}
