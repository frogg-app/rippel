/**
 * The words for a verdict `visibility.ts` has already reached.
 *
 * This used to live inside `ModelPicker.tsx`, which was fine while the picker
 * was the only thing that drew a model. The modal draws them now, and the panel
 * still has to explain the *selected* one, so two components need the same
 * sentences. A module they both import is the way to keep them identical: the
 * failure mode being avoided is a tile that says "Needs setup" beside a summary
 * that says something subtly different about the same checkpoint.
 *
 * Nothing here decides anything. Every branch keys off a `ModelEntry` field
 * that `visibility.ts` set, and the readiness answer is consulted only for the
 * server's own prose — the remedy it sent, which is the one part of this we
 * could never write ourselves.
 */
import type { JobKind, Model } from '@comfy/shared';
import { modeOfKind } from './form';
import type { CreateMode } from './mode';
import type { ReadinessMap } from './useReadiness';
import type { ModelEntry } from './visibility';

export const KIND_NOUN: Record<CreateMode, string> = { image: 'image', video: 'video' };

export interface BlockedReason {
  /** Two words, on the tile. */
  badge: string;
  /** The sentence, in the note and the tooltip. */
  detail: string;
  /** The server's own remedy, when it gave one. */
  steps: string[];
  /** The mode that *would* run this model, when there is one. */
  switchTo: CreateMode | null;
}

/**
 * Why this model cannot run this job — the specific answer, not the count.
 *
 * The states that reach a *visible* tile are the fixable ones: the backend is
 * missing a file (the server tells us which, and how to fix it), or the job
 * wants a starting image. The unfixable ones are hidden, and only reach here
 * through the "show anyway" reveal, where the honest answer is that nobody has
 * written a graph for this family.
 */
export function blockedReason(
  entry: ModelEntry,
  kind: JobKind,
  readiness: ReadinessMap,
): BlockedReason {
  const model = entry.model;
  const family = model.baseModel ?? 'this family';
  const mode = modeOfKind(kind);
  const answer = readiness.here[model.id];

  if (entry.blocked === 'needs-setup') {
    return {
      badge: 'Needs setup',
      detail: `cannot run here yet: ${answer?.summary ?? 'the backend is not set up for it.'}`,
      steps: answer?.steps ?? [],
      switchTo: null,
    };
  }

  if (entry.blocked === 'needs-image') {
    return {
      badge: 'Needs an image',
      detail: 'only runs from a starting image. Add one above and it becomes selectable.',
      steps: [],
      switchTo: null,
    };
  }

  if (entry.hidden === 'other-mode' && entry.runsInMode) {
    const only = entry.runsInMode;
    return {
      badge: only === 'video' ? 'Video model' : 'Image model',
      detail: `is a ${KIND_NOUN[only]} model — it runs ${KIND_NOUN[only]} jobs, not ${KIND_NOUN[mode]} ones.`,
      steps: [],
      switchTo: only,
    };
  }

  return {
    badge: 'No template',
    detail:
      answer?.summary ??
      `has no workflow template yet — nothing here knows how to build a graph for ${family}.`,
    steps: [],
    switchTo: null,
  };
}

/**
 * The one-word state on a tile or a summary row.
 *
 * "Ready" is said out loud rather than left as the absence of a badge, because
 * in a modal with room for it the difference between "this will run" and "we
 * have not finished checking" is worth stating. Nothing pending ever reaches
 * here: the screen does not draw a set of models until the probes have landed.
 */
export function stateLabel(entry: ModelEntry, kind: JobKind, readiness: ReadinessMap): string {
  return entry.runnable ? 'Ready' : blockedReason(entry, kind, readiness).badge;
}

/** "Hunyuan Video 720p and Ltx Video" — at most two, then "and 2 more". */
export function listNames(models: Model[]): string {
  const names = models.slice(0, 2).map((model) => model.displayName);
  const rest = models.length - names.length;
  if (rest > 0) return `${names.join(', ')} and ${rest} more`;
  return names.length === 2 ? `${names[0]} and ${names[1]}` : (names[0] ?? '');
}
