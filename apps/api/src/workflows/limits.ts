/**
 * `VideoLimits` from a manifest — the frame budget a form has to respect.
 *
 * ## Why this is derived and not declared
 *
 * Every number here is already in the manifest, twice over: as the constraint
 * on the `frameCount` and `fps` inputs that the compiler validates against, and
 * as `frameQuantum`. Adding a second, hand-written copy for the client to read
 * would be a copy that can disagree with the one that does the rejecting, and
 * the disagreement would show up as the exact bug this exists to fix — a form
 * offering a value the API then refuses. So the limits are a projection of the
 * constraints, in the same spirit as `routes.ts` being a projection of the
 * registry's resolver.
 *
 * ## Why an input can be bound more than once
 *
 * `fps` is written to two paths on the video templates: the sampler conditions
 * on the rate, and the encoder has to be told the same number or the file plays
 * at the wrong speed. Both carry the same constraint today, and if they ever
 * did not, the *narrower* pair is the only honest answer — a value outside
 * either one is rejected. So the ranges are intersected rather than first-wins.
 */

import type { VideoLimits } from '@comfy/shared';
import type { ManifestInput, ParamSource, WorkflowManifest } from './types.js';

/** The numeric span of an int/float constraint; null for anything unbounded. */
function spanOf(input: ManifestInput): { min: number; max: number } | null {
  const constraint = input.constraint;
  if (!constraint) return null;
  if (constraint.kind !== 'int' && constraint.kind !== 'float') return null;
  return { min: constraint.min, max: constraint.max };
}

/**
 * The intersection of every bound placed on one source, or null when the
 * manifest binds it nowhere — which is the signal that the family has no such
 * knob, not that it is unlimited.
 */
function boundsFor(
  manifest: WorkflowManifest,
  source: ParamSource,
): { min: number; max: number } | null {
  let bounds: { min: number; max: number } | null = null;
  for (const input of manifest.inputs) {
    if (input.source !== source) continue;
    const span = spanOf(input);
    if (!span) continue;
    bounds = bounds
      ? { min: Math.max(bounds.min, span.min), max: Math.min(bounds.max, span.max) }
      : span;
  }
  return bounds;
}

/**
 * What this template can sample, or null when it is not a video template.
 *
 * "Not a video template" is decided by the capability rather than by whether a
 * `frameCount` input happens to be present: an image template with no frame
 * budget should report nothing, and a video template that somehow lost its
 * frame binding is a broken manifest the path tests should catch, not something
 * to paper over with a plausible-looking default range here.
 */
export function videoLimitsFor(manifest: WorkflowManifest): VideoLimits | null {
  if (manifest.capability !== 'txt2vid' && manifest.capability !== 'img2vid') return null;

  const frames = boundsFor(manifest, 'frameCount');
  const fps = boundsFor(manifest, 'fps');
  if (!frames || !fps) return null;

  return {
    frames,
    // `frameQuantum` is omitted by families that sample any count. Null and
    // 1 mean the same thing to the compiler; null is the one the wire carries.
    frameQuantum: manifest.frameQuantum && manifest.frameQuantum > 1 ? manifest.frameQuantum : null,
    fps,
    motion: boundsFor(manifest, 'motion'),
  };
}
