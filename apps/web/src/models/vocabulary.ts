/**
 * The one set of words this app uses for kinds of model file.
 *
 * ComfyUI names files after the slot they fill in a graph — checkpoint, LoRA,
 * VAE, ControlNet, CLIP — and those words mean nothing to somebody who came
 * here to make a picture. Every screen that labels a type reads it from here,
 * so a word changed once changes everywhere, and two screens can never
 * describe the same file two different ways.
 *
 * The expert term is kept, but always second: small, after a dot, or in a
 * `title`. Somebody who knows ComfyUI should still be able to find "LoRA";
 * nobody else should have to read it first.
 */
import type { ModelType } from '@comfy/shared';

export type VocabGroup = 'models' | 'styles' | 'guides' | 'enlargers' | 'parts';

export interface TypeWords {
  /** The friendly name, e.g. "Style add-on". */
  name: string;
  plural: string;
  /** One plain sentence: what it does. */
  explain: string;
  /** Where in rippel it gets used. */
  where: string;
  /** The ComfyUI term, shown small and secondary. */
  expert: string;
  /** The shortest form of `expert`, for a chip or a `title`. */
  expertShort: string;
  group: VocabGroup;
}

export const VOCABULARY: Record<ModelType, TypeWords> = {
  checkpoint: {
    name: 'Model',
    plural: 'Models',
    explain: 'The main engine that makes the picture or video.',
    where: 'Pick it on the Create screen.',
    expert: 'Checkpoint / diffusion model',
    expertShort: 'Checkpoint',
    group: 'models',
  },
  lora: {
    name: 'Style add-on',
    plural: 'Style add-ons',
    explain: 'A small file that nudges a model towards a look or subject — it cannot make a picture by itself.',
    where: 'Style add-ons, on the Create screen.',
    expert: 'LoRA',
    expertShort: 'LoRA',
    group: 'styles',
  },
  vae: {
    name: 'Image decoder',
    plural: 'Image decoders',
    explain: 'Turns what a model works on into the final picture you see.',
    where: 'Loaded automatically by the workflows that ask for one.',
    expert: 'VAE',
    expertShort: 'VAE',
    group: 'parts',
  },
  controlnet: {
    name: 'Pose & outline guide',
    plural: 'Pose & outline guides',
    explain: 'Steers a model with a reference image — a pose, an outline, a depth map.',
    where: 'Used by the workflows built around a reference image.',
    expert: 'ControlNet',
    expertShort: 'ControlNet',
    group: 'guides',
  },
  upscaler: {
    name: 'Enlarger',
    plural: 'Enlargers',
    explain: 'Makes a finished picture bigger and sharper. It does not make one.',
    where: 'Used by the Upscale workflow.',
    expert: 'Upscaler',
    expertShort: 'Upscaler',
    group: 'enlargers',
  },
  clip: {
    name: 'Prompt reader',
    plural: 'Prompt readers',
    explain: 'Reads your prompt for the models that keep that part in a separate file.',
    where: 'Loaded automatically alongside those models.',
    expert: 'Text encoder (CLIP / T5)',
    expertShort: 'text encoder',
    group: 'parts',
  },
  video: {
    name: 'Video part',
    plural: 'Video parts',
    explain: 'A piece a video workflow loads, rather than a model you pick yourself.',
    where: 'Used by the video workflows.',
    expert: 'Video model component',
    expertShort: 'video component',
    group: 'parts',
  },
};

export interface GroupWords {
  title: string;
  blurb: string;
  types: ModelType[];
}

/** The legend's rows, in the order somebody needs them. */
export const GROUPS: Record<VocabGroup, GroupWords> = {
  models: {
    title: 'Models',
    blurb: 'What you generate with. You need at least one.',
    types: ['checkpoint'],
  },
  styles: {
    title: 'Style add-ons',
    blurb: 'Optional extras that push a model towards a look or subject.',
    types: ['lora'],
  },
  guides: {
    title: 'Guides',
    blurb: 'Make a model follow a reference image — a pose or an outline.',
    types: ['controlnet'],
  },
  enlargers: {
    title: 'Enlargers',
    blurb: 'Make a finished picture bigger.',
    types: ['upscaler'],
  },
  parts: {
    title: 'Parts',
    blurb: 'Files some models need alongside them. Workflows load these for you.',
    types: ['vae', 'clip', 'video'],
  },
};

export const GROUP_ORDER: VocabGroup[] = ['models', 'styles', 'guides', 'enlargers', 'parts'];

/**
 * The expert label for one file, where the file tells us more than the type.
 *
 * `clip` covers both CLIP and T5 encoders; the filename usually says which,
 * and an expert would rather read "T5" than "CLIP / T5".
 */
export function expertFor(type: ModelType, filename?: string | null): string {
  if (type === 'clip' && filename) {
    const lower = filename.toLowerCase();
    if (/t5|umt5/.test(lower)) return 'Text encoder (T5)';
    if (/clip/.test(lower)) return 'Text encoder (CLIP)';
  }
  return VOCABULARY[type].expert;
}

/** "Prompt reader · text encoder" — friendly first, expert after the dot. */
export function nameWithExpert(type: ModelType): string {
  const words = VOCABULARY[type];
  return `${words.name} · ${words.expertShort}`;
}
