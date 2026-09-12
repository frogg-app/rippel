/**
 * Extra styles (LoRA) — its own section of the creation panel.
 *
 * It used to live inside the Advanced drawer, which was a drift from the
 * agreed design. Advanced means "the quality preset already chose this;
 * override it if you know better" — sampler, steps, guidance, seed. A LoRA is
 * not an override of anything. It is a creative choice on the same footing as
 * picking a checkpoint or writing a prompt, and PLAN.md §6 lists it as part of
 * the creation surface. So it sits in the panel proper, below the reference
 * image and above Advanced.
 *
 * The control is a picker popup, not a dropdown. A dropdown lists strings, and
 * the strings here are filenames: this install has `Pytorch LoRA Weights` and
 * `Hyper SD15 1step LoRA`, which tell a user nothing about what they do. You
 * choose a style by what it looks like, so the popup shows the preview picture
 * `GET /api/models` already returns — through the same deterministic-wash
 * fallback the model tiles use, because a locally discovered LoRA almost never
 * has a picture.
 *
 * Compatibility is `loras.ts`: styles trained for another family are hidden
 * behind an honest count, not offered and left to fail.
 *
 * The stacked state is the part a dropdown handles worst, and is why each
 * chosen style is a card — picture, name, family, its own strength slider in
 * words, and its own remove — rather than a line in a list.
 *
 * ## Saying what each one is, without making it up
 *
 * Every card used to explain itself with the same sentence, which is the same
 * as explaining nothing. Each card now carries what `loraDescription.ts` can
 * honestly say about *that* file — a real description if the server ever sends
 * one, otherwise only what the filename literally supports, labelled as such —
 * and says plainly when that is nothing. See that module for the rule.
 *
 * ## "Styles", not "steps"
 *
 * People read this section as "extra steps". Understandably: Advanced has a
 * step count, and the most common speed-up LoRAs are named `2step`, `8step`.
 * They are different things — a style is a file mixed into the model; a step is
 * one refinement pass of the sampler — and the only point where they meet is a
 * step-distilled style *requiring* a low step count. So the section says what
 * it is not, and a card whose filename names a step count points at Advanced →
 * Detail by its on-screen name rather than leaving the user to connect them.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LoraSelection, Model } from '@comfy/shared';
import { useAnchoredPosition, useDismissOnOutside } from '../components/useAnchoredPosition';
import { PlusIcon } from '../components/icons';
import { Hint, Slider } from './Controls';
import { CloseIcon } from './icons';
import { describeLora, type LoraDescription } from './loraDescription';
import { loraWeightReading, WEIGHT_SCALE } from './loraWeight';
import { familyLabel } from '../models/catalogue';
import { familyInitials, familyWash } from './modelArt';
import { type LoraEntry, matchesQuery, partitionLoras } from './loras';
import styles from './loraSection.module.css';

const DEFAULT_LORA_WEIGHT = 0.7;

export function LoraSection({
  loras,
  models,
  checkpoint,
  onChange,
}: {
  loras: LoraSelection[];
  /** Every installed LoRA, unfiltered. */
  models: Model[];
  /** The chosen checkpoint, which decides what fits. May be null. */
  checkpoint: Model | null;
  onChange: (next: LoraSelection[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);

  const partition = useMemo(
    () => partitionLoras(models, checkpoint, loras),
    [models, checkpoint, loras],
  );

  const add = (model: Model) => {
    onChange([...loras, { modelId: model.id, weight: DEFAULT_LORA_WEIGHT }]);
    setOpen(false);
    addRef.current?.focus();
  };

  const nothingInstalled = models.length === 0;
  const nothingLeft = partition.offered.length === 0 && partition.hidden.length === 0;

  return (
    <section className={styles.section} aria-labelledby="lora-section-label">
      <div className={styles.head}>
        <span className={styles.labelRow}>
          <span className={styles.label} id="lora-section-label">
            Extra styles
            {/* The acronym stays, quietly: it is the word on every download
                page, and dropping it would leave someone unable to look one
                up. It follows the plain words rather than standing in. */}
            <span className={styles.qualifier}> (LoRA)</span>
          </span>
          <Hint
            text={
              nothingInstalled
                ? 'A LoRA is a small add-on file trained to steer a model towards one thing. Any you install will be listed here.'
                : 'Small add-on files (LoRAs), each trained to steer the model towards one thing — a look, a subject, or sometimes a speed-up. They are not extra sampling steps: the step count lives in Advanced → Detail.'
            }
          />
        </span>

        {nothingInstalled ? (
          <span className={styles.none}>none installed</span>
        ) : (
          <button
            ref={addRef}
            type="button"
            className={styles.add}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={nothingLeft}
            onClick={() => setOpen((current) => !current)}
          >
            <PlusIcon size={12} />
            {loras.length > 0 ? 'Add another' : 'Add a style'}
          </button>
        )}
      </div>

      {open ? (
        <LoraPickerPopup
          anchorRef={addRef}
          partition={partition}
          checkpointFamily={checkpoint?.baseModel ?? null}
          onPick={add}
          onClose={() => {
            setOpen(false);
            addRef.current?.focus();
          }}
        />
      ) : null}

      {loras.length === 0 ? (
        <p className={styles.empty}>
          {nothingInstalled ? (
            <>
              No extra styles are installed.{' '}
              <a className={styles.link} href="/models">
                Browse models
              </a>
            </>
          ) : partition.fitting === 0 && partition.offered.length === 0 ? (
            <>
              None of your {models.length === 1 ? 'installed style' : `${models.length} installed styles`}{' '}
              {models.length === 1 ? 'was' : 'were'} trained for{' '}
              {checkpoint?.baseModel ? familyLabel(checkpoint.baseModel) : 'this model'}.
            </>
          ) : (
            <>Optional. Nothing is added unless you add it here.</>
          )}
        </p>
      ) : null}

      {loras.map((lora, index) => (
        <ChosenLora
          key={lora.modelId}
          lora={lora}
          model={models.find((entry) => entry.id === lora.modelId) ?? null}
          onRemove={() => onChange(loras.filter((_, i) => i !== index))}
          onWeight={(weight) =>
            onChange(
              loras.map((entry, i) =>
                i === index ? { ...entry, weight: Number(weight.toFixed(2)) } : entry,
              ),
            )
          }
        />
      ))}
    </section>
  );
}

// ------------------------------------------------------------- chosen stack

/**
 * One chosen style, as a card.
 *
 * A zero weight is dropped from the request rather than sent as a no-op, so
 * "Off" on this card is honest: it really does remove the style from the job.
 * The rail's left end is *not* off, though — it is -1, a reversed style — and
 * it is labelled as such; the old "Off" there described the wrong end.
 */
function ChosenLora({
  lora,
  model,
  onRemove,
  onWeight,
}: {
  lora: LoraSelection;
  model: Model | null;
  onRemove: () => void;
  onWeight: (weight: number) => void;
}) {
  const words = loraWeightReading(lora.weight);
  const name = model?.displayName ?? lora.modelId;
  // A selection whose model row has gone (uninstalled since a Remix) has no
  // filename to read, so it says nothing rather than reading the id as a name.
  const about = model ? describeLora(model) : null;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <Thumb model={model} name={name} />
        <span className={styles.cardText}>
          <span className={styles.cardName} title={name}>
            {name}
          </span>
          <span className={styles.cardFamily}>
            {model?.baseModel ? familyLabel(model.baseModel) : 'family unknown'}
            {lora.weight === 0 ? <span className={styles.offMark}> · off, not sent</span> : null}
          </span>
        </span>
        <button
          type="button"
          className={styles.remove}
          title={`Remove ${name}`}
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <CloseIcon size={11} />
        </button>
      </div>
      {about ? <About about={about} /> : null}
      <Slider
        label="Strength"
        accent
        min={-1}
        max={2}
        step={0.05}
        value={lora.weight}
        reading={words.word}
        display={`${lora.weight.toFixed(2)}×`}
        ends={['−1 reversed', '2 overdone']}
        valueText={`${words.word}, ${lora.weight.toFixed(2)} times the trained strength`}
        hint={`${words.hint} ${WEIGHT_SCALE}`}
        onChange={onWeight}
      />
    </div>
  );
}

/**
 * What this particular style is, in as many words as we can honestly say.
 *
 * The order is trust order. A real description first; then trigger words,
 * because a style that needs one and does not get it silently does nothing;
 * then filename readings, under a label that says that is all they are; and
 * last, when there is no real description, a plain admission — including that
 * trigger words, if the style has any, are not known to us either.
 */
function About({ about }: { about: LoraDescription }) {
  return (
    <div className={styles.about}>
      {about.given ? <p className={styles.aboutGiven}>{about.given}</p> : null}

      {about.triggerWords.length > 0 ? (
        <p className={styles.aboutTrigger}>
          Needs a trigger word in your prompt:{' '}
          {about.triggerWords.map((word, index) => (
            <span key={word}>
              {index > 0 ? ', ' : ''}
              <code className={styles.triggerWord}>{word}</code>
            </span>
          ))}
          . Without one it may do nothing.
        </p>
      ) : null}

      {about.derived.length > 0 ? (
        <>
          <p className={styles.aboutSource}>Read from the filename, not from the author:</p>
          <ul className={styles.aboutList}>
            {about.derived.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : null}

      {about.given === null ? (
        <p className={styles.aboutGap}>
          {about.unknown
            ? 'No description is recorded for this style, and the filename does not say what it does. '
            : 'No written description is recorded for this style. '}
          Trigger words are not recorded either — if its download page lists one, put it in your prompt.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The preview picture where there is one, and a quiet family mark where there
 * is not — which, on a machine whose LoRAs were all discovered locally, is
 * every row. See `modelArt.ts` for why this is not the tile's wash.
 */
function Thumb({ model, name }: { model: Model | null; name: string }) {
  return (
    <span
      className={styles.thumb}
      style={model ? familyWash(model) : undefined}
      aria-hidden
      title={name}
    >
      {model?.previewUrl ? (
        <img className={styles.thumbArt} src={model.previewUrl} alt="" loading="lazy" />
      ) : model ? (
        <span className={styles.thumbInitials}>{familyInitials(model)}</span>
      ) : null}
    </span>
  );
}

// ------------------------------------------------------------------- picker

/**
 * The popup.
 *
 * Portalled to <body> and positioned in viewport coordinates, so the panel's
 * own scroll container cannot clip it; flips above the button when the panel is
 * scrolled near the bottom of the window.
 *
 * Keyboard: the search field is the landing spot and stays focused throughout,
 * with the rows addressed by `aria-activedescendant` — the same arrangement as
 * the dropdown, for the same reason. Arrow keys move, Enter adds, Escape closes
 * and puts focus back on the button that opened it.
 */
function LoraPickerPopup({
  anchorRef,
  partition,
  checkpointFamily,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  partition: ReturnType<typeof partitionLoras>;
  /** The chosen checkpoint's family, or null if nothing recorded one. */
  checkpointFamily: string | null;
  onPick: (model: Model) => void;
  onClose: () => void;
}) {
  const reactId = useId();
  const listId = `${reactId}-list`;
  const [query, setQuery] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const position = useAnchoredPosition(anchorRef, true, {
    maxHeight: 360,
    minHeight: 180,
    width: 320,
    align: 'end',
  });
  useDismissOnOutside(true, [anchorRef, panelRef], onClose);

  const rows = useMemo(() => {
    const pool = revealed ? [...partition.offered, ...partition.hidden] : partition.offered;
    return pool.filter((entry) => matchesQuery(entry, query));
  }, [partition, revealed, query]);

  // A changed filter invalidates the cursor's position, not just its index.
  useEffect(() => setActiveIndex(0), [query, revealed]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const optionId = (index: number) => `${reactId}-option-${index}`;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => Math.min(Math.max(current + delta, 0), Math.max(rows.length - 1, 0)));
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : Math.max(rows.length - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const entry = rows[activeIndex];
      if (entry) onPick(entry.model);
    }
  };

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Add an extra style"
      className={`${styles.popup} ${position?.up ? styles.popupUp : ''}`}
      style={
        position
          ? { top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }
          : { visibility: 'hidden' }
      }
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        className={styles.search}
        placeholder="Search styles"
        aria-label="Search extra styles"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={rows.length > 0 ? optionId(activeIndex) : undefined}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <ul ref={listRef} id={listId} role="listbox" aria-label="Extra styles" className={styles.list}>
        {rows.map((entry, index) => (
          <li
            key={entry.model.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            className={`${styles.row} ${index === activeIndex ? styles.rowActive : ''}`}
            onMouseEnter={() => setActiveIndex(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(entry.model)}
          >
            <Thumb model={entry.model} name={entry.model.displayName} />
            <span className={styles.rowText}>
              <span className={styles.rowName}>{entry.model.displayName}</span>
              <span className={styles.rowFamily}>{describe(entry, checkpointFamily)}</span>
              <RowNote entry={entry} />
            </span>
          </li>
        ))}
      </ul>

      {/* Said once, at the foot of the list, rather than on every row: when the
          checkpoint itself has no recorded family there is nothing to compare
          against, and that is a fact about the model, not about these files.
          Kept short — by this point the interface has already said "family
          unknown" on the model tile and in the section below. */}
      {checkpointFamily === null && rows.length > 0 ? (
        <p className={styles.popupFoot}>This model&rsquo;s family isn&rsquo;t recorded — none were checked for fit.</p>
      ) : null}

      {rows.length === 0 ? (
        <p className={styles.popupNote}>
          {query ? `Nothing matches “${query}”.` : 'No styles fit this model.'}
        </p>
      ) : null}

      {/* The honest count, as the model grid does it: hiding a file the user
          installed is fine, not saying so is not. */}
      {partition.hidden.length > 0 ? (
        <p className={styles.popupFoot}>
          {partition.hidden.length} trained for another model.{' '}
          <button
            type="button"
            className={styles.link}
            aria-expanded={revealed}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? 'Hide again' : 'Show anyway'}
          </button>
        </p>
      ) : null}
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(panel, document.body) : null;
}

/**
 * A second line in the picker, only for a style that changes what Advanced
 * must be set to. Every other row stays one line: the popup is for choosing,
 * and the full account of a style is on its card once chosen.
 */
function RowNote({ entry }: { entry: LoraEntry }) {
  const about = describeLora(entry.model);
  if (!about.needsLowSteps) return null;
  return (
    <span className={styles.rowNote}>
      {about.stepTarget !== null
        ? `Speed-up, named for ${about.stepTarget} step${about.stepTarget === 1 ? '' : 's'} — lower Detail to match`
        : 'Speed-up — lower Detail to match'}
    </span>
  );
}

/**
 * The line under a style's name.
 *
 * The distinction worth keeping: a style whose own family is unrecorded is a
 * different thing from a style whose family is known but could not be compared
 * because the *checkpoint's* family is unrecorded. The first sentence blames
 * the file; the second blames neither, and saying the first when the second is
 * true is simply wrong.
 */
function describe(entry: LoraEntry, checkpointFamily: string | null): string {
  const label = entry.family ? familyLabel(entry.family) : null;
  if (entry.fit === 'mismatch')
    return `${label ?? 'Another family'} — will not run on this model`;
  if (entry.fit === 'fits') return label ?? '';
  // Unknown: which side is missing decides what there is to say.
  if (!label) return 'Family not recorded';
  return checkpointFamily === null ? label : `${label} — fit not checked`;
}
