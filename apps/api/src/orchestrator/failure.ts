/**
 * What a backend's failure message actually means.
 *
 * ## Why a classifier rather than passing the text through
 *
 * ComfyUI hands back an exception message from deep inside PyTorch, and the
 * orchestrator has always stored it verbatim. For the one failure that happens
 * most on a card too small for the job, that reads:
 *
 *   KSampler failed: HIP out of memory. Tried to allocate 2.44 GiB. GPU 0 has a
 *   total capacity of 15.98 GiB of which 1.02 GiB is free. Of the allocated
 *   memory 13.79 GiB is allocated by PyTorch, and 412.00 MiB is reserved by
 *   PyTorch but unallocated...
 *
 * That is a true sentence that tells the person who wrote a prompt nothing they
 * can act on. Worse, it is the *same* event every time and we were learning
 * nothing from it: the one fact this project has said out loud it needs —
 * "learning each backend's real ceiling from observed job outcomes", per the
 * README's note on the reported VRAM figure — is exactly an out-of-memory
 * classification plus the size of the job that caused it.
 *
 * So failures are classified into a small closed set. Two things hang off that:
 * the user gets a sentence about their own job, and `fit.ts` gets a signal it
 * can put on a scale.
 *
 * ## The rules are deliberately dumb
 *
 * Substring matching on the message, in a fixed order, first match wins. No
 * attempt to parse the numbers out of the allocator's report: those are in
 * different units and shapes per vendor and per torch version, and a parser
 * that is wrong about them is worse than one that does not try. What we need
 * from the message is *which kind of failure*, and the size of the job is
 * something we computed ourselves before dispatching it.
 *
 * Unknown is a real answer and the common case for anything novel. It carries
 * the original text through unchanged, because a message we cannot classify is
 * still the best thing we have to show.
 */

import type { JobFailure } from '@comfy/shared';

/** The closed set. `unknown` is not a failure of this module, it is an answer. */
export type FailureKind =
  | 'out-of-memory'
  | 'missing-model'
  | 'missing-node'
  | 'bad-value'
  | 'cancelled'
  | 'backend-unreachable'
  | 'unknown';

export interface ClassifiedFailure {
  kind: FailureKind;
  /** One sentence about *this* job, in the second person. Never the raw text. */
  summary: string;
  /** What the person could do about it. Empty when there is nothing honest to say. */
  steps: string[];
  /** The backend's own words, kept whole. Shown under a disclosure, never lost. */
  detail: string;
  /**
   * True when the job failed for want of memory on that machine — the signal
   * `fit.ts` records against the backend. Kept as its own flag rather than
   * making every caller compare against the string.
   */
  outOfMemory: boolean;
}

interface Rule {
  kind: FailureKind;
  /** Matched case-insensitively against the whole message. */
  needles: readonly string[];
  summary: string;
  steps: readonly string[];
}

/**
 * Order matters: the first match wins.
 *
 * Out-of-memory is first because its message often also contains words that
 * later rules look for — an allocator report names the node that was running,
 * and "failed to load" appears in some of them.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'out-of-memory',
    // Three vendors and two spellings each. `allocate` on its own is too broad;
    // every needle here is anchored on a phrase only an allocator emits.
    needles: [
      'out of memory',
      'outofmemory',
      'cuda_error_out_of_memory',
      'hip_error_out_of_memory',
      'allocation on device',
      'failed to allocate memory',
      'insufficient memory',
      'mps backend out of memory',
    ],
    summary: 'The machine ran out of graphics memory part-way through this job.',
    steps: [
      'Make the clip shorter, or drop the resolution one step.',
      'Turn on system memory for this machine so large models can spill into RAM. It is slower, but it finishes.',
    ],
  },
  {
    kind: 'missing-model',
    needles: [
      // ComfyUI's own validator writes `<input>: '<value>' not in [<options>]`,
      // so the bracket is the reliable part — "not in list" is the *type* name
      // in the JSON, not the sentence, and matching that instead found nothing.
      // This is the real string off a 400 from the reference backend.
      'not in [',
      'value_not_in_list',
      'no such file or directory',
      'errno 2',
      'unable to find',
      'could not find the model',
      'safetensorerror',
      'header too large',
    ],
    summary: 'A file this workflow needs is not on that machine, or cannot be read.',
    steps: [
      'Open the model on the Models screen — it names the exact file and folder.',
    ],
  },
  {
    kind: 'missing-node',
    needles: [
      'does not exist',
      'unknown node type',
      'node type not found',
      'is not a valid node',
    ],
    summary: 'That machine does not have a custom node this workflow needs.',
    steps: [
      'Custom nodes have to be installed on the machine itself. No model download fixes this.',
    ],
  },
  {
    kind: 'bad-value',
    needles: [
      'value not in range',
      'invalid value',
      'must be divisible',
      'size mismatch',
      'shape mismatch',
      'expected size',
    ],
    summary: 'The backend refused one of this job’s settings.',
    steps: ['Try the same prompt at a preset resolution and length.'],
  },
  {
    kind: 'cancelled',
    needles: ['interrupted', 'execution was cancelled', 'keyboardinterrupt'],
    summary: 'The job was stopped before it finished.',
    steps: [],
  },
  {
    kind: 'backend-unreachable',
    needles: [
      'econnrefused',
      'econnreset',
      'etimedout',
      'ehostunreach',
      'socket hang up',
      'fetch failed',
      'network error',
    ],
    summary: 'rippel lost contact with that machine while the job was running.',
    steps: [
      'Check the machine is awake and the engine is running, then try again.',
    ],
  },
];

/**
 * Classify one failure message.
 *
 * `detail` is always the input, trimmed — including for `unknown`, which is how
 * a message we have no rule for still reaches the person who can read it.
 */
export function classifyFailure(message: string | null | undefined): ClassifiedFailure {
  const detail = (message ?? '').trim();
  const haystack = detail.toLowerCase();

  for (const rule of RULES) {
    if (!rule.needles.some((needle) => haystack.includes(needle))) continue;
    return {
      kind: rule.kind,
      summary: rule.summary,
      steps: [...rule.steps],
      detail,
      outOfMemory: rule.kind === 'out-of-memory',
    };
  }

  return {
    kind: 'unknown',
    // Not "something went wrong": the backend said something, and the honest
    // move is to hand it over rather than replace it with a shrug.
    summary: detail
      ? 'The backend reported an error.'
      : 'The job failed and the backend gave no reason.',
    steps: [],
    detail,
    outOfMemory: false,
  };
}

/** Did this job die for want of memory? The one question `fit.ts` asks. */
export function isOutOfMemory(message: string | null | undefined): boolean {
  return classifyFailure(message).outOfMemory;
}

/**
 * The wire shape. `outOfMemory` is dropped on purpose: it is a flag for the fit
 * ledger, and a client that wanted it can read `kind`.
 */
export function toJobFailure(failure: ClassifiedFailure): JobFailure {
  return {
    kind: failure.kind,
    summary: failure.summary,
    steps: failure.steps,
    detail: failure.detail,
  };
}
