import { useSyncExternalStore } from 'react';
const KEY = 'rippel.targetBackend';
const listeners = new Set<() => void>();
let target: string | null = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
export function setTargetBackend(id: string | null) {
  target = id;
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* Storage may be disabled. */ }
  listeners.forEach(listener => listener());
}
export function useTargetBackend() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => target);
}
