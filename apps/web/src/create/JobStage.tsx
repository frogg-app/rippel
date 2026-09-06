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
 *
 * `fraction` is only meaningful *within sampling* (API_CONTRACT.md, "Progress
 * detail"). Most of a run is not sampling — a cold checkpoint takes minutes to
 * load and the VAE decodes on the CPU here — so when `phase` says we are
 * somewhere else the row shows an indeterminate bar and the backend's own
 * `phaseLabel` instead of a number. A bar frozen at 100% through a slow decode
 * reads as a hang, which is the whole reason the phase exists. `phase` is
 * optional: when it is absent (an older API) everything falls back to the
 * step/fraction behaviour this screen has always had.
 */
import { useEffect, useState } from 'react';
import type { Asset, Job, JobProgress } from '@comfy/shared';
import { type QueuePlace, ordinal } from '../lib/api-queue';
import { SparkIcon } from '../components/icons';
import { DownloadIcon, PlayIcon, RemixIcon } from './icons';
import { isTerminal } from './jobProgress';
import styles from './stage.module.css';

export function JobStage({
  job,
  submitting,
  submitError,
  disconnected,
  place,
  onCancel,
  onRemix,
  onDismiss,
}: {
  job: Job | null;
  submitting: boolean;
  submitError: string | null;
  /** The socket is down. Shown quietly; the job itself is unaffected. */
  disconnected: boolean;
  /**
   * Where this job sits in the *global* line, when the queue endpoint can tell
   * us. `Job.queuePosition` counts only the user's own jobs ahead of it, which
   * on a shared GPU answers the wrong question — "queued" with four strangers
   * in front is a five-minute wait, and the user is entitled to know that
   * before deciding whether to sit and watch. Null when the endpoint is
   * missing or the job is no longer waiting; the row then falls back to what it
   * always showed.
   */
  place?: QueuePlace | null;
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
          place={place ?? null}
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
            <Waiting job={job} place={place ?? null} />
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
  place,
  onCancel,
  onDismiss,
}: {
  job: Job | null;
  submitting: boolean;
  disconnected: boolean;
  place: QueuePlace | null;
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
  const progress = job?.progress;
  const step = progress?.step ?? null;
  const totalSteps = progress?.totalSteps ?? null;
  const fraction = progress?.fraction ?? 0;
  const etaSeconds = progress?.etaSeconds ?? null;
  const phase = progress?.phase ?? null;
  const running = status === 'running' || status === 'dispatched' || status === 'uploading';

  // No phase at all is the older API: trust `fraction` exactly as this screen
  // always did. With a phase, only `sampling` has a number worth drawing.
  const measurable = running && (phase === null || phase === 'sampling');
  const indeterminate = running && phase !== null && phase !== 'sampling';
  const phaseLabel = progress?.phaseLabel ?? (phase ? PHASE_FALLBACK_LABEL[phase] : null);
  const queuePosition = job?.queuePosition ?? null;

  return (
    <div className={styles.statusRow}>
      <span className={isTerminal(status) ? styles.dotDone : styles.dot} />
      <span className={styles.statusLabel}>{STATUS_LABEL[status]}</span>

      {/* Where am I in the line — the only thing worth reading while nothing
          else is happening yet. The global place is preferred when the queue
          endpoint answers; otherwise the per-user position, worded so it cannot
          be mistaken for a global one. */}
      {!isTerminal(status) ? (
        <QueuePlaceLabel place={place} queuePosition={queuePosition} />
      ) : null}

      {/* Outside sampling the phase label *is* the progress report. */}
      {indeterminate && phaseLabel ? <span className={styles.phase}>{phaseLabel}</span> : null}

      {measurable && step !== null && totalSteps !== null ? (
        <span className={`mono ${styles.metric}`}>
          step {step} / {totalSteps}
        </span>
      ) : null}

      {indeterminate ? (
        <div
          className={styles.bar}
          role="progressbar"
          aria-label="Generation progress"
          aria-valuetext={phaseLabel ?? 'Working'}
          aria-busy
        >
          {/* No aria-valuenow: an indeterminate bar sweeps rather than fills,
              so it cannot be misread as "nearly done". */}
          <div className={styles.barSweep} />
        </div>
      ) : measurable || status === 'complete' ? (
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

      {measurable && etaSeconds !== null ? (
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

/**
 * What to say when a frame carries a `phase` but no `phaseLabel`.
 *
 * The server's own words are preferred — it knows *which* checkpoint it is
 * loading — but the phase alone still beats silence.
 */
const PHASE_FALLBACK_LABEL: Record<NonNullable<NonNullable<JobProgress['phase']>>, string> = {
  queued: 'Waiting for a backend',
  preparing: 'Loading the model',
  sampling: 'Generating',
  decoding: 'Decoding image',
  saving: 'Saving to your library',
};

/**
 * "3rd in line", or nothing.
 *
 * Deliberately plain English rather than "position 3": a queue is a line of
 * people, everyone already knows how one works, and "position" is the word a
 * database would choose. The two numbers are never mixed — a global place says
 * "in line", the per-user fallback says "of yours" — because conflating them
 * would tell someone with two of their own jobs queued behind six strangers
 * that they are next.
 */
function QueuePlaceLabel({
  place,
  queuePosition,
}: {
  place: QueuePlace | null;
  queuePosition: number | null;
}) {
  if (place) {
    return (
      <span className={styles.phase}>
        {place.ahead === 0 ? 'Next in line' : `${ordinal(place.ordinal)} in line`}
      </span>
    );
  }
  if (queuePosition === null) return null;
  return (
    <span className={styles.phase}>
      {queuePosition === 0 ? 'Next up' : `${queuePosition} of your jobs ahead`}
    </span>
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

function Waiting({ job, place }: { job: Job; place: QueuePlace | null }) {
  const phase = job.progress.phase ?? null;
  const phaseLabel = job.progress.phaseLabel ?? (phase ? PHASE_FALLBACK_LABEL[phase] : null);

  // The phase, when the backend reports one, is a better headline than a guess
  // made from the status: "Loading SDXL" for two minutes is honest, where
  // "Warming up" is the same sentence whatever is actually happening.
  const title =
    phase && phase !== 'queued' && phaseLabel
      ? phaseLabel
      : job.status === 'queued'
        ? 'Waiting for a backend'
        : 'Warming up';

  const body =
    phase === 'preparing'
      ? 'The backend is loading weights. A cold checkpoint takes a minute or two, and the first preview follows a few steps after that.'
      : phase === 'decoding'
        ? 'Sampling has finished. The VAE decode runs on the CPU here, so this part is slow — the image appears the moment it lands.'
        : phase === 'saving'
          ? 'Generated. The image is being stored in your library.'
          : job.status === 'queued'
            ? queueSentence(place)
            : 'The first preview frame arrives a few steps in.';

  return (
    <div className={styles.message}>
      <span className={styles.spinner} aria-hidden />
      <p className={styles.messageTitle}>{title}</p>
      <p className={styles.messageBody}>{body}</p>
    </div>
  );
}

/**
 * What waiting actually means right now.
 *
 * "Queued" is a status; "two generations are ahead of yours" answers the
 * question the person is really asking, which is whether to stay on this
 * screen. With no queue endpoint we say the honest weaker thing rather than
 * inventing a number.
 */
function queueSentence(place: QueuePlace | null): string {
  if (!place) {
    return 'The job is compiled and queued. The preview appears as soon as a backend picks it up.';
  }
  if (place.ahead === 0) {
    return 'Yours is next. It starts as soon as the backend is free, and the preview follows a few steps after that.';
  }
  return `${
    place.ahead === 1 ? 'One generation is' : `${place.ahead} generations are`
  } ahead of yours. There is one GPU, so they run in order — you can leave this page and the result still lands in your library.`;
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
      {/*
        A failure body is the backend's own words — "VAEDecode failed: CUDA
        error: invalid kernel file" — shown verbatim, because that string is
        the only thing that says what actually went wrong. So it gets a
        monospace block that wraps anywhere and can be selected for a bug
        report, rather than being softened into prose.
      */}
      <p className={tone === 'danger' ? styles.errorBody : styles.messageBody}>{body}</p>
    </div>
  );
}
