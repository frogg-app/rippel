/**
 * Discover's first question: what do you want to make?
 *
 * The catalogue is organised the way ComfyUI stores files — checkpoints, LoRAs,
 * VAEs — and the person browsing it is organised around a job: a picture, a
 * clip, a bigger version of something they already have. The intent chips are
 * that second organisation laid over the first, and this module is the mapping
 * between them, plus the two other judgements the screen opens on: "does it
 * work here?" and "which of these should I try first?".
 *
 * An entry's intents are read from the most trustworthy evidence it has:
 *
 *   1. the verdict's `capabilities` — the API matched it against a workflow on
 *      *this* backend, so "txt2vid" there is a fact, not a tag somebody typed;
 *   2. the model page's task tags (`task:text-to-video`), when there is no
 *      verdict to go on;
 *   3. the type, via the vocabulary groups: a style add-on is a style add-on
 *      whatever its tags say, and an enlarger only ever enlarges.
 *
 * Only the vocabulary's `models` group can make, edit or animate anything. A
 * LoRA tagged `text-to-image` (most are) is still not something you make an
 * image *with*, and listing it under "Make images" is the confusion this screen
 * exists to remove.
 */
import type { MissingCompanion, ModelCatalogEntry, ModelType, RunnabilityStatus } from '@comfy/shared';
import { VOCABULARY } from './vocabulary';

export type Intent = 'images' | 'video' | 'edit' | 'enlarge' | 'styles' | 'all';

export interface IntentWords {
  label: string;
  /** The one line under the chips: what this chip finds, in plain words. */
  explain: string;
}

/** In the order the chips are drawn: Everything first, then the jobs. */
export const INTENTS: readonly Intent[] = ['all', 'images', 'video', 'edit', 'enlarge', 'styles'];

export const INTENT_WORDS: Record<Intent, IntentWords> = {
  images: {
    label: 'Make images',
    explain: 'Models that turn a prompt into a picture.',
  },
  video: {
    label: 'Make video',
    explain: 'Models that make a short clip from a prompt or a still image.',
  },
  edit: {
    label: 'Edit an image',
    explain: 'Models that start from a picture you give them and change it.',
  },
  enlarge: {
    label: 'Enlarge images',
    explain: 'Enlargers: make a finished picture bigger and sharper.',
  },
  styles: {
    label: 'Style add-ons',
    explain: 'Small extras that push a model towards a look or subject. They need a model to work with.',
  },
  all: {
    label: 'Everything',
    explain: 'Every model, add-on and guide this machine could install.',
  },
};

export const DEFAULT_INTENT: Intent = 'images';

/** Types the vocabulary calls parts: never browsed for, only needed. */
export function isPart(type: ModelType): boolean {
  return VOCABULARY[type].group === 'parts';
}

const VIDEO_TASKS = ['text-to-video', 'image-to-video', 'video-to-video'];
const EDIT_TASKS = ['image-to-image', 'inpainting', 'image-inpainting'];

/**
 * Which chips an entry belongs under. Several at once is normal — an SDXL model
 * both makes and edits images — and `all` is implied, not listed.
 */
export function intentsOf(entry: ModelCatalogEntry): Set<Intent> {
  const found = new Set<Intent>();
  const group = VOCABULARY[entry.type].group;
  if (group === 'styles') found.add('styles');
  if (group === 'enlargers') found.add('enlarge');
  const caps = entry.runnability?.capabilities ?? [];
  if (caps.includes('upscale')) found.add('enlarge');
  if (group !== 'models') return found;

  if (caps.length > 0) {
    if (caps.includes('txt2img')) found.add('images');
    if (caps.includes('img2img')) found.add('edit');
    if (caps.includes('txt2vid') || caps.includes('img2vid')) found.add('video');
    return found;
  }

  const tasks = entry.info?.tags?.task ?? [];
  if (tasks.some((task) => VIDEO_TASKS.includes(task))) found.add('video');
  if (tasks.some((task) => EDIT_TASKS.includes(task))) found.add('edit');
  // A model with nothing said about it is far more likely to make pictures
  // than anything else: that is what most of the catalogue's checkpoints are.
  // One that only says "video" is left out, so LTX-Video does not open the
  // screen under "Make images".
  if (tasks.includes('text-to-image') || !found.has('video')) found.add('images');
  return found;
}

export function matchesIntent(entry: ModelCatalogEntry, intent: Intent): boolean {
  return intent === 'all' || intentsOf(entry).has(intent);
}

/**
 * "Works on this machine": the default answer to the question people came to
 * Discover with.
 *
 * A model that will run, or that runs once one more file arrives (the card
 * says which), passes; one whose workflow needs a node the machine lacks does
 * not, since no download fixes that. An add-on passes when a workflow here can
 * use it with the model it was made for. Nothing that cannot be installed
 * passes. An entry with no verdict at all (the backend could not be asked)
 * does not pass: it is not known to work, and the empty state offers the way
 * out.
 */
export function worksHere(entry: ModelCatalogEntry): boolean {
  // Nothing that cannot be installed yet works here, add-on or not.
  if (entry.installBlockedReason) return false;
  // An add-on works here when some workflow here can use it with its model.
  if (VOCABULARY[entry.type].group !== 'models') return entry.runnability?.status !== 'no-workflow';
  const status = entry.runnability?.status;
  // A missing node is not a file that can come with the model.
  if (entry.runnability?.missingNode) return false;
  return status === 'ready' || status === 'generic' || status === 'needs-companion';
}

/** "Will run" before "should run" before "needs one more file" before the rest. */
const STATUS_RANK: Record<RunnabilityStatus, number> = {
  ready: 0,
  generic: 1,
  // An add-on's "support" is not a lesser verdict, it is no verdict; rank it
  // with the working ones so a style add-on is not sunk below broken models.
  support: 1,
  'needs-companion': 2,
  'wrong-folder': 3,
  'no-workflow': 3,
  unknown: 3,
};

export function statusRank(entry: ModelCatalogEntry): number {
  return entry.runnability ? STATUS_RANK[entry.runnability.status] : 3;
}

/**
 * What a missing companion is called on a card: the vocabulary's word for it
 * when the file says what it is, the API's own purpose otherwise, the filename
 * as the last resort. "T5 text encoder" is the expert half; a person needs to
 * know it reads the prompt.
 */
export function companionName(missing: MissingCompanion): string {
  const said = `${missing.purpose ?? ''} ${missing.filename} ${missing.loader}`.toLowerCase();
  if (/\bvae\b|vaeloader|\bae\.safetensors/.test(said)) return VOCABULARY.vae.name;
  if (/t5|umt5|clip|text encoder|textencoder/.test(said)) return VOCABULARY.clip.name;
  return missing.purpose ?? missing.filename;
}

/** "Needs: Prompt reader, Image decoder", or null when nothing is missing. */
export function needsLine(entry: ModelCatalogEntry): string | null {
  const missing = entry.runnability?.missing ?? [];
  if (entry.runnability?.status !== 'needs-companion' || missing.length === 0) return null;
  const names = [...new Set(missing.map(companionName))];
  return `Needs: ${names.join(', ')}`;
}
