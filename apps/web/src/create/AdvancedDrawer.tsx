/**
 * The Advanced drawer.
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
 *   LoRA      -> "Extra styles", with a strength in words, not a number alone.
 *
 * and carries three things a raw number cannot: a word for the value now, the
 * consequence of moving it, and the ends of the rail named so "more" has a
 * direction before you drag it.
 *
 * Sampler and scheduler are different in kind: there is no outcome sentence
 * that is both true and useful to a beginner, and nobody who needs this drawer
 * needs those two. They live behind a second disclosure marked as expert, off
 * by default, owned by the quality preset — which is exactly what they were
 * already, only now the screen says so.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { LoraSelection, Model, QualityPreset } from '@comfy/shared';
import { ChevronDownIcon, PlusIcon } from '../components/icons';
import { IconButton, Row, Select, Slider } from './Controls';
import { CloseIcon, DiceIcon, LockIcon, RemixIcon, UnlockIcon } from './icons';
import {
  type AdvancedState,
  PRESET_DEFAULTS,
  QUALITY_LABELS,
  formatSeed,
  guidanceReading,
  loraReading,
  overrideCount,
  randomSeed,
  resetAdvanced,
  samplerOptions,
  schedulerOptions,
  stepsReading,
} from './form';
import styles from './advanced.module.css';

export function AdvancedDrawer({
  open,
  onOpenChange,
  quality,
  batchSize,
  value,
  onChange,
  loras,
  loraModels,
  onLorasChange,
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
  loras: LoraSelection[];
  loraModels: Model[];
  onLorasChange: (next: LoraSelection[]) => void;
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
  // bring the whole card up into view — but only on a click, never on the
  // first render (the open state persists, and a page that scrolls itself on
  // load is disorienting).
  const cardRef = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!open) return;
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
        onClick={() => onOpenChange(!open)}
      >
        <span className={styles.headText}>
          <span className={styles.title}>Advanced</span>
          {/* The subtitle is the whole reason a nervous user can close this
              again: it says, before they touch anything, that they do not have
              to. */}
          <span className={styles.subtitle}>Optional — the quality preset sets these</span>
        </span>
        <span className={styles.headRight}>
          {changed > 0 ? (
            <span className={styles.overrides}>
              {changed} changed
            </span>
          ) : null}
          <ChevronDownIcon
            size={15}
            className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
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
                  Everything here is following the{' '}
                  <strong>{QUALITY_LABELS[quality]}</strong> preset. Change one and it stays
                  where you put it.
                </>
              ) : (
                <>
                  {changed === 1 ? 'One setting is' : `${changed} settings are`} pinned to your
                  own value. The rest follow the <strong>{QUALITY_LABELS[quality]}</strong>{' '}
                  preset.
                </>
              )}
            </p>
            {changed > 0 ? (
              <button
                type="button"
                className={styles.resetAll}
                onClick={() => onChange(resetAdvanced(value))}
              >
                Use the preset for everything
              </button>
            ) : null}
          </div>

          <Overridable
            overridden={value.guidance !== null}
            onReset={() => set('guidance', null)}
            label="prompt faithfulness"
          >
            <Slider
              label="How closely to follow your prompt"
              min={1}
              max={20}
              step={0.5}
              value={guidance}
              reading={guidanceWords.word}
              display={guidance.toFixed(1)}
              ends={['Freer', 'More literal']}
              valueText={`${guidanceWords.word}, ${guidance.toFixed(1)} of 20`}
              hint={guidanceWords.hint}
              onChange={(next) => set('guidance', Number(next.toFixed(1)))}
            />
          </Overridable>

          <Overridable
            overridden={value.steps !== null}
            onReset={() => set('steps', null)}
            label="detail"
          >
            <Slider
              label="How much detail to work in"
              min={1}
              max={80}
              value={steps}
              reading={stepsWords.word}
              display={`${steps} steps`}
              ends={['Faster', 'More detail']}
              valueText={`${stepsWords.word}, ${steps} steps, ${stepsWords.hint}`}
              hint={stepsWords.hint}
              onChange={(next) => set('steps', next)}
            />
          </Overridable>

          <SeedControl value={value} onChange={onChange} />

          <LoraPicker loras={loras} models={loraModels} onChange={onLorasChange} />

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

/**
 * A control the user can pin, and the way back.
 *
 * The reset used to read "preset", which is a noun with no verb: it told you
 * where you would land, not that clicking would move you. "Use preset" is the
 * action, and the title says which control it applies to for a screen reader
 * hearing several of them in a row.
 */
function Overridable({
  overridden,
  onReset,
  label,
  children,
}: {
  overridden: boolean;
  onReset: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.overridable}>
      {children}
      {overridden ? (
        <button
          type="button"
          className={styles.reset}
          onClick={onReset}
          aria-label={`Use the quality preset's ${label}`}
        >
          <RemixIcon size={11} /> Use preset
        </button>
      ) : null}
    </div>
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
      <Row label="Starting number">
        <span className={`mono ${styles.seed}`} data-testid="seed-value">
          {formatSeed(value.seed)}
        </span>
        <IconButton title="Roll a new starting number" onClick={() => set('seed', randomSeed())}>
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
      <p className={styles.hint}>
        Every image starts from a dice roll, and this is the number that came up. The same
        number with the same prompt gives you the same picture again.
      </p>
      {/* aria-live: the lock changes the meaning of Generate, and a padlock
          icon flipping is not announced. */}
      <p className={styles.seedState} aria-live="polite">
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
      <button
        type="button"
        className={styles.expertHead}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <ChevronDownIcon
          size={13}
          className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
        />
        <span>Sampling method</span>
        <span className={styles.expertTag}>expert</span>
      </button>

      {open ? (
        <div className={styles.expertBody} id={bodyId}>
          <p className={styles.hint}>
            The maths used to turn noise into an image. It changes texture, not subject, and
            the <strong>{QUALITY_LABELS[quality]}</strong> preset already picks a pair that
            works. Nothing here is a mistake to leave alone.
          </p>

          <Overridable
            overridden={value.sampler !== null}
            onReset={() => set('sampler', null)}
            label="sampler"
          >
            <Select
              wide
              label="Sampler"
              value={sampler}
              options={samplerOptions(sampler)}
              onChange={(next) => set('sampler', next)}
            />
          </Overridable>

          <Overridable
            overridden={value.scheduler !== null}
            onReset={() => set('scheduler', null)}
            label="noise schedule"
          >
            <Select
              wide
              label="Noise schedule"
              value={scheduler}
              options={schedulerOptions(scheduler)}
              description="How quickly noise is removed across those steps."
              onChange={(next) => set('scheduler', next)}
            />
          </Overridable>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- LoRAs

const DEFAULT_LORA_WEIGHT = 0.7;

/**
 * LoRAs.
 *
 * "LoRA" is an acronym for a training technique, which is of no use to anyone
 * choosing one. What a user needs to know is that these are extra styles
 * somebody trained and installed, that you can stack them, and that the number
 * beside each is how much of it to mix in. The acronym stays in the label —
 * it is what every other tool and every download page calls them, and hiding it
 * would leave someone unable to look one up — but it follows the plain words
 * rather than standing in for them.
 */
function LoraPicker({
  loras,
  models,
  onChange,
}: {
  loras: LoraSelection[];
  models: Model[];
  onChange: (next: LoraSelection[]) => void;
}) {
  const chosen = new Set(loras.map((lora) => lora.modelId));
  const available = models.filter((model) => !chosen.has(model.id));

  return (
    <div className={styles.loras}>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Extra styles (LoRA)</span>
        {models.length === 0 ? (
          <span className={styles.none}>none installed</span>
        ) : (
          <div className={styles.addWrap}>
            {/* A select styled as the artboard's dashed "+" square: one control,
                one click, and the list is the installed LoRAs. */}
            <select
              className={styles.add}
              value=""
              aria-label="Add an extra style"
              disabled={available.length === 0}
              onChange={(event) => {
                if (!event.target.value) return;
                onChange([...loras, { modelId: event.target.value, weight: DEFAULT_LORA_WEIGHT }]);
              }}
            >
              <option value="">Add…</option>
              {available.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
            <PlusIcon size={12} className={styles.addIcon} />
          </div>
        )}
      </div>

      <p className={styles.hint}>
        {models.length === 0
          ? 'Add-on styles you install show up here, on top of whichever model you pick.'
          : 'Trained looks you can mix on top of the model — a film stock, an illustrator, a subject.'}
      </p>

      {loras.map((lora, index) => {
        const model = models.find((entry) => entry.id === lora.modelId);
        const words = loraReading(lora.weight);
        return (
          <div key={lora.modelId} className={styles.lora}>
            <div className={styles.loraHead}>
              <span className={styles.loraName}>{model?.displayName ?? lora.modelId}</span>
              <button
                type="button"
                className={styles.loraRemove}
                title={`Remove ${model?.displayName ?? 'this style'}`}
                aria-label={`Remove ${model?.displayName ?? 'this style'}`}
                onClick={() => onChange(loras.filter((_, i) => i !== index))}
              >
                <CloseIcon size={11} />
              </button>
            </div>
            <Slider
              label="How much of it"
              accent
              min={-1}
              max={2}
              step={0.05}
              value={lora.weight}
              reading={words.word}
              display={lora.weight.toFixed(2)}
              ends={['Off', 'Overdone']}
              valueText={`${words.word}, ${lora.weight.toFixed(2)}`}
              hint={words.hint}
              onChange={(weight) =>
                onChange(
                  loras.map((entry, i) =>
                    i === index ? { ...entry, weight: Number(weight.toFixed(2)) } : entry,
                  ),
                )
              }
            />
          </div>
        );
      })}
    </div>
  );
}
