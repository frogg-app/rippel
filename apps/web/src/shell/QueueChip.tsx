/**
 * "3 in queue", and what those three are.
 *
 * One GPU, several people: how long the line is decides whether you wait or
 * wander off, so the count is chrome on every screen and the detail is one
 * click away. `GET /api/queue` is the source (API_CONTRACT.md, "Queue").
 *
 * Two things this screen must get right.
 *
 * **It may not know anything.** The queue endpoint can be absent — it is being
 * built in parallel — so `useQueue()` reports `live: false` and the chip falls
 * back to the depth the backend poller reports, which is exactly what it showed
 * before this file grew a panel. No error, no empty popover claiming the queue
 * is clear when we simply cannot see it.
 *
 * **It may not know what someone typed.** A non-admin gets a foreign entry's
 * position and display name and no params at all. So a foreign row renders as a
 * place in the line belonging to a person — never a prompt, never a blank where
 * a prompt would go, and never the word "undefined". The panel says out loud
 * that other people's prompts are private, so an absent prompt reads as a rule
 * rather than as a bug.
 */
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { ClockIcon } from '../components/icons';
import { AuthContext } from '../auth/context';
import { queueLabel } from '../lib/format';
import {
  type QueueEntry,
  entryPrompt,
  isOwnEntry,
  ordinal,
  ownerLabel,
  useQueue,
} from '../lib/api-queue';
import styles from './QueueChip.module.css';

export function QueueChip({ depth }: { depth: number }) {
  const queue = useQueue();
  const auth = useContext(AuthContext);
  const userId = auth?.user?.id ?? null;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The count is the live queue when we have one, and the backend poller's
  // figure when we do not.
  const waiting = queue.live ? queue.entries.length : depth;

  // Escape closes and hands focus back; a click anywhere else closes. Both are
  // what a popover is expected to do, and neither is free with a plain button.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  // Nothing waiting is the normal state; a chip reading "0 in queue" on every
  // screen is noise. It stays while a panel is open so it cannot vanish from
  // under the pointer.
  if (waiting <= 0 && !open) return null;

  // Without the endpoint there is nothing to reveal, so the chip stays the
  // static badge it has always been rather than offering an empty panel.
  if (!queue.live) {
    return (
      <div className={styles.chip}>
        <ClockIcon size={13} />
        {queueLabel(waiting)}
      </div>
    );
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className={open ? `${styles.chip} ${styles.chipOpen}` : styles.chip}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <ClockIcon size={13} />
        {queueLabel(waiting)}
      </button>

      {open ? (
        <div className={styles.panel} id={panelId} role="group" aria-label="Queue">
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Queue</span>
            <span className={styles.panelCount}>
              {waiting} waiting{queue.running ? ', 1 generating' : ''}
            </span>
          </div>

          <ul className={styles.list}>
            {queue.running ? (
              <EntryRow entry={queue.running} userId={userId} place="Now" running />
            ) : null}
            {queue.entries.map((entry, index) => (
              <EntryRow
                key={entry.job.id}
                entry={entry}
                userId={userId}
                place={ordinal(index + 1)}
              />
            ))}
          </ul>

          {/* Said once, plainly, so a row with no prompt reads as a rule about
              other people's privacy rather than as missing data. */}
          <p className={styles.note}>
            {queue.entries.some((entry) => !isOwnEntry(entry, userId)) || (queue.running && !isOwnEntry(queue.running, userId))
              ? 'You can see how long the line is, but only your own prompts.'
              : 'Everything waiting is yours.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function EntryRow({
  entry,
  userId,
  place,
  running = false,
}: {
  entry: QueueEntry;
  userId: string | null;
  place: string;
  running?: boolean;
}) {
  const mine = isOwnEntry(entry, userId);
  const prompt = entryPrompt(entry);

  return (
    <li className={mine ? `${styles.entry} ${styles.entryMine}` : styles.entry}>
      <span className={running ? `mono ${styles.place} ${styles.placeRunning}` : `mono ${styles.place}`}>
        {place}
      </span>
      <span className={styles.entryText}>
        <span className={styles.owner}>{ownerLabel(entry, userId)}</span>
        {/*
          A prompt only when we were given one. The alternative — an empty
          quote, or a placeholder shaped like a prompt — invites the reader to
          believe something was said and we lost it.
        */}
        {prompt ? (
          <span className={styles.prompt} title={prompt}>
            {prompt}
          </span>
        ) : (
          <span className={styles.private}>{running ? 'generating' : 'waiting'}</span>
        )}
      </span>
    </li>
  );
}
