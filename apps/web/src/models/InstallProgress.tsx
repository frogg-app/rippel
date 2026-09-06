/**
 * What an install is doing, said honestly.
 *
 * This component used to draw an indeterminate sweep and nothing else, because
 * the transport reported queue state per *task* and a 6.9 GB checkpoint is one
 * task that is queued, then running, then done. That reasoning was right about
 * the transport and wrong about the world: the bytes are observable from a
 * different direction. ComfyUI-Manager downloads in place, and ComfyUI will
 * stat its own model folders, so the file can be watched growing — and the
 * download's exact size comes from a HEAD of its URL. `ModelInstall` now
 * carries both, and where both are real this draws a real bar.
 *
 * The rule that has not changed, and must not: **no number is ever invented.**
 * There are three displays here, and which one appears is decided entirely by
 * how much the backend could actually tell us.
 *
 *  1. **Both bytes and an exact total.** A determinate bar with a real
 *     `aria-valuenow`, the two byte counts, and the percentage.
 *  2. **Bytes but no total.** No percentage can exist, so the bar stays
 *     indeterminate — but "1.24 GB downloaded" is a measured fact and is worth
 *     far more than the sweep alone.
 *  3. **Neither.** Exactly what this showed before: the status word, whatever
 *     the transport said, and elapsed wall-clock.
 *
 * The rate and the time remaining are the only derived figures, they appear
 * only once there is enough measurement to divide by, and they are labelled
 * "average" and "estimate" in the text a person reads. Neither drives the bar.
 */
import type { ModelInstall } from '@comfy/shared';
import {
  elapsed,
  formatBytes,
  percentComplete,
  remaining,
  transferRate,
} from './catalogue';
import styles from './ModelsPanels.module.css';

const STATUS_WORDS: Record<ModelInstall['status'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  complete: 'Installed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export interface InstallProgressProps {
  install: ModelInstall;
  /** Passed in rather than read from `Date.now()` so elapsed time is testable. */
  now: number;
  /** The card variant: no filename, tighter type. */
  compact?: boolean;
}

export function InstallProgress({ install, now, compact = false }: InstallProgressProps) {
  const live = install.status === 'queued' || install.status === 'downloading';
  const since = install.startedAt ?? install.createdAt;
  const until = install.finishedAt ? Date.parse(install.finishedAt) : now;

  const { bytesReceived, bytesTotal } = install;
  const percent = percentComplete(bytesReceived, bytesTotal);
  const rate = live ? transferRate(bytesReceived, install.startedAt, now) : null;
  const left = remaining(bytesReceived, bytesTotal, rate);

  // Whole numbers only. A bar that reads "46.8%" invites a precision the
  // measurement does not have — the size is exact, but it was sampled a few
  // seconds ago.
  const shown = percent === null ? null : Math.floor(percent);

  // What the bytes say, in one line. Null when nothing was measured at all,
  // which is the case that falls back to the old display.
  const byteLine =
    bytesReceived === null
      ? null
      : bytesTotal !== null
        ? `${formatBytes(bytesReceived)} of ${formatBytes(bytesTotal)}`
        : live
          ? `${formatBytes(bytesReceived)} downloaded`
          : formatBytes(bytesReceived);

  // The transport's own words, but only when they add something. It says
  // "Downloading" while the status word already says Downloading, and printing
  // both twice was noise; it earns its place when the queue is doing several
  // things and it names them.
  const detail =
    install.detail && install.detail !== STATUS_WORDS[install.status] ? install.detail : null;

  return (
    <div className={`${styles.progress} ${compact ? styles.progressCompact : ''}`}>
      <div className={styles.progressRow}>
        <span
          className={`${styles.progressStatus} ${
            install.status === 'failed' ? styles.progressFailed : ''
          } ${install.status === 'complete' ? styles.progressDone : ''}`}
          // Announced as it changes: this is the one thing on the screen that
          // moves on its own, and the operator may not be watching it.
          role="status"
        >
          {STATUS_WORDS[install.status]}
        </span>
        <span className={`mono ${styles.progressElapsed}`}>{elapsed(since, until)}</span>
      </div>

      {live && shown !== null ? (
        // Determinate, and every number in it measured: `aria-valuenow` is safe
        // to state because it is bytes on disk over an exact Content-Length.
        <div
          className={styles.track}
          role="progressbar"
          aria-label={`${install.displayName} install progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shown}
          aria-valuetext={`${byteLine}, ${shown}%`}
        >
          <span className={styles.trackFill} style={{ width: `${percent}%` }} />
        </div>
      ) : live ? (
        // Indeterminate, because there is no fraction to bind to. Deliberately
        // still no `aria-valuenow`: a screen reader must not be told a number
        // that does not exist.
        <div
          className={styles.track}
          role="progressbar"
          aria-label={`${install.displayName} install progress`}
          aria-valuetext={byteLine ?? install.detail ?? STATUS_WORDS[install.status]}
        >
          <span className={styles.trackPulse} />
        </div>
      ) : null}

      {byteLine ? (
        <p className={styles.progressBytes}>
          <span className="mono">{byteLine}</span>
          {shown !== null ? <span className={styles.progressPercent}>{shown}%</span> : null}
        </p>
      ) : null}

      {rate ? (
        <p className={styles.progressRate}>
          <span className="mono">{formatBytes(rate)}/s</span> average
          {left ? <> · about {left} left (estimate)</> : null}
        </p>
      ) : null}

      {detail ? <p className={styles.progressDetail}>{detail}</p> : null}
      {install.error ? (
        <p className={styles.progressError} role="alert">
          {install.error}
        </p>
      ) : null}
    </div>
  );
}
