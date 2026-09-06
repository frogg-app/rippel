/**
 * Whether the Advanced drawer is open, remembered.
 *
 * PLAN.md §6: "Advanced state is remembered per user." `localStorage` is the
 * right store for it and not a shortcut: it is a UI preference with no value to
 * the server, it must apply on the very first paint (a round trip would make
 * the panel visibly jump open a moment after load), and it is per-device on
 * purpose — someone who opens Advanced on a big desktop monitor has not asked
 * for it open on a laptop. If it ever needs to follow a user between machines
 * it becomes a column on `users`, and this hook is where that swap happens.
 *
 * The key is namespaced but *not* keyed by user id: this browser profile is one
 * person's, and keying by id would leak "who else signs in here" into storage.
 */
import { useCallback, useState } from 'react';

const KEY = 'comfy.create.advancedOpen';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false; // Private mode, or storage disabled. Closed is the safe default.
  }
}

export function useAdvancedOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(read);

  const set = useCallback((next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      /* the drawer still works, it just forgets */
    }
  }, []);

  return [open, set];
}
