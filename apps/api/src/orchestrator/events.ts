/**
 * The per-user event bus.
 *
 * Every job update in the system funnels through here and out to whichever of
 * that user's browser tabs happen to be open. Two properties matter:
 *
 *  - **Scoped to one user.** A subscriber only ever receives events for their
 *    own jobs. This is enforced at publish time by requiring a userId, rather
 *    than by filtering on the way out, so there is no path where forgetting a
 *    check leaks someone else's prompt.
 *  - **Lossy on purpose.** Events are a live convenience, not a log. A tab that
 *    misses a frame — asleep, reconnecting, opened late — recovers by reading
 *    the job over HTTP, which is always authoritative. Nothing here queues or
 *    replays, because a queue that grows while nobody is listening is a leak.
 */

import type { JobEvent, Uuid } from '@comfy/shared';

type Listener = (event: JobEvent) => void;

const listeners = new Map<Uuid, Set<Listener>>();

export function subscribe(userId: Uuid, listener: Listener): () => void {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);

  return () => {
    const current = listeners.get(userId);
    if (!current) return;
    current.delete(listener);
    // Drop the empty set so the map does not accumulate one entry per user who
    // has ever connected.
    if (current.size === 0) listeners.delete(userId);
  };
}

export function publish(userId: Uuid, event: JobEvent): void {
  const set = listeners.get(userId);
  if (!set) return;

  for (const listener of set) {
    try {
      listener(event);
    } catch {
      // One broken socket must never stop the others from being told, and must
      // never propagate into the job pipeline that is publishing.
    }
  }
}

/** Test seam and shutdown hygiene. */
export function clearSubscribers(): void {
  listeners.clear();
}

export function subscriberCount(userId: Uuid): number {
  return listeners.get(userId)?.size ?? 0;
}
