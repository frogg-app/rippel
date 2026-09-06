import type { Backend } from '@comfy/shared';
import { memoryReading } from '../lib/format';
import styles from './BackendPill.module.css';

/**
 * `desktop-4090 · 18.2/36.5 GB`, top right of every screen.
 *
 * PLAN.md §6: with self-hosted ComfyUI, "is my server even up?" must be
 * answered before it is asked. So the dot leads, the name follows, and the
 * memory figure is last and quietest.
 */
export function BackendPill({
  backend,
  loading,
  unreachable,
  extraCount,
}: {
  backend: Backend | null;
  loading: boolean;
  unreachable: boolean;
  /** Backends beyond the one shown, surfaced as "+2". */
  extraCount: number;
}) {
  if (loading) {
    return (
      <div className={`${styles.pill} ${styles.quiet}`} aria-hidden>
        <span className={styles.dot} data-status="unknown" />
        <span className={styles.name}>Checking…</span>
      </div>
    );
  }

  if (unreachable) {
    return (
      <div
        className={`${styles.pill} ${styles.bad}`}
        title="The rippel server is not answering. Generation is unavailable until it is back."
      >
        <span className={styles.dot} data-status="offline" />
        <span className={styles.name}>Server unreachable</span>
      </div>
    );
  }

  if (!backend) {
    return (
      <div
        className={`${styles.pill} ${styles.quiet}`}
        title="No ComfyUI backend is registered yet. An administrator adds one before anything can be generated."
      >
        <span className={styles.dot} data-status="unknown" />
        <span className={styles.name}>No backend</span>
      </div>
    );
  }

  const status = backend.enabled ? backend.status : 'offline';
  const memory = memoryReading(backend);

  return (
    <div
      className={styles.pill}
      data-status={status}
      title={
        status === 'online'
          ? memory?.title ?? `${backend.name} is online.`
          : `${backend.name} is ${backend.enabled ? 'not answering' : 'disabled'}. Jobs are never dispatched to it.`
      }
    >
      <span className={styles.dot} data-status={status} />
      <span className={styles.name}>{backend.name}</span>
      {status === 'online' && memory ? (
        <span className={`mono ${styles.memory}`}>
          {memory.text}
          {/* The number is a budget, not the card's size. The word carries that
              where the tooltip cannot be reached — on touch, or at a glance. */}
          <span className={styles.qualifier}>
            {memory.isOperatorBudget ? ' budget' : ' reported'}
          </span>
        </span>
      ) : (
        <span className={styles.memory}>{backend.enabled ? 'offline' : 'disabled'}</span>
      )}
      {extraCount > 0 ? <span className={styles.extra}>+{extraCount}</span> : null}
    </div>
  );
}
