/**
 * The right-hand side: whatever is happening to the current job, at full size.
 *
 * Five states share one frame, because the artboard gives them one frame — the
 * 820x462 canvas never moves, it only changes what it holds:
 *
 *   nothing     an invitation
 *   queued      position in the queue, no bar (there is nothing to measure yet)
 *   running     the progress row, and the live preview once one arrives
 *   complete    the results, with a strip when there is more than one
 *   failed      the server's message, verbatim
 *
 * Progress numbers come from `JobProgress` and nowhere else: `fraction` drives
 * the bar, `step`/`totalSteps` the counter, `etaSeconds` the time. When the
 * backend reports none of them, the row honestly says so rather than animating
 * a fake bar.
 */
import { useEffect, useState } from 'react';
import type { Asset, Job } from '@comfy/shared';
import { SparkIcon } from '../components/icons';
import { DownloadIcon, PlayIcon, RemixIcon } from './icons';
import { isTerminal } from './jobProgress';
import styles from './stage.module.css';

export function JobStage({
  job,
  submitting,
  submitError,
  disconnected,
  onCancel,
  onRemix,
  onDismiss,
}: {
  job: Job | null;
  submitting: boolean;
  submitError: string | null;
  /** The socket is down. Shown quietly; the job itself is unaffected. */
  disconnected: boolean;
  onCancel: () => void;
  onRemix: (job: Job) => void;
  onDismiss: () => void;
}) {
  const assets = job?.assets ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Follow the job: a new set of results always selects the first.
  useEffect(() => {
    setSelectedId(assets[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, assets.length]);

  const selected = assets.find((asset) => asset.id === selectedId) ?? assets[0] ?? null;

  return (
    <section className={styles.stage} aria-label="Current job">
      <div className={styles.glow} aria-hidden />
      <div className={styles.inner}>
        <StatusRow
          job={job}
          submitting={submitting}
          disconnected={disconnected}
          onCancel={onCancel}
          onDismiss={onDismiss}
        />

        <div className={styles.canvas}>
          {submitError ? (
            <Message title="That job did not start" body={submitError} tone="danger" />
          ) : !job ? (
            <Message
              title="Nothing running"
              body="The job you start appears here at full size, with live preview and per-result actions."
            />
          ) : job.status === 'failed' ? (
            <Message title="Generation failed" body={job.error ?? 'The backend gave no reason.'} tone="danger" />
          ) : job.status === 'cancelled' ? (
            <Message title="Cancelled" body="Nothing was saved to your library." />
          ) : selected ? (
            <img className={styles.result} src={selected.url} alt="" />
          ) : job.progress.previewUrl ? (
            <>
              <img className={styles.preview} src={job.progress.previewUrl} alt="" />
              <div className={styles.previewScrim} aria-hidden />
              <span className={styles.previewBadge}>LIVE PREVIEW</span>
            </>
          ) : (
            <Waiting job={job} />
          )}
        </div>

        <div className={styles.tray}>
          <div className={styles.strip}>
            {assets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                aria-label="Show this result"
                aria-pressed={asset.id === selected?.id}
                className={asset.id === selected?.id ? `${styles.thumb} ${styles.thumbOn}` : styles.thumb}
                onClick={() => setSelectedId(asset.id)}
              >
                <img src={asset.thumbUrl} alt="" />
              </button>
            ))}
            {/* The artboard's dashed placeholders: the batch you asked for,
                minus what has landed, so the strip does not reflow as results
                arrive one at a time. */}
            {job && !isTerminal(job.status)
              ? Array.from({ length: Math.max(0, job.params.batchSize - assets.length) }, (_, index) => (
                  <span key={`pending-${index}`} className={styles.thumbPending} aria-hidden />
                ))
              : null}
          </div>

          <div className={styles.actions}>
            <ResultActions job={job} asset={selected} onRemix={onRemix} />
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- status row

function StatusRow({
  job,
  submitting,
  disconnected,
  onCancel,
  onDismiss,
}: {
  job: Job | null;
  submitting: boolean;
  disconnected: boolean;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (!job && !submitting) {
    return (
      <div className={styles.statusRow}>
        <span className={styles.dotIdle} />
        <span className={styles.statusLabel}>Idle</span>
        <div className={styles.spacer} />
        {disconnected ? <span className={styles.offline}>Reconnecting…</span> : null}
      </div>
    );
  }

  const status = job?.status ?? 'queued';
  const { step, totalSteps, fraction, etaSeconds } = job?.progress ?? {
    step: null,
    totalSteps: null,
    fraction: 0,
    etaSeconds: null,
  };
  const running = status === 'running' || status === 'dispatched' || status === 'uploading';

  return (
    <div className={styles.statusRow}>
      <span className={isTerminal(status) ? styles.dotDone : styles.dot} />
      <span className={styles.statusLabel}>{STATUS_LABEL[status]}</span>

      {status === 'queued' && job?.queuePosition !== null && job?.queuePosition !== undefined ? (
        <span className={`mono ${styles.metric}`}>
          {job.queuePosition === 0 ? 'next up' : `position ${job.queuePosition + 1}`}
        </span>
      ) : null}

      {running && step !== null && totalSteps !== null ? (
        <span className={`mono ${styles.metric}`}>
          step {step} / {totalSteps}
        </span>
      ) : null}

      {running || status === 'complete' ? (
        <div className={styles.bar}>
          <div
            className={styles.barFill}
            style={{ width: `${Math.round(fraction * 100)}%` }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            aria-label="Generation progress"
          />
        </div>
      ) : (
        <div className={styles.spacer} />
      )}

      {running && etaSeconds !== null ? (
        <span className={`mono ${styles.metric}`}>~{etaSeconds}s</span>
      ) : null}

      {disconnected ? <span className={styles.offline}>Reconnecting…</span> : null}

      {job && !isTerminal(job.status) ? (
        <button type="button" className={styles.ghostButton} onClick={onCancel}>
          Cancel
        </button>
      ) : job ? (
        <button type="button" className={styles.ghostButton} onClick={onDismiss}>
          Clear
        </button>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Record<Job['status'], string> = {
  queued: 'Queued',
  dispatched: 'Starting',
  running: 'Generating',
  uploading: 'Saving',
  complete: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// ---------------------------------------------------------------- actions

function ResultActions({
  job,
  asset,
  onRemix,
}: {
  job: Job | null;
  asset: Asset | null;
  onRemix: (job: Job) => void;
}) {
  const ready = Boolean(job && asset);

  return (
    <>
      {/*
        Save is an anchor, not a button: the browser's own download is what the
        user expects, works on the real `/api/assets/:id` bytes, and needs no
        blob juggling. Results are already in the library — this is "put a copy
        on my disk".
      */}
      <a
        className={ready ? styles.action : `${styles.action} ${styles.actionOff}`}
        href={asset?.url ?? undefined}
        download={asset ? `${asset.jobId}-${asset.id}.png` : undefined}
        aria-disabled={!ready}
        onClick={(event) => {
          if (!ready) event.preventDefault();
        }}
      >
        <DownloadIcon size={15} /> Save
      </a>

      <button
        type="button"
        className={job ? styles.action : `${styles.action} ${styles.actionOff}`}
        disabled={!job}
        title="Load this job's settings back into the panel"
        onClick={() => job && onRemix(job)}
      >
        <RemixIcon size={15} /> Remix
      </button>

      {/*
        Animate is a stub and says so. Video needs img2vid templates and the
        Video mode toggle, both phase 5; a button that looked live and did
        nothing would be worse than one that admits it.
      */}
      <button
        type="button"
        className={`${styles.action} ${styles.actionPrimary} ${styles.actionOff}`}
        disabled
        title="Video generation arrives in a later phase"
      >
        <PlayIcon size={14} /> Animate
        <span className={styles.soon}>soon</span>
      </button>
    </>
  );
}

// ---------------------------------------------------------------- pieces

function Waiting({ job }: { job: Job }) {
  return (
    <div className={styles.message}>
      <span className={styles.spinner} aria-hidden />
      <p className={styles.messageTitle}>
        {job.status === 'queued' ? 'Waiting for a backend' : 'Warming up'}
      </p>
      <p className={styles.messageBody}>
        {job.status === 'queued'
          ? 'The job is compiled and queued. The preview appears as soon as a backend picks it up.'
          : 'The first preview frame arrives a few steps in.'}
      </p>
    </div>
  );
}

function Message({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone?: 'danger';
}) {
  return (
    <div className={styles.message}>
      {tone === 'danger' ? null : <SparkIcon size={22} />}
      <p className={tone === 'danger' ? `${styles.messageTitle} ${styles.danger}` : styles.messageTitle}>
        {title}
      </p>
      <p className={styles.messageBody}>{body}</p>
    </div>
  );
}
