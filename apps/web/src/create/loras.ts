/**
 * Which extra styles fit the checkpoint you have chosen.
 *
 * A LoRA is trained against one model family. Running an SD 1.5 LoRA on an
 * SDXL checkpoint does not produce a worse picture, it produces noise — the
 * tensor shapes do not line up — so an "add a style" list that offers every
 * installed file is offering mostly broken choices.
 *
 * The rule is the one `visibility.ts` settled for checkpoints, applied here:
 * **hide what is impossible, keep and explain what is merely unknown.**
 *
 *   fits       both families are known and fold to the same key. Offered first.
 *   unknown    one side or the other has no `baseModel`. Almost every locally
 *              discovered file is in this state — nothing has read metadata off
 *              it — so hiding these would empty the list on a normal install.
 *              Kept, marked, and left to the user, who can see the filename.
 *   mismatch   both families are known and differ. Impossible; hidden behind
 *              the same honest "N hidden" reveal the model grid uses, because
 *              a list that silently omits a file you installed is lying about
 *              what is on the machine.
 *
 * No checkpoint chosen yet means nothing is known to mismatch, so everything is
 * `unknown` rather than everything being hidden.
 */
import type { LoraSelection, Model } from '@comfy/shared';
import { normalizeFamily } from '../lib/api-jobs';

export type LoraFit = 'fits' | 'unknown' | 'mismatch';

export interface LoraEntry {
  model: Model;
  fit: LoraFit;
  /** The style's own family, title-cased for display, or null. */
  family: string | null;
}

export interface LoraPartition {
  /** Offered in the picker, best fit first. */
  offered: LoraEntry[];
  /** Trained for another family. Behind the reveal. */
  hidden: LoraEntry[];
  /** Of `offered`, how many are a known match — for the empty-state wording. */
  fitting: number;
}

/** One style against one checkpoint. */
export function fitOf(lora: Model, checkpoint: Model | null | undefined): LoraFit {
  const here = lora.baseModel ? normalizeFamily(lora.baseModel) : '';
  const there = checkpoint?.baseModel ? normalizeFamily(checkpoint.baseModel) : '';
  if (!here || !there) return 'unknown';
  return here === there ? 'fits' : 'mismatch';
}

/**
 * Split the installed styles for a given checkpoint.
 *
 * Already-chosen styles are dropped: the picker adds, and the stack below it is
 * where a chosen one lives. Ordering inside `offered` is fits-then-unknown, and
 * alphabetical within each, so the list does not reshuffle as families load.
 */
export function partitionLoras(
  loras: Model[],
  checkpoint: Model | null | undefined,
  chosen: readonly LoraSelection[] = [],
): LoraPartition {
  const taken = new Set(chosen.map((selection) => selection.modelId));
  const entries = loras
    .filter((model) => !taken.has(model.id))
    .map((model) => ({
      model,
      fit: fitOf(model, checkpoint),
      family: model.baseModel ?? null,
    }));

  const byName = (a: LoraEntry, b: LoraEntry) =>
    a.model.displayName.localeCompare(b.model.displayName);

  const fits = entries.filter((entry) => entry.fit === 'fits').sort(byName);
  const unknown = entries.filter((entry) => entry.fit === 'unknown').sort(byName);
  const mismatch = entries.filter((entry) => entry.fit === 'mismatch').sort(byName);

  return { offered: [...fits, ...unknown], hidden: mismatch, fitting: fits.length };
}

/** Case-insensitive substring match over the name and the family. */
export function matchesQuery(entry: LoraEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    entry.model.displayName.toLowerCase().includes(needle) ||
    (entry.family ?? '').toLowerCase().includes(needle)
  );
}
