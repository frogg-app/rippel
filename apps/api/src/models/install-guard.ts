/**
 * The one guard every model download passes, whoever started it.
 *
 * A download reaches a machine in exactly two ways, and both are guarded here:
 *
 *  - a `model_installs` row (Discover, the version picker, readiness, "Get a
 *    version that works", companions, workflow suggestions, retries): checked
 *    when the row is created (`createInstall`) and again when it is handed to
 *    its transport (`dispatchInstall`), which also covers rows queued or
 *    waiting from before this check existed;
 *  - a `model_operations` download step (the agent transport, Fix, workflow
 *    library installs): checked when the plan is made (`planOperation`) and
 *    again when the step is sent to the agent (`dispatchStep`).
 *
 * `install-guard.test.ts` greps the source so a new way of writing either
 * record, or of sending a download, that skips these fails CI.
 *
 * Policy:
 *  - `diffusers` (no ComfyUI loader reads it): refused, before any bytes move.
 *  - `unknown` for a readable safetensors URL (the header read failed or timed
 *    out): read once more with a short budget; if still unknown, allowed, and
 *    read again once the file has landed (`checkDownloaded`). If it is
 *    unloadable then, the install fails with `UNLOADABLE_REASON` and is never
 *    shown as runnable.
 *  - anything else — `.gguf`, `.ckpt`, `.pt`, `.pth`, `.bin`, or a URL that is
 *    not a Hugging Face file — has no safetensors header to read and is
 *    allowed. A wrong guess there is answered by ComfyUI at run time; a refusal
 *    we cannot justify would block files that load fine.
 */
import { layoutForUrl, probeable } from './url-layout.js';
import type { WeightsLayout } from './weights-layout.js';

/** The one line a person reads, in the UI and on a failed install. */
export const UNLOADABLE_REASON = 'This file won’t run in ComfyUI.';

export class UnloadableFile extends Error {
  constructor(readonly url: string) {
    super(UNLOADABLE_REASON);
    this.name = 'UnloadableFile';
  }
}

/** A short budget: this sits in front of a button press. */
const GUARD_BUDGET_MS = 4_000;
/** A failed read this old is tried again rather than trusted as "unknown". */
const GUARD_RETRY_AFTER_MS = 30_000;
/** After a download there is nobody waiting on a button. */
const AFTER_BUDGET_MS = 20_000;

/** Test seam. */
export const installGuardDeps = {
  layout: layoutForUrl,
};

async function layoutOf(url: string, budgetMs: number, retryAfterMs: number): Promise<WeightsLayout> {
  try {
    return await installGuardDeps.layout(url, budgetMs, retryAfterMs);
  } catch {
    return 'unknown';
  }
}

/**
 * Throws `UnloadableFile` when the file at `url` is known not to load.
 * Resolves with what was learnt otherwise (`unknown` included).
 */
export async function assertInstallable(url: string | null | undefined): Promise<WeightsLayout> {
  if (!probeable(url)) return 'unknown';
  const layout = await layoutOf(url, GUARD_BUDGET_MS, GUARD_RETRY_AFTER_MS);
  if (layout === 'diffusers') throw new UnloadableFile(url);
  return layout;
}

/** Every download step of a file-operation plan, in order. */
export async function assertStepsInstallable(steps: readonly { kind: string; request: unknown }[]): Promise<void> {
  for (const step of steps) {
    if (step.kind !== 'download') continue;
    await assertInstallable((step.request as { url?: string }).url);
  }
}

/** After the download: true when the file turned out to be unloadable. */
export async function unloadableAfterDownload(url: string | null | undefined): Promise<boolean> {
  if (!probeable(url)) return false;
  return (await layoutOf(url, AFTER_BUDGET_MS, 0)) === 'diffusers';
}
