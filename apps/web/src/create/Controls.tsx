/**
 * The small control primitives the input panel is built from.
 *
 * Every one of them is a real form control underneath — a `<input type=range>`,
 * a `<select>`, a group of `<button role=radio>` — rather than a styled div
 * with a click handler, because the artboard's look is achievable with CSS on
 * native elements and keyboard and screen-reader behaviour is not achievable
 * without them.
 */
import type { CSSProperties, ReactNode } from 'react';
import { useId, useState } from 'react';
import { Dropdown } from '../components/Dropdown';
import { createPortal } from 'react-dom';
import { ChevronDownIcon } from '../components/icons';
import styles from './controls.module.css';

// ---------------------------------------------------------------- group

export function Group({
  label,
  action,
  children,
}: {
  label?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.group}>
      {label ? (
        <div className={styles.groupHead}>
          <span className="label">{label}</span>
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- segmented

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Quality. A radiogroup, so arrow keys move between the three the way a native
 * radio does — the alternative is three tab stops for one decision.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const move = (delta: number) => {
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + delta + options.length) % options.length];
    if (next) onChange(next.value);
  };

  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <div
      className={styles.segmented}
      role="radiogroup"
      aria-label={label}
      // The sliding thumb is positioned from these two numbers in CSS, so it
      // glides between segments rather than switching.
      style={
        { '--seg-i': activeIndex, '--seg-n': options.length } as CSSProperties
      }
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={
              selected
                ? `${styles.segment} ${styles.segmentOn}`
                : styles.segment
            }
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- chips

export function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.chips} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={
              selected ? `${styles.chip} ${styles.chipOn}` : styles.chip
            }
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- slider

/**
 * The artboard's slider: a 4px rail with a gradient fill on the accent ones and
 * a grey fill in Advanced. The fill is painted with a CSS gradient on the input
 * itself (`--fill`), so there is no second element to keep in sync with the
 * thumb.
 */
// ---------------------------------------------------------------- reset

/**
 * "Use preset": the way back from a pinned value. The slot is always
 * rendered so that pinning a value changes nothing about the layout — the
 * button merely becomes visible. A control that grew a line when touched
 * pushed everything under it down, which is exactly the wrong moment to move
 * the thing the user is dragging.
 */
export interface ResetSlot {
  active: boolean;
  onReset: () => void;
  /** What is being handed back, for the accessible name. */
  label: string;
}

function Reset({
  reset,
  compact = false,
}: {
  reset: ResetSlot;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={[
        styles.reset,
        compact ? styles.resetCompact : '',
        reset.active ? styles.resetOn : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={reset.onReset}
      aria-label={`Use the quality preset's ${reset.label}`}
      aria-hidden={!reset.active}
      tabIndex={reset.active ? 0 : -1}
      title="Use preset"
    >
      <ResetIcon />
      {compact ? null : 'Use preset'}
    </button>
  );
}

function ResetIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

// ---------------------------------------------------------------- hint

/**
 * The sentence that used to sit under every control, folded behind a small
 * "?" so the drawer reads as a list of settings rather than a page of prose.
 * Hover or focus shows it; a click or tap pins it. The tooltip itself portals
 * to the body, because every ancestor here clips overflow.
 *
 * It stays in the DOM whether shown or not, so `aria-describedby` from the
 * control still resolves to real text.
 */
export function Hint({ text, id }: { text: ReactNode; id?: string }) {
  const own = useId();
  const tipId = id ?? own;
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null);
  const shown = pinned || hover;

  const place = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const width = 280;
    const left = Math.max(
      8,
      Math.min(r.left - 8, window.innerWidth - width - 12),
    );
    setRect({ left, top: r.bottom + 8 });
  };

  return (
    <>
      <button
        type="button"
        className={
          shown
            ? `${styles.hintButton} ${styles.hintButtonOn}`
            : styles.hintButton
        }
        aria-label="What this does"
        aria-describedby={tipId}
        data-still
        onMouseEnter={(event) => {
          place(event.currentTarget);
          setHover(true);
        }}
        onMouseLeave={() => setHover(false)}
        onFocus={(event) => {
          place(event.currentTarget);
          setHover(true);
        }}
        onBlur={() => {
          setHover(false);
          setPinned(false);
        }}
        onClick={(event) => {
          place(event.currentTarget);
          setPinned((was) => !was);
        }}
      >
        ?
      </button>
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <span
              role="tooltip"
              id={tipId}
              className={
                shown && rect
                  ? `${styles.tooltip} ${styles.tooltipOn}`
                  : styles.tooltip
              }
              style={rect ? { left: rect.left, top: rect.top } : undefined}
            >
              {text}
            </span>,
            document.body,
          )}
    </>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  accent = false,
  display,
  reading,
  ends,
  valueText,
  hint,
  reset,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  accent?: boolean;
  /** The number, in the mono face — what the value literally is. */
  display?: string;
  /** The same value in words, beside the number: "Balanced", "Detailed". */
  reading?: string;
  /** What the two ends of the rail mean, e.g. ['Looser', 'More literal']. */
  ends?: readonly [string, string];
  /**
   * What a screen reader announces instead of the bare number. A range input
   * announces "7" by default, which is exactly as useless spoken as it is
   * printed; `aria-valuetext` is how the words the sighted user reads beside
   * the rail reach someone who cannot see them.
   */
  valueText?: string;
  hint?: string;
  /** A way back to the preset, shown in the rail's centre once pinned. */
  reset?: ResetSlot;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const hintId = useId();
  const fill = ((value - min) / (max - min)) * 100;

  return (
    <div className={styles.slider}>
      <div className={styles.sliderHead}>
        <span className={styles.labelRow}>
          <label htmlFor={id} className={styles.sliderLabel}>
            {label}
          </label>
          {hint ? <Hint id={hintId} text={hint} /> : null}
        </span>
        <span className={styles.sliderValue}>
          {reading ? <span className={styles.reading}>{reading}</span> : null}
          <span
            className={`mono ${accent ? styles.valueAccent : styles.value}`}
          >
            {display ?? value}
          </span>
        </span>
      </div>
      <input
        id={id}
        type="range"
        className={
          accent ? `${styles.range} ${styles.rangeAccent}` : styles.range
        }
        style={{ '--fill': `${fill}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {/* The rail's ends, named. A slider with no labelled extremes asks the
          user to discover which way is "more" by dragging it and regenerating. */}
      {ends || reset ? (
        <div className={styles.ends}>
          <span aria-hidden>{ends?.[0] ?? ''}</span>
          {reset ? <Reset reset={reset} /> : null}
          <span aria-hidden>{ends?.[1] ?? ''}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- select

/**
 * The artboard's bordered pill, wrapping the app's own listbox.
 *
 * It used to be a native `<select>` on the argument that the OS popup was
 * better than anything hand-rolled. That was true of a hand-rolled listbox;
 * it is not true of `components/Dropdown`, which puts the keyboard, the roles
 * and the type-ahead back — and the OS popup was a white menu on a near-black
 * screen, which is the one thing it could not fix.
 */
export interface SelectOption {
  value: string;
  label: string;
}

/** `['a','b']` and `[{value,label}]` are both accepted; normalise to the latter. */
function selectOptions(
  options: readonly (string | SelectOption)[],
): SelectOption[] {
  return options.map((option) =>
    typeof option === 'string' ? { value: option, label: option } : option,
  );
}

export function Select({
  label,
  value,
  options,
  description,
  wide = false,
  reset,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (string | SelectOption)[];
  /** A sentence under the row saying what choosing here does. */
  description?: string;
  /** Stack the label above a full-width control, for long option text. */
  wide?: boolean;
  reset?: ResetSlot;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const labelId = useId();
  const descriptionId = useId();
  const entries = selectOptions(options);
  const stacked = wide;

  return (
    <div className={stacked ? styles.field : styles.row}>
      <span className={styles.labelRow}>
        <label htmlFor={id} id={labelId} className={styles.rowLabel}>
          {label}
        </label>
        {description ? <Hint id={descriptionId} text={description} /> : null}
        {reset ? <Reset reset={reset} compact /> : null}
      </span>
      <div
        className={
          stacked
            ? `${styles.selectWrap} ${styles.selectWide}`
            : styles.selectWrap
        }
      >
        <Dropdown
          id={id}
          aria-labelledby={labelId}
          className={stacked ? styles.select : `mono ${styles.select}`}
          value={value}
          options={entries}
          aria-describedby={description ? descriptionId : undefined}
          onChange={onChange}
        >
          <ChevronDownIcon size={12} className={styles.selectChevron} />
        </Dropdown>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- row

export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.labelRow}>
        <span className={styles.rowLabel}>{label}</span>
        {hint ? <Hint text={hint} /> : null}
      </span>
      <div className={styles.rowControls}>{children}</div>
    </div>
  );
}

/** The 28px square icon button beside a value — dice, lock, remove. */
export function IconButton({
  title,
  on = false,
  onClick,
  children,
}: {
  title: string;
  on?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on || undefined}
      className={
        on ? `${styles.iconButton} ${styles.iconButtonOn}` : styles.iconButton
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}
