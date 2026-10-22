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
import type { MissingPart } from '../lib/api-jobs';
import { VOCABULARY } from '../models/vocabulary';
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
  /** The companion files it is waiting on, when the server named them. */
  missing: MissingPart[];
  /** The server offered downloads for them: a "Get it" button can work. */
  installable: boolean;
}

/**
 * "a prompt reader (T5 text encoder)" — the plain name first, the server's
 * expert label after it for anyone who wants to look it up.
 */
export function partName(part: MissingPart): string {
  if (!part.type) return part.label;
  const plain = VOCABULARY[part.type].name.toLowerCase();
  const article = /^[aeiou]/.test(plain) ? 'an' : 'a';
  return part.label.toLowerCase() === plain ? `${article} ${plain}` : `${article} ${plain} (${part.label})`;
}

/**
 * The one sentence for a model that is waiting on files. Never "wrong folder"
 * or "needs another model": both are true and both send a newcomer looking for
 * a second checkpoint. What they need to hear is that one file is missing and
 * there is a button for it.
 */
export function missingSentence(missing: MissingPart[]): string | null {
  const absent = missing.filter((part) => !part.misfiled);
  const moved = missing.filter((part) => part.misfiled);
  const sentences: string[] = [];
  if (absent.length === 1) sentences.push(`This model needs one more file — ${partName(absent[0]!)}.`);
  else if (absent.length > 1) {
    sentences.push(`This model needs ${absent.length} more files — ${absent.map(partName).join(', ')}.`);
  }
  if (moved.length > 0) {
    sentences.push(
      `${moved.length === 1 ? 'One file it uses is' : `${moved.length} files it uses are`} saved where it can’t be found — ${moved.map(partName).join(', ')}.`,
    );
  }
  return sentences.length > 0 ? sentences.join(' ') : null;
}

/**
 * The badge for a model nothing here can run yet. It used to say "No template",
 * which is ComfyUI's word for the thing that is missing, not the person's.
 */
export const NOT_SUPPORTED = 'Not supported yet';

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
    const missing = answer?.missing ?? [];
    const absent = missing.filter((part) => !part.misfiled).length;
    return {
      badge:
        absent === 1 ? 'Needs one more file' : absent > 1 ? `Needs ${absent} more files` : 'Needs setup',
      detail: `cannot run here yet: ${answer?.summary ?? 'the backend is not set up for it.'}`,
      steps: answer?.steps ?? [],
      switchTo: null,
      missing,
      installable: answer?.installable === true,
    };
  }

  if (entry.blocked === 'needs-image') {
    return {
      badge: 'Needs an image',
      detail: 'only runs from a starting image. Add one above and it becomes selectable.',
      steps: [],
      switchTo: null,
      missing: [],
      installable: false,
    };
  }

  if (entry.hidden === 'other-mode' && entry.runsInMode) {
    const only = entry.runsInMode;
    return {
      badge: only === 'video' ? 'Video model' : 'Image model',
      detail: `is a ${KIND_NOUN[only]} model — it runs ${KIND_NOUN[only]} jobs, not ${KIND_NOUN[mode]} ones.`,
      steps: [],
      switchTo: only,
      missing: [],
      installable: false,
    };
  }

  return {
    badge: NOT_SUPPORTED,
    detail:
      answer?.summary ??
      `isn't supported yet — rippel has no recipe (workflow) for ${family} models.`,
    steps: [],
    switchTo: null,
    missing: [],
    installable: false,
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

export type PillTone = 'ok' | 'needs' | 'bad';

/**
 * The fit pills on a tile — the same words the Models page uses: "Will run",
 * "Needs prompt reader", "Needs image decoder". One pill per missing kind of
 * part, never a count, because what is missing is what a person needs to know.
 */
export function fitPills(
  entry: ModelEntry,
  kind: JobKind,
  readiness: ReadinessMap,
): { label: string; tone: PillTone }[] {
  if (entry.runnable) return [{ label: 'Will run', tone: 'ok' }];
  const answer = readiness.here[entry.model.id];
  if (entry.blocked === 'needs-setup') {
    if (answer?.problem) {
      return [{ label: answer.problem.kind === 'unloadable' ? 'Can’t load this file' : 'Needs moving', tone: 'bad' }];
    }
    const pills: { label: string; tone: PillTone }[] = [];
    const seen = new Set<string>();
    for (const part of answer?.missing ?? []) {
      const label = part.misfiled
        ? 'Needs moving'
        : `Needs ${part.type ? VOCABULARY[part.type].name.toLowerCase() : part.label}`;
      if (seen.has(label)) continue;
      seen.add(label);
      pills.push({ label, tone: 'needs' });
    }
    if (pills.length > 0) return pills;
  }
  return [{ label: blockedReason(entry, kind, readiness).badge, tone: 'bad' }];
}

/** "a prompt reader (T5 text encoder) and an image decoder" */
export function joinParts(parts: MissingPart[]): string {
  const names = parts.map(partName);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Parts a download can fix, as opposed to ones that need moving. */
export function absentParts(missing: readonly MissingPart[] | undefined): MissingPart[] {
  return (missing ?? []).filter((part) => !part.misfiled);
}

/**
 * Why Generate is waiting, for a chosen model that cannot run yet. Null when
 * the model is not blocked on its setup (then the form's own reason stands).
 */
export function setupReason(answer: { state: string; missing?: MissingPart[]; problem?: { kind: string } | null } | undefined): string | null {
  if (!answer || answer.state !== 'blocked') return null;
  if (answer.problem) {
    return answer.problem.kind === 'unloadable'
      ? 'This model file can’t be loaded — pick another model'
      : 'Move this model file into the right folder first';
  }
  const absent = absentParts(answer.missing).length;
  const moved = (answer.missing ?? []).length - absent;
  if (absent === 1 && moved === 0) return 'Install the missing part first';
  if (absent > 1 && moved === 0) return `Install the ${absent} missing parts first`;
  if (absent === 0 && moved > 0) return 'Move the misplaced file first';
  if (absent > 0) return `Install the ${absent} missing part${absent > 1 ? 's' : ''} and move the misplaced file first`;
  return 'This model isn’t set up on that machine yet';
}
