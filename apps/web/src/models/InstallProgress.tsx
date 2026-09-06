/**
 * What an install is doing, said honestly.
 *
 * The artboard draws a percentage and a transfer rate. Neither exists: the
 * transport reports queue state per *task*, so a 6.9 GB checkpoint is one task
 * that is queued, then running, then done — see the note on `ModelInstall` in
 * @comfy/shared. Rendering "64% · 12 MB/s" here would be a number we made up.
 *
 * So the bar is indeterminate — it says "moving", not "this far along" — and
 * the three things beside it are all real: the status word, `detail` (what the
 * transport actually said) and elapsed wall-clock. An operator watching a
 * download for twenty minutes needs to know it is still alive, and elapsed
 * time answers that without inventing anything.
 */
import type { ModelInstall } from '@comfy/shared';
import { elapsed } from './catalogue';
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

      {live ? (
        // Indeterminate on purpose. There is no fraction to bind to.
        <div
          className={styles.track}
          role="progressbar"
          aria-label={`${install.displayName} install progress`}
          aria-valuetext={install.detail ?? STATUS_WORDS[install.status]}
        >
          <span className={styles.trackPulse} />
        </div>
      ) : null}

      {install.detail ? <p className={styles.progressDetail}>{install.detail}</p> : null}
      {install.error ? (
        <p className={styles.progressError} role="alert">
          {install.error}
        </p>
      ) : null}
    </div>
  );
}
