/**
 * The Advanced drawer.
 *
 * Extra styles (LoRA) used to live here and no longer do — see
 * `LoraSection.tsx`. Advanced is for overriding what the quality preset chose;
 * a LoRA overrides nothing, it is a creative choice like the prompt, so it has
 * its own section in the panel.
 *
 * Two rules govern everything here.
 *
 * The first is behavioural and load-bearing: opening this drawer must never
 * change the result. Every control starts at the value the chosen quality
 * preset would have used, a control the user has not touched stays `null` in
 * form state and is *omitted* from the request, and the server applies the
 * preset itself. Touching one pins it; "Use preset" gives it back.
 *
 * The second is editorial, and is why this file does not read like a settings
 * list. "cfg 7.0 / 28 steps / dpmpp_2m / karras" is four pieces of jargon that
 * happen to look like data. None of them say what they do, so the only way to
 * learn one is to change it and regenerate — a minute a go, on one GPU, for
 * people who did not ask to learn about diffusion. So each control is written
 * as the question it answers:
 *
 *   guidance  -> "How closely should it follow your prompt?"  loose … literal
 *   steps     -> "How much detail — and how long are you willing to wait?"
 *   seed      -> "The dice roll", with the only reason to care: repeatability.
 *
 * and carries three things a raw number cannot: a word for the value now, the
 * consequence of moving it, and the ends of the rail named so "more" has a
 * direction before you drag it.
 *
 * Each hint is written to answer a different question, and to say what the
 * *number* is, not only which way is better. They used to be read as "all
 * saying the same thing" — more of this is more, less is less — which was fair:
 * none of them said what a step, a guidance value or a sampler actually was.
 * The distinct parts are composed here rather than in `form.ts`'s readings,
 * which stay responsible for the per-band sentence.
 *
 * "Steps" gets one extra sentence because of a real confusion: the Extra styles
 * section sits just above this drawer, and speed-up styles are named `4step`,
 * `8step`. A step is a pass of the sampler, not a style, and the hint says so.
 *
 * Sampler and scheduler are different in kind: there is no outcome sentence
 * that is both true and useful to a beginner, and nobody who needs this drawer
 * needs those two. They live behind a second disclosure marked as expert, off
 * by default, owned by the quality preset — which is exactly what they were
 * already, only now the screen says so.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { QualityPreset } from '@comfy/shared';
import { ChevronDownIcon } from '../components/icons';
import { Hint, IconButton, Row, Select, Slider } from './Controls';
import { DiceIcon, LockIcon, UnlockIcon } from './icons';
import {
  type AdvancedState,
  PRESET_DEFAULTS,
  QUALITY_LABELS,
  formatSeed,
  guidanceReading,
  overrideCount,
  randomSeed,
  resetAdvanced,
  samplerOptions,
  schedulerOptions,
  stepsReading,
} from './form';
import styles from './advanced.module.css';

/**
 * What each number *is*, appended to the band sentence from `form.ts`.
 *
 * Constants rather than inline strings so a reader can see all four side by
 * side and check they do not repeat each other, which is the failure the user
 * reported.
 */
const GUIDANCE_MEANING =
  'The number is guidance (often called CFG): how hard each step is pushed towards your words ' +
  'rather than what the model would draw unprompted. Speed-up styles are usually built for ' +
  'guidance near 1.';

const STEPS_MEANING =
  'A step is one pass in which the model clears a little noise from the picture; this is how many ' +
  'passes it gets. It is nothing to do with Extra styles — except that a speed-up style named ' +
  'something like "4step" or "lightning" is built for a count that low.';

const SAMPLER_MEANING =
  'The method for working out each step from the one before. The note after each name says how it ' +
  'tends to behave; the "SDE" and "ancestral" ones add fresh randomness every step, so adding steps ' +
  'keeps changing the picture instead of only refining it.';

const SCHEDULER_MEANING =
  'How the noise removal is shared out across the steps — mostly early, or evenly. It matters most ' +
  'at low step counts, which is why speed-up models are often paired with SGM uniform.';

export function AdvancedDrawer({
  open,
  onOpenChange,
  quality,
  batchSize,
  value,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quality: QualityPreset;
  /**
   * How many images this run makes. The Detail slider quotes a time, and a
   * time that ignores the batch would be wrong by up to eight times over.
   */
  batchSize: number;
  value: AdvancedState;
  onChange: (next: AdvancedState) => void;
}) {
  const bodyId = useId();
  const preset = PRESET_DEFAULTS[quality];
  const changed = overrideCount(value);
  const set = <K extends keyof AdvancedState>(key: K, next: AdvancedState[K]) =>
    onChange({ ...value, [key]: next });

  const guidance = value.guidance ?? preset.guidance;
  const guidanceWords = guidanceReading(guidance);
  const steps = value.steps ?? preset.steps;
  const stepsWords = stepsReading(steps, batchSize);

  // Opening the drawer at the bottom of a scrolled panel used to reveal only
  // its head, with the controls below the fold. Once the body has mounted,
  // bring the whole card up into view — but only after a *click*. The open
  // state persists, and a page that scrolls itself on load is disorienting;
  // a "first render" guard is not enough because StrictMode rehearses effects
  // twice in dev and consumed it.
  const cardRef = useRef<HTMLElement>(null);
  const clicked = useRef(false);
  useEffect(() => {
    if (!open || !clicked.current) return;
    clicked.current = false;
    const card = cardRef.current;
    // jsdom has no scrollIntoView; the tests open this drawer constantly.
    if (!card || typeof card.scrollIntoView !== 'function') return;
    const frame = requestAnimationFrame(() => {
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <section className={styles.drawer} ref={cardRef}>
      <button
        type="button"
        className={open ? `${styles.head} ${styles.headOpen}` : styles.head}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          clicked.current = !open;
          onOpenChange(!open);
        }}
      >
        <span className={styles.headText}>
          <span className={styles.title}>Advanced</span>
          {/* The subtitle is the whole reason a nervous user can close this
              again: it says, before they touch anything, that they do not have
              to. */}
          <span className={styles.subtitle}>
            Optional — the quality preset sets these
          </span>
        </span>
        <span className={styles.headRight}>
          {changed > 0 ? (
            <span className={styles.overrides}>{changed} changed</span>
          ) : null}
          <ChevronDownIcon
            size={15}
            className={
              open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron
            }
          />
        </span>
      </button>

      {open ? (
        <div className={styles.body} id={bodyId}>
          {/* What is in force right now, in one line. Without it, a slider
              sitting at 28 is indistinguishable from one *pinned* at 28, and
              the difference is the whole contract of this drawer. */}
          <div className={styles.presetNote}>
            <p className={styles.presetText}>
              {changed === 0 ? (
                <>
                  Following the <strong>{QUALITY_LABELS[quality]}</strong>{' '}
                  preset.
                </>
              ) : (
                <>
                  {changed === 1 ? 'One setting' : `${changed} settings`} pinned;
                  the rest follow <strong>{QUALITY_LABELS[quality]}</strong>.
                </>
              )}
            </p>
            <button
              type="button"
              className={
                changed > 0
                  ? `${styles.resetAll} ${styles.resetAllOn}`
                  : styles.resetAll
              }
              onClick={() => onChange(resetAdvanced(value))}
              aria-hidden={changed === 0}
              tabIndex={changed > 0 ? 0 : -1}
            >
              Reset all
            </button>
          </div>

          <Slider
            reset={{
              active: value.guidance !== null,
              onReset: () => set('guidance', null),
              label: 'prompt faithfulness',
            }}
            label="Follow the prompt"
            min={1}
            max={20}
            step={0.5}
            value={guidance}
            reading={guidanceWords.word}
            display={guidance.toFixed(1)}
            ends={['1 · barely steered', '20 · forced']}
            valueText={`${guidanceWords.word}, ${guidance.toFixed(1)} of 20`}
            hint={`${guidanceWords.hint} ${GUIDANCE_MEANING}`}
            onChange={(next) => set('guidance', Number(next.toFixed(1)))}
          />

          <Slider
            reset={{
              active: value.steps !== null,
              onReset: () => set('steps', null),
              label: 'detail',
            }}
            label="Detail"
            min={1}
            max={80}
            value={steps}
            reading={stepsWords.word}
            display={`${steps} steps`}
            ends={['Fewer passes, faster', 'More passes, slower']}
            valueText={`${stepsWords.word}, ${steps} steps, ${stepsWords.hint}`}
            hint={`${stepsWords.hint} ${STEPS_MEANING}`}
            onChange={(next) => set('steps', next)}
          />

          <SeedControl value={value} onChange={onChange} />

          <ExpertSettings
            value={value}
            preset={preset}
            quality={quality}
            onChange={onChange}
          />
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- seed

/**
 * The seed.
 *
 * A seed is the one advanced control with no "better" direction — there is
 * nothing to tune, and a bigger number is not a better picture. Its entire
 * value is repeatability, so that is what this says, and the lock's *current
 * effect* is spelled out as a sentence rather than left to the reader to infer
 * from which of two padlock glyphs is lit. That sentence is also what makes
 * the state legible without relying on the accent colour alone.
 */
function SeedControl({
  value,
  onChange,
}: {
  value: AdvancedState;
  onChange: (next: AdvancedState) => void;
}) {
  const set = <K extends keyof AdvancedState>(key: K, next: AdvancedState[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <div className={styles.seedBlock}>
      <Row
        label="Starting number"
        hint="Every image starts from a dice roll, and this is the number that came up. The same number with the same prompt gives you the same picture again."
      >
        <span className={`mono ${styles.seed}`} data-testid="seed-value">
          {formatSeed(value.seed)}
        </span>
        <IconButton
          title="Roll a new starting number"
          onClick={() => set('seed', randomSeed())}
        >
          <DiceIcon size={14} />
        </IconButton>
        <IconButton
          title={
            value.seedLocked
              ? 'Seed locked — the next image reuses this number'
              : 'Lock the seed so the next image reuses this number'
          }
          on={value.seedLocked}
          onClick={() => set('seedLocked', !value.seedLocked)}
        >
          {value.seedLocked ? <LockIcon size={13} /> : <UnlockIcon size={13} />}
        </IconButton>
      </Row>
      {/* aria-live: the lock changes the meaning of Generate, and a padlock
          icon flipping is not announced. Read out, not shown — the padlock
          and its title carry the state on screen. */}
      <p className={styles.srOnly} aria-live="polite">
        {value.seedLocked
          ? 'Locked: the next image reuses this number, so anything you change is the only difference.'
          : 'Unlocked: a new number each time, so every Generate is a fresh image.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- expert

/**
 * Sampler and scheduler, behind a second door.
 *
 * These are the two controls with no honest beginner-facing explanation: what
 * they change is real but small, mostly a matter of texture, and the wrong
 * pairing at a low step count produces mush for reasons that take a paragraph.
 * A first-time user who opens Advanced should not have to scroll past them, and
 * should not have to wonder whether their picture is worse for having ignored
 * them. So the disclosure names them as expert, and names their owner: the
 * quality preset already picked a pair that works.
 */
function ExpertSettings({
  value,
  preset,
  quality,
  onChange,
}: {
  value: AdvancedState;
  preset: (typeof PRESET_DEFAULTS)[QualityPreset];
  quality: QualityPreset;
  onChange: (next: AdvancedState) => void;
}) {
  const [open, setOpen] = useState(
    () => value.sampler !== null || value.scheduler !== null,
  );
  const bodyId = useId();
  const set = <K extends keyof AdvancedState>(key: K, next: AdvancedState[K]) =>
    onChange({ ...value, [key]: next });

  const sampler = value.sampler ?? preset.sampler;
  const scheduler = value.scheduler ?? preset.scheduler;

  return (
    <div className={styles.expert}>
      <div className={styles.expertHeadRow}>
        <button
          type="button"
          className={styles.expertHead}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          <ChevronDownIcon
            size={13}
            className={
              open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron
            }
          />
          <span>Sampling method</span>
          <span className={styles.expertTag}>expert</span>
        </button>
        <Hint
          text={
            <>
              These two decide <em>how</em> each step is calculated, not how
              many steps there are. They change grain and fine texture rather
              than subject, and the <strong>{QUALITY_LABELS[quality]}</strong>{' '}
              preset already picks a pair that works. Nothing here is a mistake
              to leave alone.
            </>
          }
        />
      </div>

      {open ? (
        <div className={styles.expertBody} id={bodyId}>
          <Select
            reset={{
              active: value.sampler !== null,
              onReset: () => set('sampler', null),
              label: 'sampler',
            }}
            wide
            label="Sampler"
            value={sampler}
            options={samplerOptions(sampler)}
            description={SAMPLER_MEANING}
            onChange={(next) => set('sampler', next)}
          />

          <Select
            reset={{
              active: value.scheduler !== null,
              onReset: () => set('scheduler', null),
              label: 'noise schedule',
            }}
            wide
            label="Noise schedule"
            value={scheduler}
            options={schedulerOptions(scheduler)}
            description={SCHEDULER_MEANING}
            onChange={(next) => set('scheduler', next)}
          />
        </div>
      ) : null}
    </div>
  );
}
