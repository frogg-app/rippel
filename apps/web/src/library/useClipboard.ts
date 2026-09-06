/**
 * Copy-to-clipboard with the confirmation the user actually needs.
 *
 * A copy button that does nothing visible is indistinguishable from a copy
 * button that failed, so this reports which of the two happened and settles
 * back after a moment. The fallback matters more than it looks: the async
 * Clipboard API is unavailable on any non-secure origin, and this app is
 * self-hosted on a LAN — plain `http://192.168.1.9` is the normal case, not an
 * edge case.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

export function useClipboard(resetAfterMs = 1600) {
  const [state, setState] = useState<CopyState>('idle');
  /** Which button was pressed, so two copy buttons do not both light up. */
  const [key, setKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string, id: string) => {
      let ok = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        } else {
          ok = legacyCopy(text);
        }
      } catch {
        ok = legacyCopy(text);
      }

      setKey(id);
      setState(ok ? 'copied' : 'failed');
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setState('idle');
        setKey(null);
      }, resetAfterMs);
      return ok;
    },
    [resetAfterMs],
  );

  return { copy, state, key };
}

/** `execCommand` is deprecated, and is the only thing that works over http://. */
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
