/**
 * Workflow template types.
 *
 * A *template* is a hand-authored ComfyUI graph plus a *manifest* that says
 * which of its node inputs the user is allowed to touch. Nothing else in the
 * product is allowed to know what a node is: the compiler takes
 * `GenerationParams` + a template and produces a concrete graph by writing
 * values at the JSON paths the manifest declares. That indirection is the whole
 * point — adding a model family is a new template + manifest on the server, and
 * the UI never changes.
 *
 * Everything here describes the **API format**, which is what `POST /prompt`
 * accepts. It is emphatically *not* the "workflow.json" a user exports from the
 * ComfyUI canvas: that one has `nodes` and `links` arrays and carries widget
 * values positionally. API format is a flat object keyed by node id where every
 * node names its inputs. Getting this wrong produces a graph ComfyUI rejects
 * with a bare 400, so the shape is asserted in the unit tests.
 */

import type { AspectRatio, JobKind, QualityPreset } from '@comfy/shared';

// ---------------------------------------------------------------- graph shape

/**
 * A reference to another node's output: `[nodeId, outputIndex]`. ComfyUI uses
 * this two-element tuple everywhere a node consumes a MODEL/CLIP/VAE/LATENT/
 * IMAGE/CONDITIONING socket rather than a literal widget value.
 */
export type NodeLink = readonly [nodeId: string, outputIndex: number];

/** A literal widget value: what the user types into a node on the canvas. */
export type WidgetValue = string | number | boolean;

export type NodeInputValue = WidgetValue | NodeLink;

export interface ComfyApiNode {
  /** The registered node class, e.g. "KSampler". Must exist on the backend. */
  readonly class_type: string;
  /** Widget values and socket links, keyed by the node's input names. */
  readonly inputs: Readonly<Record<string, NodeInputValue>>;
  /** Optional; ComfyUI only uses it for nicer error messages and UI titles. */
  readonly _meta?: { readonly title?: string };
}

/** The flat, node-id-keyed object that `POST /prompt` takes as `prompt`. */
export type ComfyApiGraph = Readonly<Record<string, ComfyApiNode>>;

// ------------------------------------------------------------ param bindings

/**
 * Which piece of the request (after preset and aspect-ratio resolution) feeds
 * an input. These are deliberately *semantic* names rather than raw paths into
 * `GenerationParams`, because several are derived rather than copied:
 * `width`/`height` come from the aspect-ratio table, `steps`/`guidance`/
 * `sampler`/`scheduler` come from the quality preset unless the Advanced drawer
 * overrode them, `checkpointFilename` is a database lookup from `modelId`, and
 * `seed` is generated when the user has not locked one.
 */
export type ParamSource =
  | 'prompt'
  | 'negativePrompt'
  | 'checkpointFilename'
  | 'width'
  | 'height'
  | 'batchSize'
  | 'steps'
  | 'guidance'
  | 'sampler'
  | 'scheduler'
  | 'seed'
  | 'denoise'
  | 'filenamePrefix'
  // ---------------------------------------------------------------- video
  /**
   * Frames per second of the finished clip. Bound in more than one place on
   * purpose: a video model conditions on the rate it is generating for, and the
   * encoder has to be told the same number or the file plays at the wrong speed
   * while every frame in it is correct. Two paths, one source.
   */
  | 'fps'
  /**
   * How many frames to sample. **Derived, not a field** — `VideoParams` carries
   * `lengthSeconds` and `fps` because that is what a person picks, and frames
   * are their product. Storing both would let them disagree.
   *
   * The product is then snapped to what the family can actually sample; see
   * `frameQuantum` on the manifest, and `videoFrameCount` in the compiler.
   */
  | 'frameCount'
  /**
   * `VideoParams.motion`, verbatim. Deliberately *not* normalised to 0..1 here:
   * "motion amount" is a different knob on every family (SVD has a trained
   * motion bucket, LTX-Video has conditioning-image compression, WAN has
   * neither), so the number means whatever the manifest's constraint says it
   * means and the UI reads its slider bounds from there.
   */
  | 'motion'
  /**
   * `VideoParams.cameraPreset`. No template we ship binds it yet: LTX-Video
   * 0.9.1 has no camera-control input, and the families that do (WAN's
   * `WanCameraImageToVideo`, or LTX-2's camera LoRAs) need weights nobody has
   * installed. It is in the vocabulary so the first template that gains one is
   * a manifest change rather than a compiler change.
   */
  | 'cameraPreset';

/**
 * What a value must satisfy before we will write it into a graph. The API
 * validates against this at job-creation time so a bad request fails fast with
 * a useful message, instead of being dispatched and coming back as an opaque
 * ComfyUI traceback minutes later. The UI can read the same numbers to bound
 * its sliders, which is why ranges live in the manifest and not in the compiler.
 */
export type ParamConstraint =
  | { readonly kind: 'int'; readonly min: number; readonly max: number; readonly step?: number }
  | { readonly kind: 'float'; readonly min: number; readonly max: number }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'string'; readonly maxLength: number }
  | { readonly kind: 'model'; readonly modelType: 'checkpoint' | 'lora' | 'vae' };

export interface ManifestInput {
  /**
   * Dot path into the graph, always of the form `<nodeId>.inputs.<inputName>`.
   * The compiler writes here; the tests assert every one of these resolves to
   * an input that actually exists on a node in the template's graph, so a typo
   * or a renamed node fails at `npm test` rather than in production.
   */
  readonly path: string;
  /** Where the value comes from. */
  readonly source: ParamSource;
  /** Short human label, used by the Advanced drawer and by error messages. */
  readonly label: string;
  /** Omitted for free-form values that cannot be bounded (the prompt text). */
  readonly constraint?: ParamConstraint;
  /**
   * True when the compiler must have a value for this input. Optional inputs
   * keep whatever literal the hand-authored graph already carries, which is how
   * the graph doubles as its own set of last-resort defaults.
   */
  readonly required: boolean;
}

// ---------------------------------------------------------------- manifest


/**
 * Where LoRA loaders get spliced into this graph.
 *
 * The manifest names only the *anchor* — the node whose MODEL and CLIP outputs
 * everything downstream currently consumes, normally the checkpoint loader —
 * and the compiler rewires that node's consumers onto the end of the chain it
 * builds. Enumerating the consumers here instead would mean editing the
 * manifest every time the graph gains a node, and getting it wrong produces a
 * graph that runs happily while silently ignoring every LoRA.
 */
export interface LoraChainSpec {
  readonly anchorNodeId: string;
  /** Output slots on the anchor. CheckpointLoaderSimple: MODEL 0, CLIP 1. */
  readonly modelSlot: number;
  readonly clipSlot: number;
  /** Defaults to "LoraLoader". */
  readonly nodeClass?: string;
  /** Past a handful the results turn to mud and VRAM runs out. */
  readonly maxLoras?: number;
}

export interface WorkflowManifest {
  /** Stable id, recorded on jobs so an old job can be re-run byte-identically. */
  readonly id: string;
  /** Bumped whenever the graph changes shape; old jobs keep their old version. */
  readonly version: number;
  readonly label: string;
  /** The capability this template implements. */
  readonly capability: JobKind;
  /**
   * Base model families this graph is valid for, matched case-insensitively
   * against `Model.baseModel`. SD 1.5 shares the SDXL node set but not its
   * resolution buckets, so it gets its own template rather than being listed
   * here — the registry key is (capability, baseModel) for exactly that reason.
   */
  readonly baseModels: readonly string[];
  /**
   * Node classes the backend must have registered for this graph to run. The
   * orchestrator can check this against the backend's `/object_info` before
   * dispatching, so a missing custom node is a clear error rather than a 400.
   */
  readonly requiredNodeClasses: readonly string[];
  /** Which node produces the artifacts, so the orchestrator knows where to look. */
  readonly outputNodeId: string;
  /** Every user-facing input, each with its path into the graph. */
  readonly inputs: readonly ManifestInput[];
  /**
   * Aspect ratio -> pixels, and quality preset -> sampler settings. These live
   * on the manifest rather than as one global table because they are properties
   * of the model family: SDXL wants ~1024 on the long edge and SD 1.5 wants
   * ~512, and a video model wants neither.
   */
  readonly resolutions: ResolutionTable;
  readonly quality: PresetTable;
  /**
   * Frame counts this family can sample, expressed as the quantum in
   * `frameQuantum * n + 1`. Omitted by image templates and by video families
   * that accept any length.
   *
   * The leading `+ 1` is not a fudge: latent-video models encode one key frame
   * and then groups of N, so LTX-Video accepts 8n+1 (9, 17, …, 97) and WAN
   * accepts 4n+1. Asking for 100 frames is not rejected by ComfyUI — the latent
   * node silently rounds — and the clip that comes back is then a different
   * length from the one we recorded on the job and showed the user. Snapping
   * here means the number in the library is the number of frames in the file.
   */
  readonly frameQuantum?: number;
  /** Omitted by templates that cannot take LoRAs; requesting one is then an error. */
  readonly lora?: LoraChainSpec;
}

export interface WorkflowTemplate {
  readonly manifest: WorkflowManifest;
  /**
   * The pristine graph. Never mutated: the compiler deep-clones before writing,
   * so one template object is safe to share across concurrent jobs.
   */
  readonly graph: ComfyApiGraph;
}

// ------------------------------------------------------- resolution & presets

export interface Resolution {
  readonly width: number;
  readonly height: number;
}

export interface PresetDefaults {
  readonly steps: number;
  readonly cfg: number;
  readonly sampler: string;
  readonly scheduler: string;
}

/**
 * Both tables are keyed by the full enum, not `Partial<>`. That is load-bearing:
 * adding a member to `AspectRatio` or `QualityPreset` in the shared package must
 * break the build here rather than silently fall through to a default at
 * runtime. The unit tests assert completeness too, for the same reason.
 */
export type ResolutionTable = Readonly<Record<AspectRatio, Resolution>>;
export type PresetTable = Readonly<Record<QualityPreset, PresetDefaults>>;
