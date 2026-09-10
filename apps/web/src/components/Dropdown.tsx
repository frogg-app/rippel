/**
 * One dropdown for the whole app, replacing every native `<select>`.
 *
 * Why at all: a `<select>`'s popup is drawn by the operating system, so on this
 * near-black UI it opens as a white menu that belongs to another program. That
 * is the only reason. Everything a native select gives you for free has to be
 * put back by hand here, and the list below is that debt paid in full:
 *
 *  - Keyboard: Up/Down/Home/End move, Enter/Space open and choose, Escape
 *    closes leaving the value as it was, Tab leaves. Typing letters jumps to a
 *    match — with 42 model families a picker you cannot type into is worse
 *    than the OS menu it replaced.
 *  - ARIA: the select-only combobox pattern — a `combobox` button owning a
 *    `listbox`, `aria-expanded`, `aria-activedescendant` on the trigger,
 *    `aria-selected` on the options, and the caller's label associated by
 *    `aria-labelledby` or `aria-label`.
 *  - Focus never leaves the trigger. The menu is a portal but is not focused;
 *    keystrokes are handled on the trigger, which is why closing needs no
 *    focus restoration dance and choosing an option cannot strand focus.
 *  - The menu is portalled to `<body>` and positioned in viewport coordinates,
 *    so no ancestor's `overflow: hidden` can clip it — the bug that bit the
 *    Advanced drawer.
 *  - It flips above the trigger when there is more room up there, clamps its
 *    height to whatever space is actually available, and keeps the active row
 *    scrolled into view.
 *
 * Nothing is committed while the menu is open: arrowing changes the *cursor*,
 * not the value. So Escape restoring the previous value is not a special case,
 * it is the absence of one.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition, useDismissOnOutside } from './useAnchoredPosition';
import styles from './Dropdown.module.css';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DropdownProps {
  /** The selected value. `''` is a legitimate value — the "All" row. */
  value: string;
  options: readonly DropdownOption[];
  onChange: (value: string) => void;
  /** Put on the trigger, so an outside `<label htmlFor>` still points at it. */
  id?: string;
  /** The call site's own trigger appearance. */
  className?: string;
  /** Extra class for the portalled menu, for a call-site width cap. */
  menuClassName?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  disabled?: boolean;
  /** Shown when `value` matches no option — the LoRA row's "Add…". */
  placeholder?: string;
  /**
   * Show the placeholder rather than the chosen label after choosing: the
   * "Add…" affordance, which is an action list wearing a select's clothes.
   */
  keepPlaceholder?: boolean;
  /** Right-align the menu with the trigger instead of left. */
  align?: 'start' | 'end';
  /** Drawn inside the trigger after the value — usually a chevron. */
  children?: ReactNode;
}

/** How long a pause resets the type-ahead buffer, matching the OS menus. */
const TYPEAHEAD_RESET_MS = 600;

const MENU_ANCHOR = { maxHeight: 320, minHeight: 120, minWidth: 168 } as const;

function CheckIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg
      className={hidden ? `${styles.check} ${styles.checkHidden}` : styles.check}
      viewBox="0 0 12 12"
      width={12}
      height={12}
      aria-hidden
      focusable="false"
    >
      <path
        d="M2.5 6.4 4.8 8.7 9.5 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Dropdown({
  value,
  options,
  onChange,
  id,
  className,
  menuClassName,
  disabled = false,
  placeholder,
  keepPlaceholder = false,
  align = 'start',
  children,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: DropdownProps) {
  const reactId = useId();
  const triggerId = id ?? `dropdown-${reactId}`;
  const listId = `${reactId}-list`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const typeahead = useRef({ buffer: '', at: 0 });

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  /**
   * What the trigger reads.
   *
   * The last fallback is the native `<select>`'s own behaviour and not an
   * accident: a select whose value matches no option shows its first one, and
   * a caller that hands us a value before its list has settled — the backend
   * picker, for one render — should show that first option rather than an
   * empty pill.
   */
  const triggerLabel = keepPlaceholder
    ? (placeholder ?? '')
    : (selected?.label ?? placeholder ?? options[0]?.label ?? '');

  const optionId = (index: number) => `${reactId}-option-${index}`;

  // ------------------------------------------------------------- positioning

  const position = useAnchoredPosition(triggerRef, open, { ...MENU_ANCHOR, align });
  useDismissOnOutside(open, [triggerRef, menuRef], () => setOpen(false));

  // Keep the cursor visible as it moves.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = menuRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(activeIndex))}`);
    // jsdom has no scrollIntoView, and neither do very old engines.
    node?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex]);

  // ------------------------------------------------------------- navigation

  const enabledStep = useCallback(
    (from: number, delta: number): number => {
      const count = options.length;
      if (count === 0) return -1;
      let index = from;
      for (let step = 0; step < count; step += 1) {
        index += delta;
        if (index < 0) index = 0;
        if (index > count - 1) index = count - 1;
        if (!options[index]?.disabled) return index;
        // Ran into the end against a wall of disabled entries.
        if (index === 0 && delta < 0) break;
        if (index === count - 1 && delta > 0) break;
      }
      return options[from]?.disabled ? -1 : from;
    },
    [options],
  );

  const firstEnabled = useCallback(
    (from: number, delta: number): number => {
      const count = options.length;
      for (let index = from; index >= 0 && index < count; index += delta) {
        if (!options[index]?.disabled) return index;
      }
      return -1;
    },
    [options],
  );

  const openMenu = useCallback(
    (start?: number) => {
      if (disabled) return;
      const from =
        start ?? (selectedIndex >= 0 && !options[selectedIndex]?.disabled
          ? selectedIndex
          : firstEnabled(0, 1));
      setActiveIndex(from);
      setOpen(true);
    },
    [disabled, firstEnabled, options, selectedIndex],
  );

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }, []);

  const choose = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      close();
    },
    [close, onChange, options],
  );

  /** Type-ahead: same rules as the OS menu — accumulate, and a repeated single
   *  letter cycles through the entries that begin with it. */
  const typeaheadMatch = useCallback(
    (char: string, from: number): number => {
      const now = Date.now();
      const state = typeahead.current;
      state.buffer = now - state.at > TYPEAHEAD_RESET_MS ? char : state.buffer + char;
      state.at = now;

      const query = state.buffer.toLowerCase();
      const cycling = query.length > 1 && query.split('').every((c) => c === query[0]);
      const needle = cycling ? query[0]! : query;
      // A fresh single letter (or a repeat of one) starts looking *after* the
      // cursor; a growing buffer refines from the cursor itself.
      const offset = query.length === 1 || cycling ? 1 : 0;
      const base = from < 0 ? 0 : from;

      for (let step = 0; step < options.length; step += 1) {
        const index = (base + offset + step) % options.length;
        const option = options[index]!;
        if (option.disabled) continue;
        if (option.label.toLowerCase().startsWith(needle)) return index;
      }
      return -1;
    },
    [options],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const { key } = event;

    if (key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      return;
    }

    if (key === 'Tab') {
      // Leave, keeping the value untouched. Do not swallow the Tab.
      if (open) setOpen(false);
      return;
    }

    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openMenu();
      return;
    }

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const delta = key === 'ArrowDown' ? 1 : -1;
      if (!open) openMenu();
      else setActiveIndex((current) => enabledStep(current < 0 ? (delta > 0 ? -1 : options.length) : current, delta));
      return;
    }

    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      const target = key === 'Home' ? firstEnabled(0, 1) : firstEnabled(options.length - 1, -1);
      if (!open) openMenu(target);
      else setActiveIndex(target);
      return;
    }

    // Printable single characters drive type-ahead, open or closed.
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const match = typeaheadMatch(key, open ? activeIndex : selectedIndex);
      if (match < 0) return;
      event.preventDefault();
      if (!open) openMenu(match);
      else setActiveIndex(match);
    }
  };

  // --------------------------------------------------------------- rendering

  const menu =
    open && position ? (
      <ul
        ref={menuRef}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        className={
          menuClassName
            ? `${styles.menu} ${position.up ? styles.menuUp : ''} ${menuClassName}`
            : `${styles.menu} ${position.up ? styles.menuUp : ''}`
        }
        style={{
          top: position.top,
          left: position.left,
          width: position.width,
          maxHeight: position.maxHeight,
        }}
      >
        {options.length === 0 ? (
          <li className={styles.empty}>Nothing to choose</li>
        ) : (
          options.map((option, index) => {
            const isSelected = index === selectedIndex;
            const classes = [styles.option];
            if (index === activeIndex) classes.push(styles.optionActive);
            if (isSelected) classes.push(styles.optionSelected);
            if (option.disabled) classes.push(styles.optionDisabled);
            return (
              <li
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                className={classes.join(' ')}
                // Keep focus on the trigger: never let the press move it.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                <CheckIcon hidden={!isSelected} />
                <span className={styles.optionLabel}>{option.label}</span>
              </li>
            );
          })
        )}
      </ul>
    ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        className={className ? `${styles.trigger} ${className}` : styles.trigger}
        onKeyDown={onKeyDown}
        onClick={() => (open ? close() : openMenu())}
      >
        <span className={styles.value}>{triggerLabel}</span>
        {children}
      </button>
      {menu && typeof document !== 'undefined' ? createPortal(menu, document.body) : null}
    </>
  );
}
