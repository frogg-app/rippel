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
 * Each tile leads with what the model is *for* — the family's everyday name
 * and a one-line "good for" from `families.ts` — and keeps the model's own
 * name underneath, quietly. Somebody choosing for the first time chooses by
 * the first line; somebody with three SDXL merges tells them apart by the
 * last.
 *
 * Blocked tiles use `aria-disabled` rather than `disabled`, deliberately. A
 * `disabled` button takes no focus, fires no events and shows no `title`
 * tooltip, so the explanation for why you cannot pick it is unreachable by
 * exactly the person asking. These take the click and answer it.
 */
import { useContext, useEffect, useState } from 'react';
import type { JobKind, Model } from '@comfy/shared';
import { ApiRequestError } from '../lib/api';
import { type CapabilityMap, isFallbackFamily, readinessApi } from '../lib/api-jobs';
import { WarningIcon } from './icons';
import type { CreateMode } from './mode';
import { modeOfKind } from './form';
import { invalidateReadiness, type ReadinessMap } from './useReadiness';
import { AuthContext } from '../auth/context';
import { isSelectable, type Partition, partitionModels } from './visibility';
import { modelWash } from './modelArt';
import { familyHint, familyWords } from './families';
import { findModelsHref } from './discoverLinks';
import {
  type BlockedReason,
  KIND_NOUN,
  NOT_SUPPORTED,
  blockedReason,
  fitPills,
  listNames,
  missingSentence,
} from './modelReasons';
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

  const mode = modeOfKind(kind);
  // A mode change re-derives the whole list; anything opened or explained about
  // the old one is about models that may no longer be here.
  useEffect(() => {
    setRevealed(false);
    setExplainedId(null);
  }, [mode]);

  if (loading || readiness.loading) {
    return (
      <div className={styles.grid} aria-busy aria-label="Loading models">
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
    return <FirstRun mode={mode} />;
  }

  const otherMode: CreateMode = mode === 'image' ? 'video' : 'image';
  const partition = partitionModels(models, kind, capabilities, readiness);
  const { listed, runnable, hiddenNoTemplate } = partition;
  const shown = revealed ? [...listed, ...hiddenNoTemplate] : listed;

  const explainedEntry =
    [...listed, ...partition.hidden].find((entry) => entry.model.id === explainedId) ?? null;
  const explainedReason =
    explainedEntry && !explainedEntry.runnable
      ? blockedReason(explainedEntry, kind, readiness)
      : null;

  return (
    <>
      {/* Keyed by mode: the grid re-enters, tiles staggering in, when the
          toggle flips. */}
      {shown.length > 0 ? (
        <div key={mode} className={styles.grid} role="radiogroup" aria-label="Model">
          {shown.map((entry, index) => {
            const model = entry.model;
            const supported = entry.runnable;
            // A model waiting on parts can be chosen: the notice under the grid
            // then names the parts and installs them, and Generate waits.
            const selectable = isSelectable(entry);
            const pills = fitPills(entry, kind, readiness);
            const selected = model.id === value;
            const reason = supported ? null : blockedReason(entry, kind, readiness);
            const generic = entry.runnable && isFallbackFamily(model, capabilities);
            const family = familyWords(model.baseModel);
            const hint = familyHint(model.baseModel);

            return (
              <button
                key={model.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={!selectable}
                title={
                  reason
                    ? `${model.displayName}: ${reason.detail}`
                    : `${family.label} · ${model.filename}${generic ? ' · generic workflow' : ''}`
                }
                className={[
                  styles.tile,
                  selected ? styles.tileOn : '',
                  supported ? '' : selectable ? styles.tileDim : styles.tileBlocked,
                  explainedId === model.id ? styles.tileExplained : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ '--i': index } as React.CSSProperties}
                onClick={() => {
                  if (selectable) {
                    setExplainedId(null);
                    onChange(model.id);
                  } else {
                    // Not selectable, but not silent either.
                    setExplainedId(model.id);
                  }
                }}
              >
                <span className={styles.tileArt} style={modelWash(model)}>
                  {model.previewUrl ? (
                    <img className={styles.art} src={model.previewUrl} alt="" loading="lazy" />
                  ) : null}
                </span>
                <span className={styles.tileMeta}>
                  <span className={styles.tileFamily}>{family.label}</span>
                  {hint ? <span className={styles.tileHint}>{hint}</span> : null}
                  <span className={styles.tileName}>{model.displayName}</span>
                  <span className={styles.pills}>
                    {pills.map((pill) => (
                      <span key={pill.label} className={`${styles.badge} ${styles[`pill_${pill.tone}`]}`}>
                        {pill.label}
                      </span>
                    ))}
                  </span>
                </span>
                {/* A generic template will probably work and may look wrong; say
                    so quietly rather than either hiding it or blocking it. */}
                {generic ? <span className={styles.badgeSoft}>generic</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className={styles.notes}>
        {/* Nothing to draw. An empty grid with no words is worse than the greyed
            tiles it replaced, so this always says what happened and what would
            change it. */}
        {listed.length === 0 && !partition.pending ? (
          <EmptyState
            mode={mode}
            otherMode={otherMode}
            partition={partition}
            onModeChange={onModeChange}
          />
        ) : null}

        {/* The tile the user just pressed, answered in full. */}
        {explainedReason && explainedEntry ? (
          <Explained
            model={explainedEntry.model}
            kind={kind}
            reason={explainedReason}
            onModeChange={
              explainedReason.switchTo && onModeChange
                ? () => {
                    onModeChange(explainedReason.switchTo!);
                    setExplainedId(null);
                  }
                : undefined
            }
          />
        ) : listed.length > 0 && runnable.length === 0 && !partition.pending ? (
          <p className={styles.note}>
            <WarningIcon size={12} className={styles.noteIcon} />
            <span>
              {listed.every((entry) => entry.blocked === 'needs-setup') ? (
                <>
                  These models need a file or two first.
                </>
              ) : (
                <>
                  None of these can run yet.
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
              rippel doesn’t know how to use {hiddenNoTemplate.length === 1 ? 'it' : 'them'} yet.{' '}
              <button
                type="button"
                className={styles.link}
                aria-expanded={revealed}
                onClick={() => setRevealed((open) => !open)}
              >
                {revealed ? 'Hide again' : 'Show anyway'}
              </button>{' '}
              <a className={styles.link} href="/models">
                Open Models
              </a>
            </span>
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * The answer to pressing a blocked tile.
 *
 * A model waiting on a file says so in one plain sentence and carries the
 * button that fetches it. The server's own summary ("the T5 text encoder is
 * not installed") is kept, but second and smaller: it is the line to read out
 * to whoever does know ComfyUI.
 */
function Explained({
  model,
  kind,
  reason,
  onModeChange,
}: {
  model: Model;
  kind: JobKind;
  reason: BlockedReason;
  onModeChange?: () => void;
}) {
  const plain = missingSentence(reason.missing);
  return (
    <div className={styles.note} role="status">
      <WarningIcon size={12} className={styles.noteIcon} />
      <span>
        {plain ? (
          <>
            <strong className={styles.noteStrong}>{plain}</strong>{' '}
            {reason.installable ? <GetIt model={model} kind={kind} /> : null}
            <span className={styles.noteExpert}>
              {' '}
              {model.displayName} {reason.detail}
              {reason.steps.length > 0 ? <> {reason.steps.join(' ')}</> : null}
            </span>
          </>
        ) : (
          <>
            <strong className={styles.noteStrong}>{model.displayName}</strong> {reason.detail}
            {reason.badge === NOT_SUPPORTED && (
              <>
                <span> Text to video starts from a prompt; image to video needs a starting image. </span>
                <a className={styles.link} href="/models?workflows=1">
                  Find compatible workflows
                </a>
              </>
            )}
            {reason.steps.length > 0 ? <> {reason.steps.join(' ')}</> : null}
            {reason.installable ? <> <GetIt model={model} kind={kind} /></> : null}
          </>
        )}
        {reason.switchTo && onModeChange ? (
          <>
            {' '}
            <button type="button" className={styles.link} onClick={onModeChange}>
              Switch to {reason.switchTo === 'video' ? 'Video' : 'Image'} mode
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

/**
 * "Get it": queue the downloads readiness offered for this model's gaps.
 *
 * The same `POST /backends/:id/readiness/install` the Models page uses, so the
 * download appears in its installs list and nothing here tracks progress of
 * its own. Downloading is an admin action on the server; a 403 is turned into
 * the sentence a non-admin needs rather than shown as an error code.
 */
function GetIt({ model, kind }: { model: Model; kind: JobKind }) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'done'; text: string; started: boolean }
    | { kind: 'error'; text: string }
  >({ kind: 'idle' });
  // Read softly: the picker is also rendered outside the signed-in shell, and
  // not knowing who is asking means offering the button and letting the server
  // decide, which is what happened before.
  const user = useContext(AuthContext)?.user ?? null;
  const backendId = model.backendIds[0];
  const downloading = state.kind === 'done' && state.started;

  // Once the parts are downloading, keep asking until the model is ready, then
  // let the picker know — so the tile becomes choosable when the file lands
  // rather than after somebody thinks to reload the page.
  useEffect(() => {
    if (!downloading || !backendId) return;
    const timer = window.setInterval(() => {
      readinessApi
        .get(backendId, model.id, kind)
        .then((readiness) => {
          if (readiness.state !== 'ready') return;
          window.clearInterval(timer);
          invalidateReadiness(backendId, model.id);
        })
        .catch(() => {
          // A missed poll is just a later one.
        });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [downloading, backendId, model.id, kind]);

  if (!backendId) return null;
  // Downloading is an admin action on the server. Better to say who can do it
  // than to offer a button that can only refuse.
  if (user && user.role !== 'admin') {
    return <span>An admin can download the missing file for you.</span>;
  }

  if (state.kind === 'done' || state.kind === 'error') {
    return <span role={state.kind === 'error' ? 'alert' : undefined}>{state.text}</span>;
  }
  return (
    <button
      type="button"
      className={styles.getIt}
      disabled={state.kind === 'busy'}
      onClick={() => {
        setState({ kind: 'busy' });
        readinessApi
          .installMissing(backendId, model.id, kind)
          .then((result) => {
            const skipped = result.skipped.map((entry) => entry.reason);
            setState({
              kind: 'done',
              started: result.installs.length > 0,
              text:
                result.installs.length > 0
                  ? 'Downloading now — this model becomes selectable by itself once it finishes. Progress is on the Models page.'
                  : skipped[0] ?? 'Nothing left to download. Try reloading the page.',
            });
          })
          .catch((cause: unknown) => {
            setState({
              kind: 'error',
              text:
                cause instanceof ApiRequestError && cause.status === 403
                  ? 'Only an admin can download files. Ask one to open this model and press Get it.'
                  : cause instanceof Error
                    ? cause.message
                    : 'Could not start the download. Try again.',
            });
          });
      }}
    >
      {state.kind === 'busy' ? 'Starting…' : 'Get it'}
    </button>
  );
}

/**
 * Nothing installed at all: the very first visit. Not a warning — there is
 * nothing wrong — but an invitation with one obvious next step.
 */
function FirstRun({ mode }: { mode: CreateMode }) {
  return (
    <div className={styles.firstRun} role="status">
      <p className={styles.firstRunTitle}>
        You don’t have a model for making {KIND_NOUN[mode]}s yet
      </p>
      <p className={styles.firstRunText}>
        A model is the engine that makes the {KIND_NOUN[mode]}. Pick one from the catalogue and
        rippel downloads it for you.
      </p>
      <a className={styles.firstRunAction} href={findModelsHref(mode)}>
        Find {mode === 'image' ? 'an image' : 'a video'} model
      </a>
    </div>
  );
}

/**
 * What the panel says instead of a grid.
 *
 * Three different nothings, and only one of them is "you have no models": the
 * other two are "your models are in the other tab" and "the models you have
 * need work first", and each carries the action that resolves it. All three
 * end with the way to get one for *this* mode, because switching tabs is only
 * an answer if the other tab is what you wanted.
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

  return (
    <div className={styles.firstRun} role="status">
      <p className={styles.firstRunTitle}>
        You don’t have a model for making {KIND_NOUN[mode]}s yet
      </p>
      {elsewhere.length > 0 ? (
        <p className={styles.firstRunText}>
          {listNames(elsewhere)} {elsewhere.length === 1 ? 'makes' : 'make'} {KIND_NOUN[otherMode]}s.
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
        </p>
      ) : (
        <p className={styles.firstRunText}>
          A model is the engine that makes the {KIND_NOUN[mode]}. Pick one from the catalogue and
          rippel downloads it for you.
        </p>
      )}
      <a className={styles.firstRunAction} href={findModelsHref(mode)}>
        Find {mode === 'image' ? 'an image' : 'a video'} model
      </a>
    </div>
  );
}
