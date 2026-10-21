/**
 * Will this job run on this machine? Answered from what that machine has
 * already done, not from what it says about itself.
 *
 * ## Why it has to be empirical
 *
 * The README's note on the reported VRAM figure ends: "The durable fix is
 * empirical: learning each backend's real ceiling from observed job outcomes,
 * which is the only approach correct on every vendor." This is that.
 *
 * The alternative — compare an estimated requirement against `vram_total` — is
 * the thing that module warns against, twice over. `/system_stats` may be
 * describing a different device than the one that will run the job, and even on
 * the right card ROCm and unified memory pool host RAM into the total, so the
 * figure is a budget and not a size. A predictor built on it is confidently
 * wrong on exactly the hardware this project runs on.
 *
 * What a machine cannot lie about is what it already did.
 *
 * ## The model: two brackets, and honest ignorance between them
 *
 * Every finished job leaves one observation on its backend: a score from
 * `cost.ts`, and whether it completed or died out of memory. From those:
 *
 *   ceiling  = the largest score that has ever SUCCEEDED here
 *   floor    = the smallest score that has ever run OUT OF MEMORY here
 *
 * A new job's score lands in one of four places:
 *
 *   <= ceiling            `fits`     — something this big has run here before
 *   >= floor              `too-big`  — something this small has already failed
 *   between the two       `unproven` — genuinely unknown, and we say so
 *   no observations yet   `unknown`  — nothing learned about this machine
 *
 * Note `ceiling` and `floor` can cross: a 9 GB job succeeded on Monday and an
 * 8 GB one failed on Tuesday, because another process had the card. Real
 * machines do that. When they cross, the *failure* wins and the verdict is
 * `unproven` rather than `fits` — the evidence is genuinely contradictory and
 * the one thing we must not do is promise it will work.
 *
 * ## Why it degrades well
 *
 * With no data every answer is `unknown`, which callers render as no warning at
 * all — precisely today's behaviour, so shipping this makes nothing worse. The
 * first OOM teaches a floor. The first big success teaches a ceiling. The
 * bracket tightens with use and never needs a person to configure it.
 *
 * Scores are only ever compared **within one backend**. `cost.ts` is an
 * ordering with arbitrary constants, so a score from one machine means nothing
 * on another, and nothing here ever mixes them.
 */

import type { Uuid } from '@comfy/shared';
import { query } from '../db.js';

export type FitVerdict = 'fits' | 'unproven' | 'too-big' | 'unknown';

export interface FitAssessment {
  verdict: FitVerdict;
  /** Largest score known to have succeeded here, or null if none has. */
  ceiling: number | null;
  /** Smallest score known to have run out of memory here, or null if none has. */
  floor: number | null;
  /** How many finished jobs this machine has taught us. */
  observations: number;
  /** One sentence, or null when there is nothing worth saying. */
  note: string | null;
}

/** What one backend has taught us, as two numbers and a count. */
export interface FitEvidence {
  ceiling: number | null;
  floor: number | null;
  observations: number;
}

export const NO_EVIDENCE: FitEvidence = { ceiling: null, floor: null, observations: 0 };

/**
 * Decide, from evidence alone. Pure, so the whole decision table is testable
 * without a database.
 */
export function assess(score: number, evidence: FitEvidence): FitAssessment {
  const { ceiling, floor, observations } = evidence;
  const base = { ceiling, floor, observations };

  if (observations === 0) {
    return { ...base, verdict: 'unknown', note: null };
  }

  // A failure at or below this size is the strongest thing we hold, so it is
  // checked first: contradictory evidence must never read as "fits".
  if (floor !== null && score >= floor) {
    return {
      ...base,
      verdict: 'too-big',
      note: 'A job this size has already run out of memory on this machine.',
    };
  }

  if (ceiling !== null && score <= ceiling) {
    return {
      ...base,
      verdict: 'fits',
      note: null,
    };
  }

  return {
    ...base,
    verdict: 'unproven',
    note: 'This is larger than anything this machine has finished so far. It may run out of memory.',
  };
}

/**
 * Read one backend's brackets.
 *
 * Both halves come from `jobs`, so there is no second table to keep in step and
 * no write path that can silently stop running — a job that finished is the
 * observation, and the only thing this needed was for the score to be recorded
 * on the row when it was dispatched.
 *
 * `oom` is the classifier's verdict, stored at failure time rather than
 * re-derived here: the message is the backend's and could change under us, and
 * a ceiling that shifts because we edited a regex would be a bad surprise.
 */
export async function evidenceFor(backendId: Uuid): Promise<FitEvidence> {
  const rows = await query<{ ceiling: string | null; floor: string | null; observations: string }>(
    `SELECT max(size_score) FILTER (WHERE status = 'complete')            AS ceiling,
            min(size_score) FILTER (WHERE status = 'failed' AND oom)      AS floor,
            count(*)                                                      AS observations
       FROM jobs
      WHERE backend_id = $1
        AND size_score IS NOT NULL
        AND (status = 'complete' OR (status = 'failed' AND oom))`,
    [backendId],
  );
  const row = rows[0];
  if (!row) return NO_EVIDENCE;
  return {
    ceiling: row.ceiling === null ? null : Number(row.ceiling),
    floor: row.floor === null ? null : Number(row.floor),
    observations: Number(row.observations),
  };
}

/** Assess one job against one backend, in a single call. */
export async function assessOn(backendId: Uuid, score: number): Promise<FitAssessment> {
  return assess(score, await evidenceFor(backendId));
}
