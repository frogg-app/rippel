/**
 * "Will this actually run?" — answered before the download, not after it.
 *
 * The catalogue offers 372 files. This studio can generate with perhaps a third
 * of them, and nothing on a card said which third: an operator picked a name,
 * waited out seven gigabytes, and then found out. The information needed to
 * answer was already in the process, in three separate places:
 *
 *   1. `workflows/registry.ts` — `capabilityOffersFor(family)` knows whether we
 *      have a graph for that family at all, and whether it is hand-authored or
 *      the generic Stable-Diffusion fallback.
 *   2. `orchestrator/preflight.ts` — `checkGraph` knows how to ask a backend's
 *      `/object_info` whether every file a graph names is loadable there. Its
 *      cache is reused rather than duplicated.
 *   3. The catalogue entry itself — `base` states the family, and `save_path`
 *      states which ComfyUI folder the file will land in.
 *
 * (3) is the one that is easy to miss and is the LTX-Video case the user keeps
 * hitting. `diffusion_models/…` and `checkpoints/…` are different folders, and
 * ComfyUI's loaders read one each: a file installed into `diffusion_models` is
 * invisible to `CheckpointLoaderSimple` forever, no matter how correct it is.
 * Our LTX templates load with `CheckpointLoaderSimple`, so a Wan or FLUX
 * diffusion_model entry is *statically* unrunnable and can be marked so without
 * asking any backend anything.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CAN AND CANNOT PROMISE
 *
 * Can:
 *  - "No workflow for this kind of model" — certain. It is our own registry.
 *  - "Installs into a folder the workflow's loader cannot read" — certain for a
 *    catalogue entry, because the save path is part of the install request we
 *    would send.
 *  - "The backend cannot load <file> that this workflow also needs" — as
 *    certain as `/object_info` is, which is the same source ComfyUI validates
 *    against when it rejects a prompt. This is the check that catches the T5
 *    text encoder.
 *
 * Cannot:
 *  - Promise the output is any *good*. A generic workflow on an unfamiliar
 *    checkpoint runs; whether it looks right is not a thing an API can know.
 *  - Promise it fits in VRAM. Nothing here reads the file's size against the
 *    card, and a 14B video model that runs on an A100 will OOM on a 6900 XT.
 *  - Say anything about a LoRA, VAE or ControlNet beyond "this is a support
 *    file". Whether *this* LoRA suits *that* checkpoint is a question about
 *    training data, not about files on a disk.
 *  - Answer at all when the backend is unreachable: the verdict degrades to
 *    the static half and says so. It never refuses on a failed probe — the same
 *    fail-open rule preflight uses, for the same reason.
 */

import type {
  JobKind,
  MissingCompanion,
  ModelRunnability,
  ModelType,
  RunnabilityStatus,
  Uuid,
} from '@comfy/shared';
import type { ObjectInfo } from '../lib/comfy.js';
import { checkGraph } from '../orchestrator/preflight.js';
import type { ComfyApiGraph, WorkflowTemplate } from '../workflows/types.js';
import { capabilityOffersFor, findTemplateById } from '../workflows/registry.js';
import { inferFamily } from './family.js';
import { folderForType } from './installs.js';

/**
 * Which ComfyUI model folder each loader node reads.
 *
 * Straight out of ComfyUI's `folder_paths`: this is the mapping that decides
 * whether a file on disk is visible to a given node, and it is the whole basis
 * of the wrong-folder verdict. Anything not listed is left unchecked rather
 * than guessed at — an unknown loader produces no verdict, not a wrong one.
 */
const FOLDER_READ_BY: Record<string, string> = {
  CheckpointLoaderSimple: 'checkpoints',
  CheckpointLoader: 'checkpoints',
  ImageOnlyCheckpointLoader: 'checkpoints',
  UNETLoader: 'diffusion_models',
  LoraLoader: 'loras',
  LoraLoaderModelOnly: 'loras',
  VAELoader: 'vae',
  CLIPLoader: 'text_encoders',
  DualCLIPLoader: 'text_encoders',
  TripleCLIPLoader: 'text_encoders',
  ControlNetLoader: 'controlnet',
  DiffControlNetLoader: 'controlnet',
  UpscaleModelLoader: 'upscale_models',
  CLIPVisionLoader: 'clip_vision',
};

/**
 * The catalogue's save paths onto ComfyUI folder names.
 *
 * `save_path` is either "default" — meaning "wherever this type belongs" — or a
 * path whose *first segment* is the folder, e.g. "diffusion_models/FLUX1" or
 * "checkpoints/LTXV". Only the first segment matters: a subfolder is still
 * inside the folder the loader reads, and ComfyUI lists it as
 * `LTXV\ltx-video-2b-v0.9.1.safetensors`.
 */
export function folderForSavePath(savePath: string | null, type: ModelType): string | null {
  if (!savePath || savePath === 'default') return folderForType(type);
  const first = savePath.split(/[\\/]/)[0]?.trim();
  if (!first) return folderForType(type);
  // Manager's older rows use "unet" for what ComfyUI now calls diffusion_models.
  if (first === 'unet') return 'diffusion_models';
  return first;
}

const CAPABILITY_WORDS: Record<JobKind, string> = {
  txt2img: 'text-to-image',
  img2img: 'image-to-image',
  txt2vid: 'text-to-video',
  img2vid: 'image-to-video',
  upscale: 'upscaling',
};

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What a support file is for, in the words a person would use. */
const SUPPORT_WORDS: Partial<Record<ModelType, string>> = {
  lora: 'A LoRA: it adapts a checkpoint you already have rather than generating on its own.',
  vae: 'A VAE: a workflow uses it to decode latents, in place of the one inside a checkpoint.',
  controlnet: 'A ControlNet: it steers a checkpoint from a reference image.',
  upscaler: 'An upscaling model, used by an upscale workflow rather than a generation one.',
  clip: 'A text encoder: some model families need one alongside their weights.',
};

export interface RunnabilityInput {
  /** As the file will be known to ComfyUI, subfolder and all. */
  filename: string;
  type: ModelType;
  /** The catalogue's own `base`, when there is one. Authoritative if we know it. */
  catalogueBase?: string | null;
  /** The ComfyUI folder the file is in, or will be installed into. */
  folder: string | null;
  /** `/object_info` for the backend in question, or null if we could not read it. */
  info: ObjectInfo | null;
  backendId: Uuid | null;
  /** Name used in the sentences. */
  backendName: string;
  /**
   * True for a file already on the backend. It changes one thing: a checkpoint
   * the workflow's loader cannot see is then a fact about this machine, not a
   * prediction about an install.
   */
  installed: boolean;
}

/** Where a template expects the checkpoint, resolved from its manifest. */
interface CheckpointSlot {
  nodeId: string;
  input: string;
  nodeClass: string;
  folder: string | null;
}

function checkpointSlotOf(template: WorkflowTemplate): CheckpointSlot | null {
  const binding = template.manifest.inputs.find((input) => input.source === 'checkpointFilename');
  if (!binding) return null;
  // Manifest paths are always "<nodeId>.inputs.<inputName>"; the tests in
  // workflows/ assert that, so this parse cannot drift.
  const match = /^(.+)\.inputs\.(.+)$/.exec(binding.path);
  if (!match) return null;
  const [, nodeId, input] = match as unknown as [string, string, string];
  const nodeClass = template.graph[nodeId]?.class_type;
  if (!nodeClass) return null;
  return { nodeId, input, nodeClass, folder: FOLDER_READ_BY[nodeClass] ?? null };
}

/** The template's graph with the checkpoint slot pointed at this file. */
function graphWithCheckpoint(
  template: WorkflowTemplate,
  slot: CheckpointSlot,
  filename: string,
): ComfyApiGraph {
  const node = template.graph[slot.nodeId]!;
  return {
    ...template.graph,
    [slot.nodeId]: { ...node, inputs: { ...node.inputs, [slot.input]: filename } },
  };
}

interface Attempt {
  capability: JobKind;
  isFallback: boolean;
  /** Set when this template's loader reads a different folder than the file's. */
  folderMismatch: { loader: string; wants: string } | null;
  /**
   * Set for a file already on the backend that the workflow's own loader does
   * not offer. Same problem as a folder mismatch, established the other way
   * round: not predicted from a save path but observed in `/object_info`.
   */
  notVisibleTo: string | null;
  missing: MissingCompanion[];
  missingNodeClass: string | null;
  /** True when nothing stands between this template and a run. */
  clean: boolean;
}

/**
 * The verdict for one model on one backend. Pure — the caller fetches
 * `/object_info` (through preflight's cache) and passes it in, which is what
 * makes this testable against a fixture instead of a live LAN box.
 */
export function runnabilityFor(input: RunnabilityInput): ModelRunnability {
  const family = inferFamily({ filename: input.filename, catalogueBase: input.catalogueBase });

  const base = {
    family,
    backendId: input.backendId,
    missing: [] as MissingCompanion[],
  };

  // Support files never "run". Saying so is not a dodge: it is the honest
  // answer, and it stops a grid of LoRAs from being marked unusable because no
  // template names one.
  if (input.type !== 'checkpoint') {
    return {
      ...base,
      status: 'support',
      capabilities: [],
      summary: 'Support file',
      detail: SUPPORT_WORDS[input.type] ?? 'A file a workflow uses rather than generates with.',
    };
  }

  const offers = capabilityOffersFor(family);
  if (offers.length === 0) {
    return {
      ...base,
      status: 'no-workflow',
      capabilities: [],
      summary: 'No workflow for this yet',
      detail: `${familyWords(family)} needs a graph of its own, and this studio does not ship one — so installing it would not make it usable.`,
    };
  }

  const attempts: Attempt[] = [];
  for (const offer of offers) {
    const template = findTemplateById(offer.templateId);
    if (!template) continue;
    const slot = checkpointSlotOf(template);

    const folderMismatch =
      slot && slot.folder && input.folder && slot.folder !== input.folder
        ? { loader: slot.nodeClass, wants: slot.folder }
        : null;

    let missing: MissingCompanion[] = [];
    let missingNodeClass: string | null = null;
    let notVisibleTo: string | null = null;

    if (input.info && slot) {
      const result = checkGraph(graphWithCheckpoint(template, slot, input.filename), input.info);
      const isSlot = (file: { nodeId: string; input: string }) =>
        file.nodeId === slot.nodeId && file.input === slot.input;

      // The model itself is never a *companion*. For a catalogue entry it is
      // not installed yet — that is the whole point of the screen — so its
      // absence proves nothing. For a file already on disk it proves a great
      // deal: this loader cannot see it.
      if (input.installed && result.missingFiles.some(isSlot)) notVisibleTo = slot.nodeClass;

      missing = result.missingFiles
        .filter((file) => !isSlot(file))
        .map((file) => ({
          filename: file.filename,
          purpose: purposeOf(file.nodeClass, file.filename),
          loader: file.nodeClass,
        }));
      missingNodeClass = result.missingNodeClasses[0] ?? null;
    }

    attempts.push({
      capability: offer.capability,
      isFallback: offer.isFallback,
      folderMismatch,
      notVisibleTo,
      missing,
      missingNodeClass,
      clean: !folderMismatch && !notVisibleTo && missing.length === 0 && !missingNodeClass,
    });
  }

  const clean = attempts.filter((attempt) => attempt.clean);
  const capabilities = (clean.length > 0 ? clean : attempts).map((attempt) => attempt.capability);
  const words = listWords([...new Set(capabilities)].map((kind) => CAPABILITY_WORDS[kind]));

  if (clean.length > 0) {
    // `/object_info` unread means the file checks did not run, so "clean" only
    // proves the static half. Say which one you are being told.
    if (!input.info) {
      return {
        ...base,
        status: 'unknown',
        capabilities,
        summary: 'Probably runs — could not check',
        detail: `There is ${clean.every((attempt) => attempt.isFallback) ? 'a generic workflow' : 'a workflow'} for ${words} here, but ${input.backendName} could not be asked whether it has the other files that workflow needs.`,
      };
    }
    const authored = clean.some((attempt) => !attempt.isFallback);
    return {
      ...base,
      status: authored ? 'ready' : 'generic',
      capabilities,
      summary: authored ? 'Will run' : 'Will run, on a generic workflow',
      detail: authored
        ? `${familyWords(family)}, with a workflow written for it. Good for ${words} on ${input.backendName}.`
        : family
          ? `No workflow is written for ${familyName(family)} specifically, so this runs on the generic Stable-Diffusion graph — the right nodes, untuned settings. Good for ${words}.`
          : `We could not work out what family this is, so it runs on the generic Stable-Diffusion graph — which is right for most checkpoints and wrong for a video or FLUX one. Good for ${words}.`,
    };
  }

  // Nothing is clean. Report the *nearest* obstacle: a folder mismatch is worth
  // more than a missing companion, because it cannot be fixed by downloading
  // anything and would otherwise be reported as "install one more file".
  if (attempts.length > 0 && attempts.every((a) => a.folderMismatch || a.notVisibleTo)) {
    const mismatch = attempts.find((attempt) => attempt.folderMismatch)?.folderMismatch;
    const invisible = attempts.find((attempt) => attempt.notVisibleTo)?.notVisibleTo;
    return {
      ...base,
      status: 'wrong-folder',
      capabilities,
      summary: input.installed ? 'On disk, but the workflow cannot see it' : 'Lands in the wrong folder',
      detail: mismatch
        ? `This file ${input.installed ? 'sits in' : 'installs into'} ComfyUI's "${input.folder}" folder, but the ${familyAdjective(family)} workflow loads it with ${mismatch.loader}, which only reads "${mismatch.wants}". ` +
          `Moving it into "${mismatch.wants}" on ${input.backendName} is what makes it usable.`
        : `${input.backendName} has this file, but does not offer it to ${invisible} — the loader the ${familyAdjective(family)} workflow uses. It is filed in a folder that loader does not read, so it needs moving rather than downloading again.`,
    };
  }

  const blocked = attempts.find((attempt) => attempt.missing.length > 0 || attempt.missingNodeClass);
  if (blocked?.missingNodeClass) {
    return {
      ...base,
      status: 'needs-companion',
      capabilities,
      summary: 'Needs a custom node',
      detail: `The ${familyAdjective(family)} workflow uses the "${blocked.missingNodeClass}" node, which ${input.backendName} does not have. It is a custom node and has to be installed there.`,
    };
  }
  if (blocked) {
    const [first, ...rest] = blocked.missing;
    const more = rest.length > 0 ? ` and ${rest.length} other file${rest.length > 1 ? 's' : ''}` : '';
    return {
      ...base,
      status: 'needs-companion',
      capabilities,
      missing: blocked.missing,
      summary: 'Needs another model first',
      detail: `The ${familyAdjective(family)} workflow also needs ${first!.purpose ? `a ${first!.purpose}, "${first!.filename}"` : `"${first!.filename}"`}${more}, which ${input.backendName} cannot load.`,
    };
  }

  return {
    ...base,
    status: 'unknown',
    capabilities,
    summary: 'Cannot tell',
    detail: `There is a workflow for this, but ${input.backendName} could not be asked what it can load.`,
  };
}

/**
 * The same vocabulary preflight uses for a missing file, kept in step with it
 * deliberately: the sentence a user reads here, before installing, should be
 * the one they would have read from a refused job.
 */
function purposeOf(nodeClass: string, filename: string): string | null {
  if (/^(CLIPLoader|DualCLIPLoader|TripleCLIPLoader)$/.test(nodeClass)) {
    return /t5/i.test(filename) ? 'T5 text encoder' : 'text encoder';
  }
  if (nodeClass === 'VAELoader') return 'VAE';
  if (/Lora/i.test(nodeClass)) return 'LoRA';
  if (/ControlNet/i.test(nodeClass)) return 'ControlNet';
  if (/Upscale/i.test(nodeClass)) return 'upscaling model';
  if (/^(CheckpointLoaderSimple|CheckpointLoader|UNETLoader)$/.test(nodeClass)) {
    return 'model checkpoint';
  }
  return null;
}

/**
 * How a family is written in a sentence.
 *
 * `models.base_model` holds folded, canonical spellings — "sdxl", "ltx-video" —
 * because that is what makes two rows comparable. They are not what anybody
 * calls these models, and "A sdxl model" in a message a user reads is a small
 * ugliness with no upside, so the display spelling is kept here.
 */
const FAMILY_NAMES: Record<string, string> = {
  sdxl: 'SDXL',
  'sdxl-turbo': 'SDXL Turbo',
  pony: 'Pony',
  illustrious: 'Illustrious',
  'sd1.5': 'SD 1.5',
  'sd2.x': 'SD 2.x',
  sd3: 'SD 3',
  'flux.1': 'FLUX.1',
  'hunyuan-video': 'Hunyuan Video',
  'ltx-video': 'LTX-Video',
  svd: 'Stable Video Diffusion',
  wan: 'WAN',
};

function familyName(family: string): string {
  return FAMILY_NAMES[family] ?? family;
}

/** "An SDXL", "A FLUX.1". Sounded out, not spelled out: SDXL reads as "ess". */
function withArticle(name: string): string {
  return /^[AEIOUFHLMNRSX]/i.test(name[0] ?? '') && name.toUpperCase() === name
    ? `An ${name}`
    : /^[aeiou]/i.test(name)
      ? `An ${name}`
      : `A ${name}`;
}

/** Subject of a sentence: "An SDXL model", or the honest thing when we cannot tell. */
function familyWords(family: string | null): string {
  return family
    ? `${withArticle(familyName(family))} model`
    : 'A model whose family we could not work out';
}

/** Adjective before "workflow": "the SDXL workflow", "the generic workflow". */
function familyAdjective(family: string | null): string {
  return family ? familyName(family) : 'generic';
}

/** For the UI's filter: the statuses that mean "this is usable as it stands". */
export function isUsable(status: RunnabilityStatus): boolean {
  return status === 'ready' || status === 'generic';
}
