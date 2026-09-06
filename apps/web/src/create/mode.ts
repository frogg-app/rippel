/**
 * Image / Video — the one piece of Create state that lives outside the Create
 * screen.
 *
 * The toggle is drawn in the app shell's top bar (`shell/ModeToggle.tsx`) and
 * consumed by the Create screen, which are siblings with no component between
 * them that owns both. Lifting the state would mean putting a Create concern
 * into `AppShell`, and threading it through a context provider means the same
 * edit in the same file. So: a module-level store, read through
 * `useSyncExternalStore`, which both sides subscribe to and neither owns.
 *
 * It is one enum. Persisting it in `localStorage` costs nothing and means a
 * reload does not silently drop someone back into Image mode with a video
 * model selected.
 */
import { useSyncExternalStore } from 'react';

export type CreateMode = 'image' | 'video';

const KEY = 'comfy.create.mode';

function read(): CreateMode {
  try {
    return localStorage.getItem(KEY) === 'video' ? 'video' : 'image';
  } catch {
    return 'image'; // private mode; the default is the common case anyway
  }
}

let mode: CreateMode = read();
const listeners = new Set<() => void>();

export function setCreateMode(next: CreateMode): void {
  if (next === mode) return;
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* nothing to do; the session still works, it just will not be remembered */
  }
  for (const listener of listeners) listener();
}

export function getCreateMode(): CreateMode {
  return mode;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The toggle and the Create screen read the same value through this. */
export function useCreateMode(): [CreateMode, (next: CreateMode) => void] {
  const current = useSyncExternalStore(subscribe, getCreateMode, getCreateMode);
  return [current, setCreateMode];
}

/** Test seam: reset the module store between renders. */
export function resetCreateMode(): void {
  mode = 'image';
  for (const listener of listeners) listener();
}
