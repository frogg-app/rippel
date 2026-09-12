/**
 * Which checkpoints the picker is allowed to *show* — as opposed to which ones
 * it will let you press.
 *
 * The ask was "if models don't have templates we shouldn't show them in the
 * list when generating", and it is right, but only for one of the several
 * states that were all drawn as the same greyed tile. The split this module
 * exists to make is between what is **impossible** and what is **not yet
 * possible**:
 *
 *   hidden   no workflow exists for this family, in any mode (Hunyuan Video,
 *            Stable Cascade, a FLUX checkpoint with no FLUX graph). Nothing the
 *            user can do makes it run, so a tile for it is noise.
 *   hidden   wrong mode — there IS a workflow, it belongs to the other tab.
 *            The mode toggle is what changes this list; a video checkpoint
 *            under Image is the tab doing its job, not an error.
 *   shown    needs setup — the workflow exists and this backend cannot run it
 *            yet (the LTX-Video case: the checkpoint is in a folder
 *            `CheckpointLoaderSimple` cannot read, and no T5 encoder is
 *            installed). Fixable, and the readiness endpoint returns the exact
 *            remedy. Hiding it would turn a solvable problem into "that model
 *            does not exist".
 *   pending  the readiness probe is still in flight. No verdict is reached:
 *            not hidden, not blocked, not runnable. It is kept in `listed`
 *            only so the selection repair in `CreatePage` does not mistake
 *            "not answered" for "gone" — it is **not** permission to draw it.
 *            An entry that is listed while pending can still be hidden when
 *            its probe lands (a family the map says can do Video, on a box
 *            with no template installed), so while `Partition.pending` is true
 *            the picker draws a skeleton and nothing else. Drawing pending
 *            entries as plain tiles was the reload jump: the badge was never
 *            wrong, the *set* was.
 *   shown    needs a starting image — same family, other side of the
 *            txt2img / img2img split. Also fixable, in one drag.
 *
 * And the rule that outranks all of them: **never hide on `unknown`**. An
 * unreachable API must not make somebody's models disappear. When readiness
 * could not be asked we fall back to the capability map, and even then we only
 * hide a family with no known capabilities if that map came from the server
 * (`live`). That flag used to be false almost always, because the map was a
 * hardcoded mirror in `api-jobs.ts`; it now comes from `GET /workflows`, so the
 * live branch is the normal one and this module finally gets to act on a real
 * answer. An empty map with `live: false` still asserts nothing.
 *
 * One trap that comes with a live map, handled in `modelKinds` rather than
 * here: a checkpoint whose family the server could not infer is **not** a
 * family with no workflow. The generic Stable Diffusion graph answers for it
 * deliberately, and the map reports that in `unknownFamily`. Reading a null
 * family as "no capabilities" would hide every unclassified merge the day the
 * endpoint shipped, which is the opposite of what it was built for.
 */
import type { JobKind, Model } from '@comfy/shared';
import { type CapabilityMap, modelKinds } from '../lib/api-jobs';
import { modeOfKind } from './form';
import type { CreateMode } from './mode';
import type { ReadinessMap } from './useReadiness';

/** Why a model is not in the grid. `null` means it is. */
export type HiddenReason = 'no-template' | 'other-mode';

/** Why a visible model cannot be pressed. `null` means it can. */
export type BlockReason = 'needs-setup' | 'needs-image' | 'no-template';

export interface ModelEntry {
  model: Model;
  /**
   * The server has not answered about this model yet.
   *
   * A pending entry carries no verdict at all: not runnable, not hidden, not
   * blocked. It is the difference between "we know it cannot run" and "we have
   * not asked", and rendering the second as the first is what made the grid
   * flash five wrong "No template" badges on every page load.
   */
  pending: boolean;
  runnable: boolean;
  hidden: HiddenReason | null;
  blocked: BlockReason | null;
  /** Which mode would run it, when exactly one other one would. */
  runsInMode: CreateMode | null;
}

export interface Partition {
  /** In grid order, the models the picker draws. */
  listed: ModelEntry[];
  /** Everything left out, in grid order, for the "N hidden" reveal. */
  hidden: ModelEntry[];
  /** Of `listed`, the ones that can actually be selected. */
  runnable: ModelEntry[];
  /**
   * True while any listed model is still waiting on a verdict. While it is,
   * `listed` is not yet the set that will be shown and must not be drawn.
   */
  pending: boolean;
  hiddenNoTemplate: ModelEntry[];
  hiddenOtherMode: ModelEntry[];
  /** Anything the *other* tab would run — the sentence worth saying when this
   *  tab is empty. */
  otherMode: ModelEntry[];
}

function ready(state: string | undefined): boolean {
  return state === 'ready' || state === 'blocked';
}

/**
 * One model's verdict. Readiness wins when the server answered — it is the
 * specific truth about this machine — and the family capability map is the
 * fallback for when it did not.
 */
export function classify(
  model: Model,
  kind: JobKind,
  capabilities: CapabilityMap,
  readiness: ReadinessMap,
): ModelEntry {
  const mode = modeOfKind(kind);
  const otherMode: CreateMode = mode === 'image' ? 'video' : 'image';
  const here = readiness.here[model.id];
  const there = readiness.other[model.id];

  const kinds = modelKinds(model, capabilities);
  const mapModes = new Set(kinds.map(modeOfKind));
  // "The other tab would run this" — from the server if it answered about the
  // other capability, otherwise from the family map.
  const elsewhere = ready(there?.state) || mapModes.has(otherMode);

  const entry = (
    partial: Pick<ModelEntry, 'runnable' | 'hidden' | 'blocked'> & { pending?: boolean },
  ): ModelEntry => ({
    model,
    pending: false,
    ...partial,
    runsInMode: partial.runnable ? mode : elsewhere && !mapModes.has(mode) ? otherMode : null,
  });

  const answered = Boolean(here && here.state !== 'unknown');

  // Two questions were being conflated here, and only one of them needs the
  // network.
  //
  //   "Is there a workflow for this capability at all?" — a *family* question,
  //   which a live map answers on its own. It arrives with the model list, in
  //   the same `Promise.all`, so it is already in hand on the first paint.
  //
  //   "There is one; can this machine run it?" — a *setup* question, which only
  //   the per-model probe can answer.
  //
  // Waiting on the probe to answer the first question is what produced the
  // reported flash: six tiles painted, then three removed a moment later by a
  // request whose answer changed nothing. When the map alone proves this model
  // cannot do the job we are asking for, that is a settled verdict — hide it on
  // the first paint, before the probe that was never needed comes back.
  //
  // Only a live map may do this. A failed `GET /workflows` is an empty map that
  // proves nothing, and must still hide nothing at all.
  if (readiness.loading && !answered && capabilities.live) {
    if (kinds.length === 0)
      return entry({ runnable: false, hidden: 'no-template', blocked: null });
    if (!mapModes.has(mode))
      return entry({ runnable: false, hidden: 'other-mode', blocked: null });
  }

  // Everything the map could not settle stays undecided until the probe lands.
  // This was once described as "only a badge, so it can arrive late", and that
  // was the mistake behind the reload jump: a `no-template` answer here still
  // *hides* the model (Hunyuan under Video with no graph installed), so an entry
  // that is pending is one whose presence is undecided too. Callers must not
  // draw a partition while `pending` is true.
  if (readiness.loading && !answered) {
    return entry({ runnable: false, hidden: null, blocked: null, pending: true });
  }

  if (here && here.state !== 'unknown') {
    if (here.state === 'ready') return entry({ runnable: true, hidden: null, blocked: null });
    // The workflow exists and the machine is not set up for it. Kept, with its
    // reason: this is the state with a fix.
    if (here.state === 'blocked')
      return entry({ runnable: false, hidden: null, blocked: 'needs-setup' });
    // no-template, but not necessarily impossible *here*. SVD is the case: its
    // family offers img2vid and nothing else, so a txt2vid probe answers "no
    // template" quite truthfully — and concluding "video model, wrong tab" from
    // that is wrong twice over. It is a video model, under Video; what it wants
    // is a starting image, which is one drag away. The map is what knows the
    // difference, so ask it before hiding.
    if (
      mapModes.has(mode) &&
      kinds.some((candidate) => candidate.startsWith('img2') && modeOfKind(candidate) === mode)
    ) {
      return entry({ runnable: false, hidden: null, blocked: 'needs-image' });
    }

    // Genuinely impossible here. Which of the two hidden reasons it is depends
    // on whether the other tab would run it.
    return entry({
      runnable: false,
      hidden: elsewhere ? 'other-mode' : 'no-template',
      blocked: null,
    });
  }

  // ---- readiness could not be asked (or was never asked): the family map.
  if (kinds.includes(kind)) return entry({ runnable: true, hidden: null, blocked: null });

  if (kinds.length > 0) {
    if (!mapModes.has(mode))
      return entry({ runnable: false, hidden: 'other-mode', blocked: null });
    // Same mode, other side of the txt2*/img2* split.
    const needsInit = kinds.some((candidate) => candidate.startsWith('img2'));
    return entry({
      runnable: false,
      hidden: null,
      blocked: needsInit ? 'needs-image' : 'no-template',
    });
  }

  // Nothing known about the family at all — and for a *named* family that the
  // server's own list does not carry, that is a real absence worth acting on.
  // An empty or failed map (`live: false`) is not, and never hides anything.
  return capabilities.live
    ? entry({ runnable: false, hidden: 'no-template', blocked: null })
    : entry({ runnable: false, hidden: null, blocked: 'no-template' });
}

export function partitionModels(
  models: Model[],
  kind: JobKind,
  capabilities: CapabilityMap,
  readiness: ReadinessMap,
): Partition {
  const entries = models.map((model) => classify(model, kind, capabilities, readiness));
  const listed = entries.filter((entry) => entry.hidden === null);
  const hidden = entries.filter((entry) => entry.hidden !== null);

  return {
    listed,
    hidden,
    pending: entries.some((entry) => entry.pending),
    runnable: listed.filter((entry) => entry.runnable),
    hiddenNoTemplate: hidden.filter((entry) => entry.hidden === 'no-template'),
    hiddenOtherMode: hidden.filter((entry) => entry.hidden === 'other-mode'),
    otherMode: entries.filter((entry) => entry.runsInMode !== null && !entry.runnable),
  };
}

/** Is this model one the picker will draw? Used for selection repair. */
export function isListed(
  modelId: string | null,
  partition: Partition,
): boolean {
  if (!modelId) return false;
  return partition.listed.some((entry) => entry.model.id === modelId);
}
