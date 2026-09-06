/**
 * Turning a flat feed into the artboard's dated sections.
 *
 * The Library artboard heads each block of tiles with TODAY / YESTERDAY / a
 * date. That has to survive infinite scroll, which means grouping is a pure
 * function of the items currently held rather than something the server sends:
 * a page boundary landing in the middle of a day must not start a second
 * "Today" heading further down.
 */
import type { LibraryAsset } from '../lib/api-library';

export interface AssetGroup {
  /** Stable across renders and pages — the local calendar day, `YYYY-MM-DD`. */
  key: string;
  label: string;
  items: LibraryAsset[];
}

function dayKey(date: Date): string {
  // Local, not UTC: "today" means the user's today, and a 23:40 render must
  // not appear under tomorrow because the machine is west of Greenwich.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dayLabel(date: Date, now = new Date()): string {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const key = dayKey(date);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: sameYear ? 'long' : undefined,
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
  });
}

/**
 * Group in feed order. The feed is already newest-first, so this walks it once
 * and starts a new group whenever the day changes — no sorting, and no chance
 * of reordering rows the server deliberately ordered.
 */
export function groupByDay(items: LibraryAsset[], now = new Date()): AssetGroup[] {
  const groups: AssetGroup[] = [];
  for (const item of items) {
    const date = new Date(item.createdAt);
    const key = dayKey(date);
    const current = groups.at(-1);
    if (current && current.key === key) {
      current.items.push(item);
    } else {
      groups.push({ key, label: dayLabel(date, now), items: [item] });
    }
  }
  return groups;
}

/** "0:04" for the video badge in the artboard's top-left corner. */
export function clockDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** "19.4s" / "2m 04s" for the drawer's render-time row. */
export function renderTime(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
