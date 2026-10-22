import type { Backend } from '@comfy/shared';
import { memoryReading } from '../lib/format';
import { Dropdown } from '../components/Dropdown';
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
  backends,
  onSelect,
}: {
  backend: Backend | null;
  loading: boolean;
  unreachable: boolean;
  /** Backends beyond the one shown, surfaced as "+2". */
  extraCount: number;
  backends?: Backend[];
  onSelect?: (id: string) => void;
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
        title="Connect a machine through Settings → Backends to start generating."
      >
        <span className={styles.dot} data-status="unknown" />
        <span className={styles.name}>No backend</span>
      </div>
    );
  }

  const status = pillStatus(backend);
  const memory = memoryReading(backend);
  if (backends && onSelect) return (
    <Dropdown value={backend.id} onChange={onSelect} aria-label="Target backend"
      className={styles.pill} menuWidth={280} align="end"
      options={backends.map(item => ({ value: item.id, label: `${item.name}${!item.enabled ? ' · disabled' : item.status !== 'online' ? ` · ${pillStatus(item) === 'stopped' ? 'engine stopped' : 'offline'}` : ''}`, disabled: !item.enabled || item.status !== 'online' }))}
      leading={<span className={styles.dot} data-status={status} />}>
      {memory && status === 'online' ? <span className={`mono ${styles.memory}`}>{memory.text} {memory.isOperatorBudget ? 'budget' : 'reported'}</span> : null}
    </Dropdown>
  );


  return (
    <div
      className={styles.pill}
      data-status={status}
      title={
        status === 'online'
          ? memory?.title ?? `${backend.name} is online.`
          : status === 'stopped'
            ? `${backend.name} is on, but its engine (ComfyUI) is stopped. Start it from the rippel agent on that machine, or in Settings → Backends.`
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
        <span className={styles.memory}>{!backend.enabled ? 'disabled' : status === 'stopped' ? 'engine stopped' : 'offline'}</span>
      )}
      {extraCount > 0 ? <span className={styles.extra}>+{extraCount}</span> : null}
    </div>
  );
}

/**
 * 'stopped' when the machine's agent is checking in but ComfyUI is not
 * answering — the usual state of a PC whose owner has not pressed Start, and
 * a very different thing from a machine that is off.
 */
function pillStatus(backend: Backend): Backend['status'] | 'stopped' {
  if (!backend.enabled) return 'offline';
  if (backend.status !== 'online' && backend.agentOnline) return 'stopped';
  return backend.status;
}
