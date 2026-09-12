/**
 * The model, as the Create panel shows it: one row saying what is chosen, and a
 * press away from choosing something else.
 *
 * This was a grid of 72px tiles, and it had two faults that turned out to be
 * the same fault.
 *
 * The first was room. Every installed checkpoint was drawn into a 396px column
 * between the reference image and the quality preset, which clipped names,
 * stacked badges over art and pushed the rest of the form down by a row per
 * three models. The choosing now happens in `ModelModal.tsx`, which has space
 * for names, families, readiness and a search box; this component keeps only
 * the answer.
 *
 * The second was the jump on reload. `visibility.ts` already refused to hide a
 * model on a probe that had not answered, and marked such entries `pending` —
 * but a pending entry was still *listed*, and the grid drew every listed entry.
 * So whenever the capability map said a family could do this mode and the
 * per-model probe later said this machine could not (Hunyuan under Video with
 * no template installed; every model at all when `GET /workflows` failed and
 * the map was not live), the tile was painted and then removed. `pending`
 * stopped a wrong *badge*; it never stopped a wrong *set*. A grid animation that
 * held the old height for 260ms made the removal slide instead of snap, which
 * is the same bug made smoother.
 *
 * The rule now is the one the user asked for: only populate with valid models.
 * Until every probe in the pass has answered, this draws a skeleton of the same
 * size and nothing else — no names, no count, no selection — and the modal
 * cannot be opened. When it does draw, it is drawing a settled `Partition`, and
 * the preselect in `CreatePage` has already run in a layout effect in the same
 * commit, so the first model name the user sees is the one that stays.
 */
import { useState } from 'react';
import type { JobKind, Model } from '@comfy/shared';
import type { CapabilityMap } from '../lib/api-jobs';
import { familyLabel } from '../models/catalogue';
import { ChevronDownIcon } from '../components/icons';
import { WarningIcon } from './icons';
import { modelWash } from './modelArt';
import { ModelModal } from './ModelModal';
import { blockedReason, KIND_NOUN, listNames, stateLabel } from './modelReasons';
import type { CreateMode } from './mode';
import { modeOfKind } from './form';
import type { ReadinessMap } from './useReadiness';
import type { Partition } from './visibility';
import styles from './modelPicker.module.css';

export function ModelPicker({
  models,
  partition,
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
  /**
   * The verdicts, computed once by the page. Passed in rather than re-derived
   * here so the summary, the modal and the page's selection repair can never
   * disagree about which models exist.
   */
  partition: Partition;
  /** The capability that will actually be submitted — see `effectiveKind`. */
  kind: JobKind;
  capabilities: CapabilityMap;
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
  const [open, setOpen] = useState(false);
  const mode = modeOfKind(kind);
  const otherMode: CreateMode = mode === 'image' ? 'video' : 'image';

  if (error) {
    return <p className={styles.note}>{error}</p>;
  }

  if (!loading && models.length === 0) {
    return (
      <p className={styles.note}>
        No checkpoints discovered yet. The backend poller finds them
        automatically once a ComfyUI server with models on disk is online.
      </p>
    );
  }

  // The whole fix for the reload jump, in one condition. Anything drawn before
  // this is false would be a guess that the probes are about to correct.
  if (loading || partition.pending) {
    return (
      <div className={`${styles.summary} ${styles.skeleton}`} aria-busy="true">
        <span className={styles.visuallyHidden}>Checking which models can run…</span>
      </div>
    );
  }

  const { listed, runnable } = partition;
  const hiddenCount = partition.hiddenNoTemplate.length;
  const selected = listed.find((entry) => entry.model.id === value) ?? null;
  const reason = selected && !selected.runnable ? blockedReason(selected, kind, readiness) : null;

  return (
    <>
      {listed.length > 0 ? (
        <button
          type="button"
          className={styles.summary}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={
            selected
              ? `Change model: ${selected.model.displayName}, ${stateLabel(selected, kind, readiness)}`
              : 'Choose a model'
          }
          onClick={() => setOpen(true)}
        >
          <span className={styles.thumb} style={selected ? modelWash(selected.model) : undefined}>
            {selected?.model.previewUrl ? (
              <img className={styles.art} src={selected.model.previewUrl} alt="" />
            ) : null}
          </span>
          <span className={styles.meta}>
            <span className={styles.name}>
              {selected ? selected.model.displayName : 'Choose a model'}
            </span>
            <span className={styles.family}>
              {selected
                ? `${selected.model.baseModel ? familyLabel(selected.model.baseModel) : 'Unclassified'} · ${stateLabel(selected, kind, readiness)}`
                : `${listed.length} ${listed.length === 1 ? 'model' : 'models'} for ${KIND_NOUN[mode]}`}
            </span>
          </span>
          <span className={styles.change}>
            {listed.length > 1 ? `${listed.length} models` : 'Details'}
            <ChevronDownIcon size={13} />
          </span>
        </button>
      ) : null}

      <div className={styles.notes}>
        {listed.length === 0 ? (
          <EmptyState
            mode={mode}
            otherMode={otherMode}
            partition={partition}
            onModeChange={onModeChange}
            onReveal={hiddenCount > 0 ? () => setOpen(true) : undefined}
          />
        ) : reason ? (
          // The selected model has become one that cannot run — a starting
          // image was removed from under an img2vid model, say. Its reason is
          // the most useful sentence on the panel, so it is not hidden in the
          // modal.
          <p className={styles.note} role="status">
            <WarningIcon size={12} className={styles.noteIcon} />
            <span>
              <strong className={styles.noteStrong}>{selected?.model.displayName}</strong>{' '}
              {reason.detail}
              {reason.steps.length > 0 ? <> {reason.steps.join(' ')}</> : null}
            </span>
          </p>
        ) : runnable.length === 0 ? (
          <p className={styles.note}>
            <WarningIcon size={12} className={styles.noteIcon} />
            <span>
              {listed.every((entry) => entry.blocked === 'needs-setup') ? (
                <>
                  The {KIND_NOUN[mode]} models on this machine need setting up before they can run.
                  Open the list to see what each one needs.
                </>
              ) : (
                <>
                  Nothing here can run a {KIND_NOUN[mode]} job as the form stands. Open the list
                  to see what each model needs.
                </>
              )}
            </span>
          </p>
        ) : null}
      </div>

      {open ? (
        <ModelModal
          partition={partition}
          kind={kind}
          capabilities={capabilities}
          readiness={readiness}
          value={value}
          onChange={onChange}
          onClose={() => setOpen(false)}
          onModeChange={onModeChange}
        />
      ) : null}
    </>
  );
}

/**
 * What the panel says instead of a model.
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
  onReveal,
}: {
  mode: CreateMode;
  otherMode: CreateMode;
  partition: Partition;
  onModeChange?: (mode: CreateMode) => void;
  onReveal?: () => void;
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
            {onReveal ? (
              <button type="button" className={styles.link} onClick={onReveal}>
                See {hidden === 1 ? 'it' : 'them'}
              </button>
            ) : null}{' '}
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
