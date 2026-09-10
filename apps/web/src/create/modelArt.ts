/**
 * What a model looks like when it has no picture.
 *
 * Almost every locally discovered file has `previewUrl: null` — nothing has
 * downloaded a card for it — so this is the normal case, not an edge one, and
 * whatever it draws is what most of the Create panel is made of.
 *
 * There are two treatments here on purpose, and they are not a disagreement:
 *
 *   `modelWash`   the 72px checkpoint tile. It is the only art on a tile whose
 *                 whole job is to be picked out of a grid at a glance, it
 *                 carries the model's name over a scrim, and there are at most
 *                 a handful on screen. Saturation earns its place there.
 *   `familyWash`  the 30px thumbnail in a list — the extra-styles picker and
 *                 the chosen stack. These come four, six, ten at a time down
 *                 the left edge of a narrow panel, and at that size and count
 *                 a saturated block is not identity, it is noise. The brief
 *                 for this interface is that it stays quiet so the generated
 *                 image is the only saturated thing on screen; four full-chroma
 *                 squares in the input panel break that outright.
 *
 * So the small one keeps the *idea* — same family, same mark — and drops the
 * chroma: a near-monochrome tint a few degrees of hue apart, plus the family's
 * initials. Recognition without shouting. A real `previewUrl` still renders at
 * full colour over the top of it: that is a picture, and pictures are allowed
 * to be colourful.
 */
import type { CSSProperties } from 'react';
import type { Model } from '@comfy/shared';
import { familyLabel, foldFamily } from '../models/catalogue';

/** A stable hue in 0–359 for any string. */
function hueOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/**
 * The checkpoint tile's wash. Saturated, keyed to the model id so a given
 * checkpoint keeps its colour between sessions and becomes recognisable by it.
 */
export function modelWash(model: Model): CSSProperties {
  const hue = hueOf(model.id);
  return {
    background: `radial-gradient(120% 100% at 30% 20%, hsl(${hue} 85% 62%) 0%, hsl(${(hue + 40) % 360} 55% 32%) 55%, hsl(${(hue + 220) % 360} 45% 9%) 100%)`,
  };
}

/**
 * The list thumbnail's wash.
 *
 * Keyed to the *family* rather than the id, so every SDXL style shares a mark
 * and the column reads as groups rather than confetti — which is what the id
 * hash could never do, however quiet its colours. Saturation is capped low
 * enough that the whole set sits inside the interface's own grey-blue world.
 */
export function familyWash(model: Pick<Model, 'id' | 'baseModel'>): CSSProperties {
  const family = model.baseModel ? foldFamily(model.baseModel) : '';
  // No recorded family still gets a stable mark, just from a different seed.
  // The hue is folded into a band around the brand's own blue-green rather
  // than allowed the full wheel: at low saturation a free hue still lands the
  // odd maroon or olive square in a column of blue-greys, which is exactly the
  // sort of stray note this treatment exists to remove. 140 degrees is plenty
  // to tell four families apart when the chroma is this low.
  const hue = (150 + (hueOf(family || model.id) % 140)) % 360;
  return {
    background: `linear-gradient(150deg, hsl(${hue} 14% 25%), hsl(${(hue + 20) % 360} 11% 15%))`,
  };
}

/**
 * Two letters for the thumbnail.
 *
 * Taken from the family's proper spelling where there is one, so it matches
 * the label on the row beside it, and from the file's own name otherwise.
 */
export function familyInitials(model: Pick<Model, 'baseModel' | 'displayName'>): string {
  const source = model.baseModel ? familyLabel(model.baseModel) : model.displayName;
  const letters = source.replace(/[^a-z0-9]/gi, '');
  return letters.slice(0, 2).toUpperCase();
}
