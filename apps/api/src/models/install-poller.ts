/**
 * Advances in-flight model installs on a timer.
 *
 * Downloads outlive requests — a checkpoint is several gigabytes over a home
 * connection — so nothing about an install's progress can depend on a client
 * staying connected, or even on this process staying up. Everything needed to
 * resume is in the row, and the completion check asks ComfyUI directly, so a
 * restart mid-download costs nothing but a poll interval.
 */

import { activeInstalls, refreshInstall } from './installs.js';

/** Slow on purpose: multi-gigabyte downloads, and the check is not free. */
const INTERVAL_MS = 15_000;

export function startInstallPoller(log: (msg: string) => void = console.log): () => void {
  let stopped = false;
  let running = false;

  async function tick(): Promise<void> {
    // A slow backend must not let ticks pile up on top of each other.
    if (running || stopped) return;
    running = true;
    try {
      const rows = await activeInstalls();
      for (const row of rows) {
        try {
          const before = row.status;
          const install = await refreshInstall(row, row.base_url);
          if (install.status !== before) {
            log(`[installs] ${row.filename} on ${row.backend_id}: ${before} -> ${install.status}`);
          }
        } catch (err) {
          // One bad install must not stall the others.
          log(`[installs] failed to refresh ${row.filename}: ${String(err)}`);
        }
      }
    } catch (err) {
      log(`[installs] poll failed: ${String(err)}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), INTERVAL_MS);
  // Never hold the process open for this.
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
