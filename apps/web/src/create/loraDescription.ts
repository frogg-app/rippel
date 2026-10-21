/**
 * What one extra style (LoRA) actually is, said honestly.
 *
 * The complaint this exists for: a chosen style shows a filename and a slider,
 * and every explanation on the screen said the same generic thing — "a trained
 * look you mix on top of the model". True of all of them, therefore useful
 * about none of them. `lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16` is
 * not a look at all; its own name says it is distilled for fewer steps and
 * baked-in guidance, and applying it at the same settings as a film-grain LoRA
 * produces mush. That difference is the thing a user needs and never saw.
 *
 * ## The honesty rule, which is the whole design
 *
 * We have almost nothing to describe these with. `GET /api/models` returns
 * filename, display name, family, size and a preview URL for each installed
 * file — no description, no trigger words (see the note at the foot of this
 * file for what the server would have to add). The tempting fix is to write a
 * plausible sentence from the name. That is the one thing forbidden here: a
 * confident wrong description ("a soft painterly illustration style") costs a
 * user a GPU-minute and their trust, and is strictly worse than silence.
 *
 * So this module only ever states what a filename *literally supports*, every
 * such statement is labelled as coming from the filename in the UI, and when
 * the filename supports nothing it says so plainly rather than inventing.
 *
 * Concretely, two kinds of token are recognised and nothing else:
 *
 *   - **Mechanical conventions** — `2step`, `lightning`, `cfg_step_distill`,
 *     `rank64`, `bf16`, `I2V`, `480p`. These are naming conventions with one
 *     meaning across the whole ecosystem, and they are precisely the ones that
 *     change how the *other* controls must be set.
 *   - **Family words** — `sdxl`, `flux`, `wan`, and friends, and only when
 *     nothing recorded a family, where a hedged "probably" is better than the
 *     bare "family not recorded" the card shows today.
 *
 * Anything that looks like an artistic claim — `film`, `anime`, `krea`,
 * `portrait`, a person's name — is deliberately *not* recognised. A file called
 * `film_grain_xl` very probably is film grain, and "very probably" is not a
 * thing this UI is allowed to assert in a sentence a user will read as fact.
 * `describeLora` returns `unknown: true` for it, and the card says the filename
 * is all we know.
 *
 * `given` and `triggerWords` are already threaded through so that the day the
 * server carries real metadata, the component does not change: it prefers a
 * real description over any derivation, and derivations then become the
 * footnote they should be.
 */

/**
 * The descriptive facts a registry gave us for one file, if any ever do.
 *
 * Declared here rather than on the shared `Model` type because nothing serves
 * it yet and the shared types are not ours to widen. Both fields being empty is
 * the present-day reality on every install.
 */
export interface LoraFacts {
  /** Prose from a model page — HuggingFace or Civitai. Never generated. */
  description?: string | null;
  /** Words the LoRA was trained to respond to. Without these it may do nothing. */
  triggerWords?: readonly string[] | null;
}

/** The minimum of a model this module reads. Structural, so `Model` satisfies it. */
export interface LoraSubject {
  filename: string;
  displayName: string;
  baseModel: string | null;
}

export interface LoraDescription {
  /** A real description, when one exists. Shown in preference to everything else. */
  given: string | null;
  /** Trigger words, verbatim. */
  triggerWords: readonly string[];
  /**
   * Claims the filename itself supports, in reading order. Each one is shown
   * under an explicit "from the filename" attribution, because that is the
   * difference between a hint and a lie.
   */
  derived: readonly string[];
  /**
   * Nothing is known: no description, no trigger words, no recognised token.
   * The UI must say so rather than fill the space.
   */
  unknown: boolean;
  /**
   * True when the filename marks this as a speed/step-distillation LoRA, which
   * is the one case where choosing it *obliges* the user to change Advanced.
   * Surfaced separately so the card can put it where it will be read.
   */
  needsLowSteps: boolean;
  /** Steps the name asks for, when it names a number. */
  stepTarget: number | null;
}

/**
 * The haystack: filename and display name, folded for token matching.
 *
 * Separators become spaces before anything else, because `_` is a *word*
 * character to a regex: `\bi2v\b` does not match inside `lightx2v_I2V_14B`,
 * and every pattern below silently failing on the most common naming style is
 * exactly the bug this fold exists to prevent. The extension goes too, so
 * `.safetensors` cannot be read as a token.
 */
function haystack(subject: LoraSubject): string {
  const file = subject.filename.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, '');
  return `${file} ${subject.displayName}`.toLowerCase().replace(/[_\-.\/\\]+/g, ' ');
}

/**
 * Family words we are willing to read out of a name.
 *
 * Only consulted when `baseModel` is null. Getting this wrong is cheap — the
 * sentence is hedged and the compatibility line beside it still says the family
 * was not recorded — whereas the status quo ("family not recorded" and nothing
 * else) leaves a user with no way to guess which of their checkpoints it is for.
 */
const FAMILY_WORDS: readonly [RegExp, string][] = [
  [/\bsdxl\b/, 'SDXL'],
  [/\bsd ?15\b|\bsd ?1 5\b/, 'Stable Diffusion 1.5'],
  [/\bsd ?3\b/, 'Stable Diffusion 3'],
  [/\bflux\b/, 'FLUX'],
  [/\bwan\b|\bwan2/, 'Wan'],
  [/\bhunyuan\b/, 'Hunyuan'],
  [/\bltx\b|\bltxv\b/, 'LTX-Video'],
  [/\bqwen\b/, 'Qwen'],
  [/\bpony\b/, 'Pony'],
];

/** Speed/distillation naming conventions, and what each one is named for. */
const SPEED_WORDS: readonly [RegExp, string][] = [
  [/lightning/, 'lightning'],
  [/\bturbo\b/, 'turbo'],
  [/\blcm\b/, 'LCM'],
  [/\bhyper ?sd/, 'Hyper-SD'],
  [/\bdmd2?\b/, 'DMD'],
  [/distill/, 'distillation'],
];

/**
 * Read what the name will support, and stop there.
 *
 * The order of `derived` is the order a user needs it: what it is for, then
 * what it obliges them to change, then the bookkeeping tokens that are easy to
 * mistake for strength settings (rank, precision).
 */
export function describeLora(
  subject: LoraSubject,
  facts: LoraFacts = {},
): LoraDescription {
  const text = haystack(subject);
  const derived: string[] = [];

  const given = facts.description?.trim() ? facts.description.trim() : null;
  const triggerWords = (facts.triggerWords ?? []).filter((word) => word.trim().length > 0);

  // "2step", "4-step", "8 steps". The single most consequential token there is:
  // one of these run at the preset's 28 steps wastes three quarters of the time
  // and usually looks worse than not using it.
  const stepMatch = /(\d{1,2})[\s_-]?steps?\b/.exec(text);
  const stepTarget = stepMatch ? Number(stepMatch[1]) : null;

  const speed = SPEED_WORDS.find(([pattern]) => pattern.test(text));
  const needsLowSteps = stepTarget !== null || speed !== undefined;

  if (stepTarget !== null) {
    derived.push(
      `The name says ${stepTarget} step${stepTarget === 1 ? '' : 's'}. ` +
        'Step-distilled styles are built to finish in that many sampling steps — ' +
        `set Advanced → Detail to about ${stepTarget}. Left at the preset's usual count it ` +
        'wastes the time and often looks worse.',
    );
  } else if (speed) {
    derived.push(
      `The name mentions ${speed[1]}, which is how speed-up styles are labelled: ` +
        'they buy a much lower step count, not a look. Turn Advanced → Detail down.',
    );
  }

  // A CFG-distilled adapter has had guidance baked in. Run it at the preset's
  // 6.5 and it over-bakes; this is the other "you must change something" token.
  if (/cfg[\s_-]?(step[\s_-]?)?distill|\bcfg[\s_-]?free\b/.test(text)) {
    derived.push(
      'The name says CFG-distilled: guidance is baked in, so Advanced → Follow the ' +
        'prompt belongs near 1. Higher will over-bake the colours.',
    );
  }

  if (/\bi2v\b|image[\s_-]?to[\s_-]?video/.test(text)) {
    derived.push('The name says I2V — image-to-video, so it expects a starting image.');
  } else if (/\bt2v\b|text[\s_-]?to[\s_-]?video/.test(text)) {
    derived.push('The name says T2V — text-to-video, for clips generated from a prompt alone.');
  }

  const resolution = /\b(\d{3,4})p\b/.exec(text);
  if (resolution) {
    derived.push(
      `The name mentions ${resolution[1]}p, so it was probably trained at that size. ` +
        'Styles tend to be weaker well away from the size they were trained at.',
    );
  }

  // Rank and precision get a line each precisely *because* they look like
  // strength settings. rank64 is not "stronger than rank32"; it is a bigger file.
  const rank = /\brank[\s_-]?(\d{1,4})\b/.exec(text);
  if (rank) {
    derived.push(
      `Rank ${rank[1]} describes the size of the file, not how strong it is. ` +
        'It is the weight slider below that decides strength.',
    );
  }

  const precision = /\b(bf16|fp16|fp8(?:[\s_-]?e[45]m[23])?|fp32)\b/.exec(text);
  if (precision) {
    derived.push(
      `Stored in ${precision[1]} precision — a storage detail, with no effect on the look.`,
    );
  }

  // A file that calls itself a style without saying which. Worth saying out
  // loud: it is the difference between "we did not look" and "the name is empty".
  if (derived.length === 0 && /\bstyle\b/.test(text)) {
    derived.push(
      'The name calls this a style but does not say which one. Nothing here records ' +
        'what it looks like — the only way to find out is to run it.',
    );
  }

  if (subject.baseModel === null) {
    const family = FAMILY_WORDS.find(([pattern]) => pattern.test(text));
    if (family) {
      derived.push(
        `Nothing recorded which models this fits, but the name mentions ${family[1]}, ` +
          'so that is the likely family.',
      );
    }
  }

  return {
    given,
    triggerWords,
    derived,
    unknown: given === null && triggerWords.length === 0 && derived.length === 0,
    needsLowSteps,
    stepTarget,
  };
}

/**
 * What the server would have to add for any of this to become real prose.
 *
 * Everything above is a consolation prize. The data does exist:
 *
 *  - ComfyUI-Manager's catalogue carries a `description` per entry, and
 *    `ModelCatalogEntry.description` already reaches the API. It is dropped on
 *    the way to the browser because the bridge from an installed file to its
 *    catalogue row (`catalogueFacts` in `apps/api/src/routes/models.ts`) only
 *    copies `ModelCatalogInfo`, which has a licence, a download count and a
 *    picture but no description.
 *  - Trigger words exist only on Civitai, which answers 451 to this server —
 *    see `apps/api/src/models/metadata-sources.ts`. So they need either a
 *    reachable source or a field an operator can type into.
 *
 * The change is small and is not ours to make here: add `description` (and,
 * later, `triggerWords`) to `ModelCatalogInfo` and to the `Model` the Create
 * screen reads, then pass them into `describeLora` as `facts`. Nothing else in
 * this module or in `LoraSection` needs to move.
 */
export const DESCRIPTION_GAP =
  'Rippel holds no written description for installed styles yet — only the filename.';
