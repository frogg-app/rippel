/**
 * Choosing a checkpoint, with room to do it in.
 *
 * The picker used to be the grid itself, three 72px tiles across a 396px panel
 * squeezed between the reference image and the quality preset. On this box that
 * is five checkpoints in a column of controls, each one a coloured square with
 * a two-line clipped name and, when something was wrong with it, a badge
 * competing for the same 72px. The user's reading of it was the fairest
 * possible: "trying to load them all into a small window pane". A library of
 * twenty would have been unusable.
 *
 * So the choosing moved here and the panel kept only the answer — see
 * `ModelPicker.tsx`. What the extra room buys, in order of how much it was
 * missing: a name that is not clipped, the family beside it, the readiness
 * state spelled out as words rather than inferred from a dimmed tile, a search
 * box for the day the list is long, and the "N hidden" reveal with space to
 * explain itself instead of a footnote under a grid.
 *
 * What it deliberately does *not* do is decide anything. Every model here comes
 * from a `Partition` that `visibility.ts` computed — what is hidden, what is
 * blocked and why — and the modal is only ever asked to draw it. That module's
 * header explains what was learned to get those rules right, and none of it is
 * worth re-deriving in a component.
 *
 * The other rule it inherits: it is never opened on a guess. `ModelPicker`
 * gates on `partition.pending`, so by the time this mounts every probe has
 * answered and no tile in it will move, disappear or change its badge while
 * being looked at.
 *
 * Style and a11y follow `settings/SettingsModal.tsx` — portal, backdrop click
 * to close, Escape, `role="dialog" aria-modal` — with a focus trap added,
 * because this dialog is a grid of buttons and Tab would otherwise walk out of
 * it into the form behind.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { JobKind } from '@comfy/shared';
import { type CapabilityMap, isFallbackFamily } from '../lib/api-jobs';
import { CloseIcon, WarningIcon } from './icons';
import { SearchIcon } from '../library/icons';
import { familyLabel } from '../models/catalogue';
import { modelWash } from './modelArt';
import { blockedReason, KIND_NOUN, stateLabel } from './modelReasons';
import type { CreateMode } from './mode';
import { modeOfKind } from './form';
import type { ReadinessMap } from './useReadiness';
import type { ModelEntry, Partition } from './visibility';
import styles from './modelModal.module.css';

export function ModelModal({
  partition,
  kind,
  capabilities,
  readiness,
  value,
  onChange,
  onClose,
  onModeChange,
}: {
  partition: Partition;
  kind: JobKind;
  capabilities: CapabilityMap;
  readiness: ReadinessMap;
  value: string | null;
  onChange: (modelId: string) => void;
  onClose: () => void;
  onModeChange?: (mode: CreateMode) => void;
}) {
  const [query, setQuery] = useState('');
  // Which blocked tile the user last pressed. A click on a model you cannot use
  // has to answer, or the tile is the silent wall the original report described.
  const [explainedId, setExplainedId] = useState<string | null>(null);
  // The hidden ones are noise by default — that is the whole point of hiding
  // them — but a list that quietly omits files the user installed is lying
  // about what is on the machine, so the reveal is always one press away.
  const [revealed, setRevealed] = useState(false);

  const sheet = useRef<HTMLDivElement>(null);
  // Where focus came from, so closing puts it back. Captured on mount rather
  // than read on close: by then the element may be gone.
  const opener = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  const mode = modeOfKind(kind);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus starts in the search box: it is the control that makes a long list
  // usable, and typing is what somebody opening this wants to do next.
  useEffect(() => {
    sheet.current?.querySelector<HTMLInputElement>('input')?.focus();
    const previous = opener.current;
    return () => previous?.focus?.();
  }, []);

  const hiddenCount = partition.hiddenNoTemplate.length;
  const shown = revealed
    ? [...partition.listed, ...partition.hiddenNoTemplate]
    : partition.listed;
  const needle = query.trim().toLowerCase();
  // Search matches the display name *and* the family, so "sdxl" finds the two
  // checkpoints whose names never mention it.
  const matches = useMemo(
    () =>
      needle
        ? shown.filter(
            (entry) =>
              entry.model.displayName.toLowerCase().includes(needle) ||
              (entry.model.baseModel ?? '').toLowerCase().includes(needle) ||
              (entry.model.filename ?? '').toLowerCase().includes(needle),
          )
        : shown,
    // `shown` is rebuilt every render; the identity that matters is the reveal
    // and the partition behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needle, revealed, partition],
  );

  const explained = matches.find((entry) => entry.model.id === explainedId) ?? null;
  const explainedReason =
    explained && !explained.runnable ? blockedReason(explained, kind, readiness) : null;

  const choose = (entry: ModelEntry) => {
    if (!entry.runnable) {
      // Not selectable, but not silent either.
      setExplainedId(entry.model.id);
      return;
    }
    onChange(entry.model.id);
    onClose();
  };

  // Arrow keys walk the grid. It is a radiogroup, so a keyboard user expects to
  // move between tiles with the arrows rather than Tab through every one of
  // them to reach the last.
  const onGridKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const tiles = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    if (tiles.length === 0) return;
    const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    tiles[(at + step + tiles.length) % tiles.length]?.focus();
  };

  // Tab must not walk out of a modal into the form it is covering.
  const onSheetKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button, input, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={sheet}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Choose a model"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onSheetKey}
      >
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Choose a model</h2>
            <p className={styles.subtitle}>
              {partition.runnable.length}{' '}
              {partition.runnable.length === 1 ? 'checkpoint can' : 'checkpoints can'} run{' '}
              {KIND_NOUN[mode]} jobs as the form stands.
            </p>
          </div>
          <label className={styles.search}>
            <SearchIcon size={14} />
            <input
              type="search"
              value={query}
              placeholder="Search models"
              aria-label="Search models"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Enter from the search box takes the first thing that can
                // actually run, which is the whole point of typing three
                // letters at a list.
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const first = matches.find((entry) => entry.runnable);
                if (first) choose(first);
              }}
            />
          </label>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close model picker">
            <CloseIcon size={16} />
          </button>
        </header>

        <div className={styles.body}>
          {matches.length === 0 ? (
            <p className={styles.note} role="status">
              <span>
                {needle
                  ? `Nothing installed matches “${query.trim()}”.`
                  : `No ${KIND_NOUN[mode]} models are installed.`}
              </span>
            </p>
          ) : (
            <div className={styles.grid} role="radiogroup" aria-label="Model" onKeyDown={onGridKey}>
              {matches.map((entry, index) => {
                const model = entry.model;
                const selected = model.id === value;
                const generic = entry.runnable && isFallbackFamily(model, capabilities);
                const label = stateLabel(entry, kind, readiness);

                return (
                  <button
                    key={model.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    // `aria-disabled`, never `disabled`: a disabled button takes
                    // no focus and fires no events, so the explanation for why
                    // you cannot pick it is unreachable by exactly the person
                    // asking for it. These take the press and answer it.
                    aria-disabled={!entry.runnable}
                    className={[
                      styles.tile,
                      selected ? styles.tileOn : '',
                      entry.runnable ? '' : styles.tileBlocked,
                      explainedId === model.id ? styles.tileExplained : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ '--i': index } as React.CSSProperties}
                    onClick={() => choose(entry)}
                  >
                    <span className={styles.art} style={modelWash(model)}>
                      {model.previewUrl ? (
                        <img className={styles.preview} src={model.previewUrl} alt="" loading="lazy" />
                      ) : null}
                    </span>
                    <span className={styles.meta}>
                      <span className={styles.name}>{model.displayName}</span>
                      <span className={styles.family}>
                        {model.baseModel ? familyLabel(model.baseModel) : 'Unclassified'}
                        {generic ? ' · generic workflow' : ''}
                      </span>
                      <span
                        className={entry.runnable ? styles.stateReady : styles.stateBlocked}
                      >
                        {label}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* The tile the user just pressed, answered in full — with the
              server's own remedy when it sent one, because "move it into
              models/checkpoints" is the whole value of having asked. */}
          {explainedReason ? (
            <p className={styles.note} role="status">
              <WarningIcon size={12} className={styles.noteIcon} />
              <span>
                <strong className={styles.noteStrong}>{explained?.model.displayName}</strong>{' '}
                {explainedReason.detail}
                {explainedReason.steps.length > 0 ? <> {explainedReason.steps.join(' ')}</> : null}
                {explainedReason.switchTo && onModeChange ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => {
                        onModeChange(explainedReason.switchTo!);
                        onClose();
                      }}
                    >
                      Switch to {explainedReason.switchTo === 'video' ? 'Video' : 'Image'} mode
                    </button>
                  </>
                ) : null}
              </span>
            </p>
          ) : null}
        </div>

        {/* The honest count. Only the *impossible* ones are counted: a video
            checkpoint missing from the Image tab is the toggle doing its job,
            and counting it would read as something being wrong. */}
        {hiddenCount > 0 ? (
          <footer className={styles.foot}>
            <span className={styles.footText}>
              {hiddenCount} {hiddenCount === 1 ? 'model' : 'models'} hidden — no workflow for{' '}
              {hiddenCount === 1 ? 'it' : 'them'} yet.
            </span>
            <button
              type="button"
              className={styles.link}
              aria-expanded={revealed}
              onClick={() => setRevealed((open) => !open)}
            >
              {revealed ? 'Hide again' : 'Show anyway'}
            </button>
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
