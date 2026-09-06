/**
 * A clock that only ticks when something is watching it.
 *
 * Elapsed time, the transfer rate and the time remaining are all functions of
 * "now", so it has to move — but only while an install is live. With nothing
 * running the value is frozen and no timer exists, which keeps an idle Models
 * tab from re-rendering once a second forever.
 */
import { useEffect, useState } from 'react';

export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}
