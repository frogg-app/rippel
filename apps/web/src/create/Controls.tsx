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
import { useId } from 'react';
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

  return (
    <div
      className={styles.segmented}
      role="radiogroup"
      aria-label={label}
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
            className={selected ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
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
            className={selected ? `${styles.chip} ${styles.chipOn}` : styles.chip}
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
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  accent = false,
  display,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  accent?: boolean;
  display?: string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const fill = ((value - min) / (max - min)) * 100;

  return (
    <div className={styles.slider}>
      <div className={styles.sliderHead}>
        <label htmlFor={id} className={styles.sliderLabel}>
          {label}
        </label>
        <span className={`mono ${accent ? styles.valueAccent : styles.value}`}>
          {display ?? value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        className={accent ? `${styles.range} ${styles.rangeAccent}` : styles.range}
        style={{ '--fill': `${fill}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- select

/**
 * A native `<select>` wearing the artboard's bordered pill. The chevron is
 * drawn alongside and the select itself is transparent on top of it, which
 * keeps the OS popup — a hand-rolled listbox here would be worse in every way
 * that matters.
 */
export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className={styles.row}>
      <label htmlFor={id} className={styles.rowLabel}>
        {label}
      </label>
      <div className={styles.selectWrap}>
        <select
          id={id}
          className={`mono ${styles.select}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <ChevronDownIcon size={12} className={styles.selectChevron} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- row

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
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
      className={on ? `${styles.iconButton} ${styles.iconButtonOn}` : styles.iconButton}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
