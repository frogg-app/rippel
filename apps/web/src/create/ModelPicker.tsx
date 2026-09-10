/**
 * The model tiles.
 *
 * The artboard draws three 70px tiles across the panel with the name over a
 * bottom scrim, the selected one ringed in accent. Real installs have more than
 * three, so this is a wrapping grid of the same tile at the same height.
 *
 * The part that matters more than the look: a model whose *family* has no
 * workflow template for the capability we are about to ask for cannot be
 * generated with. `POST /jobs` answers that with a 501 `no_template`, and
 * finding out by pressing Generate is a bad way to learn it.
 *
 * How that is *said* is the rest of the job here. The first version dimmed the
 * blocked tiles, badged them "No template" and put a count underneath, which
 * read — in the user's own words — as "I can't change models". So the states
 * were separated, and now they are separated again by *visibility*: see
 * `visibility.ts` for the rule. What is impossible is hidden and counted; what
 * is merely not-yet-possible stays on screen, blocked, carrying the remedy the
 * readiness endpoint gave us. An empty grid always says why it is empty.
 *
 * Blocked tiles use `aria-disabled` rather than `disabled`, deliberately. A
 * `disabled` button takes no focus, fires no events and shows no `title`
 * tooltip, so the explanation for why you cannot pick it is unreachable by
 * exactly the person asking. These take the click and answer it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JobKind, Model } from '@comfy/shared';
import { type CapabilityMap, isFallbackFamily } from '../lib/api-jobs';
import { WarningIcon } from './icons';
import type { CreateMode } from './mode';
import { modeOfKind } from './form';
import type { ReadinessMap } from './useReadiness';
import { type ModelEntry, type Partition, partitionModels } from './visibility';
import styles from './modelPicker.module.css';

export function ModelPicker({
  models,
  kind,
  capabilities,
  readiness,
  loading,
  error,
  value,
  onChange,
  onModeChange,
}: {
  models: Model[];
  /** The capability that will actually be submitted — see `effectiveKind`. */
  kind: JobKind;
  capabilities: CapabilityMap;
  /** Per-model, per-capability answers from the server. May be empty. */
  readiness: ReadinessMap;
  loading: boolean;
  error: string | null;
  value: string | null;
  onChange: (modelId: string) => void;
  /**
   * Switch the Image/Video toggle. Given so the picker can *offer* the fix
   * ("these are video models") instead of only naming the problem.
   */
  onModeChange?: (mode: CreateMode) => void;
}) {
  // Which blocked tile the user last pressed. A click on a model you cannot
  // use has to answer, or the tile is the silent wall the report describes.
  const [explainedId, setExplainedId] = useState<string | null>(null);
  // "2 models hidden — no workflow for them yet", opened. Off by default: the
  // whole point is that they are noise. Available because a list that quietly
  // omits things the user installed is lying about what is on the machine.
  const [revealed, setRevealed] = useState(false);

  // Verdicts landing can drop a whole grid row, and a row vanishing under the
  // cursor shoves the quality preset and everything below it up the panel. So
  // the grid's height is animated across that one moment instead: pinned to
  // the height it had, then transitioned to the height it now wants, then let
  // go. `min-height: auto` is not an animatable endpoint, which is why the
  // target is a measured number and not simply released.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const lastGridHeight = useRef(0);
  const wasPending = useRef(readiness.loading);
  const [collapse, setCollapse] = useState<{ phase: 'from' | 'to'; height: number } | null>(null);

  // Runs after every commit, which is how it has the previous render's height
  // to hand on the render that drops a row.
  useLayoutEffect(() => {
    const settled = wasPending.current && !readiness.loading;
    wasPending.current = readiness.loading;
    const now = gridRef.current?.offsetHeight ?? 0;
    if (settled && lastGridHeight.current > 0 && now !== lastGridHeight.current) {
      setCollapse({ phase: 'from', height: lastGridHeight.current });
      return;
    }
    if (!collapse) lastGridHeight.current = now;
  });

  // Two frames and a timer: one frame at the old height to transition from,
  // then the new height, then the inline style goes away so the grid is free
  // again. Keyed on the phase rather than dependency-free — an effect that
  // reran on every render would cancel its own pending frame forever, and the
  // grid would keep the dead space for good.
  useEffect(() => {
    if (!collapse) return undefined;
    if (collapse.phase === 'from') {
      const frame = requestAnimationFrame(() => {
        const height = gridRef.current?.offsetHeight ?? 0;
        setCollapse({ phase: 'to', height });
      });
      return () => cancelAnimationFrame(frame);
    }
    const timer = setTimeout(() => {
      lastGridHeight.current = gridRef.current?.offsetHeight ?? 0;
      setCollapse(null);
    }, 260);
    return () => clearTimeout(timer);
  }, [collapse]);

  const mode = modeOfKind(kind);
  // A mode change re-derives the whole list; anything opened or explained about
  // the old one is about models that may no longer be here.
  useEffect(() => {
    setRevealed(false);
    setExplainedId(null);
  }, [mode]);

  if (loading) {
    return (
      <div className={styles.grid} aria-busy>
        {[0, 1, 2].map((index) => (
          <div key={index} className={`${styles.tile} ${styles.skeleton}`} />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className={styles.note}>{error}</p>;
  }

  if (models.length === 0) {
    return (
      <p className={styles.note}>
        No checkpoints discovered yet. The backend poller finds them
        automatically once a ComfyUI server with models on disk is online.
      </p>
    );
  }

  const otherMode: CreateMode = mode === 'image' ? 'video' : 'image';
  const partition = partitionModels(models, kind, capabilities, readiness);
  const { listed, runnable, hiddenNoTemplate } = partition;
  const shown = revealed ? [...listed, ...hiddenNoTemplate] : listed;

  const explainedEntry =
    [...listed, ...partition.hidden].find((entry) => entry.model.id === explainedId) ?? null;
  const explainedReason =
    explainedEntry && !explainedEntry.runnable
      ? blockedReason(explainedEntry, kind, capabilities, readiness)
      : null;

  return (
    <>
      {/* Keyed by mode: the grid re-enters, tiles staggering in, when the
          toggle flips. */}
      {shown.length > 0 ? (
        <div
          className={styles.gridHold}
          style={collapse ? { height: collapse.height, overflow: 'hidden' } : undefined}
        >
        <div ref={gridRef} key={mode} className={styles.grid} role="radiogroup" aria-label="Model">
          {shown.map((entry, index) => {
            const model = entry.model;
            // Pending tiles are plain and pressable. We have no verdict, and a
            // guess dressed as one is what we are here to stop drawing.
            const supported = entry.runnable || entry.pending;
            const selected = model.id === value;
            const reason = supported
              ? null
              : blockedReason(entry, kind, capabilities, readiness);
            const generic = entry.runnable && isFallbackFamily(model, capabilities);

            return (
              <button
                key={model.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={!supported}
                title={
                  reason
                    ? `${model.displayName}: ${reason.detail}`
                    : generic
                      ? `${model.displayName} · ${model.baseModel ?? 'unknown family'} · generic workflow`
                      : `${model.displayName} · ${model.baseModel ?? 'unknown family'}`
                }
                className={[
                  styles.tile,
                  selected ? styles.tileOn : '',
                  supported ? '' : styles.tileBlocked,
                  explainedId === model.id ? styles.tileExplained : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ ...tileArt(model), '--i': index } as React.CSSProperties}
                onClick={() => {
                  if (supported) {
                    setExplainedId(null);
                    onChange(model.id);
                  } else {
                    // Not selectable, but not silent either.
                    setExplainedId(model.id);
                  }
                }}
              >
                {model.previewUrl ? (
                  <img className={styles.art} src={model.previewUrl} alt="" loading="lazy" />
                ) : null}
                <span className={styles.name}>{model.displayName}</span>
                {reason ? <span className={styles.badge}>{reason.badge}</span> : null}
                {/* A generic template will probably work and may look wrong; say
                    so quietly rather than either hiding it or blocking it. */}
                {generic ? <span className={styles.badgeSoft}>generic</span> : null}
              </button>
            );
          })}
        </div>
        </div>
      ) : null}

      <div className={styles.notes}>
      {/* Nothing to draw. An empty grid with no words is worse than the greyed
          tiles it replaced, so this always says what happened and what would
          change it. */}
      {listed.length === 0 && !partition.pending ? <EmptyState
        mode={mode}
        otherMode={otherMode}
        partition={partition}
        onModeChange={onModeChange}
      /> : null}

      {/* The tile the user just pressed, answered in full. */}
      {explainedReason ? (
        <p className={styles.note} role="status">
          <WarningIcon size={12} className={styles.noteIcon} />
          <span>
            <strong className={styles.noteStrong}>{explainedEntry?.model.displayName}</strong>{' '}
            {explainedReason.detail}
            {explainedReason.steps.length > 0 ? (
              <> {explainedReason.steps.join(' ')}</>
            ) : null}
            {explainedReason.switchTo && onModeChange ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => {
                    onModeChange(explainedReason.switchTo!);
                    setExplainedId(null);
                  }}
                >
                  Switch to {explainedReason.switchTo === 'video' ? 'Video' : 'Image'} mode
                </button>
              </>
            ) : null}
          </span>
        </p>
      ) : listed.length > 0 && runnable.length === 0 && !partition.pending ? (
        <p className={styles.note}>
          <WarningIcon size={12} className={styles.noteIcon} />
          <span>
            {listed.every((entry) => entry.blocked === 'needs-setup') ? (
              <>
                The {KIND_NOUN[mode]} models on this machine need setting up before they can run.
                Press one to see what it needs.
              </>
            ) : (
              <>
                Nothing here can run a {KIND_NOUN[mode]} job as the form stands. Press a tile to
                see what it needs.
              </>
            )}
          </span>
        </p>
      ) : null}

      {/* The honest count. Hiding a checkpoint the user installed is fine;
          not saying so is not. */}
      {hiddenNoTemplate.length > 0 && !partition.pending ? (
        <p className={styles.note}>
          <span>
            {hiddenNoTemplate.length} {hiddenNoTemplate.length === 1 ? 'model' : 'models'} hidden —
            no workflow for {hiddenNoTemplate.length === 1 ? 'it' : 'them'} yet.{' '}
            <button
              type="button"
              className={styles.link}
              aria-expanded={revealed}
              onClick={() => setRevealed((open) => !open)}
            >
              {revealed ? 'Hide again' : 'Show anyway'}
            </button>
          </span>
        </p>
      ) : null}
      </div>
    </>
  );
}

/**
 * What the panel says instead of a grid.
 *
 * Three different nothings, and only one of them is "you have no models": the
 * other two are "your models are in the other tab" and "the models you have
 * need work first", and each carries the action that resolves it.
 */
function EmptyState({
  mode,
  otherMode,
  partition,
  onModeChange,
}: {
  mode: CreateMode;
  otherMode: CreateMode;
  partition: Partition;
  onModeChange?: (mode: CreateMode) => void;
}) {
  const elsewhere = partition.otherMode.map((entry) => entry.model);
  const hidden = partition.hiddenNoTemplate.length;

  return (
    <p className={styles.note} role="status">
      <WarningIcon size={12} className={styles.noteIcon} />
      <span>
        {elsewhere.length > 0 ? (
          <>
            No {KIND_NOUN[mode]} models are installed. {listNames(elsewhere)}{' '}
            {elsewhere.length === 1 ? 'is a' : 'are'} {KIND_NOUN[otherMode]}{' '}
            {elsewhere.length === 1 ? 'model' : 'models'}.
            {onModeChange ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => onModeChange(otherMode)}
                >
                  Switch to {otherMode === 'video' ? 'Video' : 'Image'} mode
                </button>
              </>
            ) : null}
          </>
        ) : hidden > 0 ? (
          <>
            No {KIND_NOUN[mode]} models are installed. {hidden}{' '}
            {hidden === 1 ? 'checkpoint is' : 'checkpoints are'} hidden because nothing here knows
            how to build a graph for {hidden === 1 ? 'it' : 'them'}.{' '}
            <a className={styles.link} href="/models">
              Manage models
            </a>
          </>
        ) : (
          <>
            No {KIND_NOUN[mode]} models are installed.{' '}
            <a className={styles.link} href="/models">
              Manage models
            </a>
          </>
        )}
      </span>
    </p>
  );
}

// ---------------------------------------------------------------- reasons

const KIND_NOUN: Record<CreateMode, string> = { image: 'image', video: 'video' };

interface BlockedReason {
  /** Two words, on the tile. */
  badge: string;
  /** The sentence, in the note and the tooltip. */
  detail: string;
  /** The server's own remedy, when it gave one. */
  steps: string[];
  /** The mode that *would* run this model, when there is one. */
  switchTo: CreateMode | null;
}

/**
 * Why this model cannot run this job — the specific answer, not the count.
 *
 * The states that reach a *visible* tile are the fixable ones: the backend is
 * missing a file (the server tells us which, and how to fix it), or the job
 * wants a starting image. The unfixable ones are hidden, and only reach here
 * through the "show anyway" reveal, where the honest answer is that nobody has
 * written a graph for this family.
 */
export function blockedReason(
  entry: ModelEntry,
  kind: JobKind,
  capabilities: CapabilityMap,
  readiness: ReadinessMap,
): BlockedReason {
  const model = entry.model;
  const family = model.baseModel ?? 'this family';
  const mode = modeOfKind(kind);
  const answer = readiness.here[model.id];

  if (entry.blocked === 'needs-setup') {
    return {
      badge: 'Needs setup',
      detail: `cannot run here yet: ${answer?.summary ?? 'the backend is not set up for it.'}`,
      steps: answer?.steps ?? [],
      switchTo: null,
    };
  }

  if (entry.blocked === 'needs-image') {
    return {
      badge: 'Needs an image',
      detail: 'only runs from a starting image. Add one above and it becomes selectable.',
      steps: [],
      switchTo: null,
    };
  }

  if (entry.hidden === 'other-mode' && entry.runsInMode) {
    const only = entry.runsInMode;
    return {
      badge: only === 'video' ? 'Video model' : 'Image model',
      detail: `is a ${KIND_NOUN[only]} model — it runs ${KIND_NOUN[only]} jobs, not ${KIND_NOUN[mode]} ones.`,
      steps: [],
      switchTo: only,
    };
  }

  void capabilities;
  return {
    badge: 'No template',
    detail:
      answer?.summary ??
      `has no workflow template yet — nothing here knows how to build a graph for ${family}.`,
    steps: [],
    switchTo: null,
  };
}

/** "Hunyuan Video 720p and Ltx Video" — at most three, then "and 2 more". */
function listNames(models: Model[]): string {
  const names = models.slice(0, 2).map((model) => model.displayName);
  const rest = models.length - names.length;
  if (rest > 0) return `${names.join(', ')} and ${rest} more`;
  return names.length === 2 ? `${names[0]} and ${names[1]}` : (names[0] ?? '');
}

/**
 * A deterministic wash for a model with no preview image.
 *
 * Exported because the extra-styles picker needs the same fallback: one path
 * for "this file has no picture", not two that disagree.
 *
 * Every discovered local model has `previewUrl: null` — nothing has downloaded
 * a Civitai card for it — so this is the *normal* case, not a fallback. The hue
 * is derived from the id so a given checkpoint keeps its colour between
 * sessions and becomes recognisable by it.
 */
export function tileArt(model: Model): React.CSSProperties {
  let hash = 0;
  for (const char of model.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return {
    background: `radial-gradient(120% 100% at 30% 20%, hsl(${hue} 85% 62%) 0%, hsl(${(hue + 40) % 360} 55% 32%) 55%, hsl(${(hue + 220) % 360} 45% 9%) 100%)`,
  };
}
