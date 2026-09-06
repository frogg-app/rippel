/**
 * Handing a library asset back to the Create screen.
 *
 * Re-run and Remix are the same navigation with one bit different, so they are
 * one payload with a `mode`:
 *
 *   re-run  reproduce this image exactly — same params, same seed
 *   remix   start from this image's settings and change something — same
 *           params, but a fresh seed, because a remix that re-rolls nothing
 *           produces the identical picture and looks broken
 *   animate jump to video mode with this image as the first frame (the
 *           artboard's third button; PLAN.md §6 makes it an action on every
 *           image)
 *
 * ---------------------------------------------------------------------------
 * THE NAVIGATION CONTRACT WITH THE CREATE SCREEN
 * ---------------------------------------------------------------------------
 * Library navigates with react-router:
 *
 *   navigate('/create', { state: { prefill: CreatePrefill } })
 *
 * and Create reads it with `useLocation().state`. Two things Create must do,
 * neither of which Library can do for it:
 *
 *  - Treat the state as *untyped input*. Browser history survives a reload and
 *    a deploy, so a `prefill` from an older build can arrive at a newer Create.
 *    `isCreatePrefill()` below is exported for exactly that check; anything
 *    that fails it should be ignored, not crashed on.
 *  - Clear it once consumed — `navigate(location.pathname, { replace: true })`
 *    — or the prefill reapplies every time the user comes back with the back
 *    button and silently discards edits they have made since.
 *
 * `params` is the whole `GenerationParams` the job ran with, so Create never
 * has to reconstruct anything: whatever it knows how to render, it can read
 * straight out. `sourceAssetId` is separate from `params.references` on
 * purpose — it says which *tile* was clicked, which is what "Animate this one"
 * means when a job produced a batch of four.
 */
import type { GenerationParams, Uuid } from '@comfy/shared';
import type { LibraryAsset, LibraryJob } from '../lib/api-library';

export type PrefillMode = 're-run' | 'remix' | 'animate';

export interface CreatePrefill {
  /** Version tag, so a stale history entry from an older build is detectable. */
  v: 1;
  mode: PrefillMode;
  /** The exact parameters to load into the panel. */
  params: GenerationParams;
  /** The asset the user acted on — the frame for `animate`, provenance otherwise. */
  sourceAssetId: Uuid;
  /** The job it came from, so Create can show "remixing an earlier render". */
  sourceJobId: Uuid | null;
}

/** The state object handed to `navigate('/create', { state })`. */
export interface CreateNavState {
  prefill: CreatePrefill;
}

export function buildPrefill(
  mode: PrefillMode,
  asset: LibraryAsset,
  job: LibraryJob | null,
): CreatePrefill | null {
  // Without the originating job there are no parameters to prefill, and the
  // buttons that call this are disabled in that case.
  if (!job) return null;

  const params: GenerationParams = { ...job.params };

  if (mode === 're-run') {
    // Re-run means *this picture again*. The stored params carry a null seed
    // whenever the user left it random, so pin the seed the compiler actually
    // rolled — otherwise "re-run" quietly means "roll again".
    params.advanced = { ...params.advanced, seed: job.seed, seedLocked: true };
  } else {
    // Remix and animate both re-roll: same recipe, different draw.
    params.advanced = { ...params.advanced, seed: null, seedLocked: false };
  }

  if (mode === 'animate') {
    params.kind = 'img2vid';
    params.video = {
      lengthSeconds: 4,
      fps: 24,
      motion: 127,
      ...params.video,
      firstFrame: { from: 'asset', assetId: asset.id },
    };
  }

  return {
    v: 1,
    mode,
    params,
    sourceAssetId: asset.id,
    sourceJobId: job.id,
  };
}

/**
 * The guard Create should run over `location.state` before trusting it.
 * Exported from here so both sides read the same definition of "valid".
 */
export function isCreatePrefill(value: unknown): value is CreatePrefill {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CreatePrefill>;
  return (
    candidate.v === 1 &&
    (candidate.mode === 're-run' || candidate.mode === 'remix' || candidate.mode === 'animate') &&
    typeof candidate.params === 'object' &&
    candidate.params !== null &&
    typeof candidate.sourceAssetId === 'string'
  );
}
