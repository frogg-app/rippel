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
 *   shown    pending — the readiness probe is still in flight. No verdict is
 *            drawn at all: no badge, no dimming, nothing hidden and no count.
 *            A wrong label followed by a correction is worse than a moment of
 *            plain tiles.
 *   shown    needs a starting image — same family, other side of the
 *            txt2img / img2img split. Also fixable, in one drag.
 *
 * And the rule that outranks all of them: **never hide on `unknown`**. An
 * unreachable API must not make somebody's models disappear. When readiness
 * could not be asked we fall back to the capability map, and even then we only
 * hide a family with no known capabilities if that map came from the server
 * (`live`) — the hardcoded fallback mirror in `api-jobs.ts` knows one family
 * and is not evidence of absence.
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
  /** True while any listed model is still waiting on a verdict. */
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

  // Nothing is decided until the probe lands. The client-side capability map
  // below is a hardcoded mirror that knows one family, so consulting it in the
  // meantime does not produce a provisional answer — it produces a wrong one.
  if (readiness.loading && !(here && here.state !== 'unknown')) {
    return entry({ runnable: false, hidden: null, blocked: null, pending: true });
  }

  if (here && here.state !== 'unknown') {
    if (here.state === 'ready') return entry({ runnable: true, hidden: null, blocked: null });
    // The workflow exists and the machine is not set up for it. Kept, with its
    // reason: this is the state with a fix.
    if (here.state === 'blocked')
      return entry({ runnable: false, hidden: null, blocked: 'needs-setup' });
    // no-template: impossible here. Which of the two hidden reasons it is
    // depends on whether the other tab would run it.
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

  // Nothing known about the family at all. Only the server's own capability
  // list is grounds for hiding; the hardcoded fallback mirror is not.
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
