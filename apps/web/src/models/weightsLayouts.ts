/**
 * What catalogue files hold, read lazily as cards and drawers come into view.
 *
 * The API reads a file's safetensors header by range request
 * (`POST /catalogue/layouts`) and remembers it per URL, so a diffusers-format
 * file is marked "Won't run in ComfyUI" before anyone downloads it. Asking for
 * all 372 entries at once would be 744 requests to Hugging Face for cards
 * nobody scrolls to; asking per card in view is a handful, batched here.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from 'react';
import type { ModelCatalogEntry, WeightsLayout } from '@comfy/shared';
import { request } from '../lib/api';

const known = new Map<string, WeightsLayout>();
const asked = new Set<string>();
const queue = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Test seam. */
export const layoutDeps = {
  fetch: (urls: string[]) =>
    request<{ layouts: Record<string, WeightsLayout> }>('/catalogue/layouts', { method: 'POST', body: { urls } }).then((r) => r.layouts),
};

export function resetLayouts(): void {
  known.clear();
  asked.clear();
  queue.clear();
  version++;
}

function emit() {
  version++;
  for (const listener of listeners) listener();
}

function flush() {
  timer = null;
  const urls = [...queue].slice(0, 40);
  for (const url of urls) queue.delete(url);
  if (queue.size > 0) timer = setTimeout(flush, 50);
  if (urls.length === 0) return;
  layoutDeps
    .fetch(urls)
    .then((layouts) => {
      for (const [url, layout] of Object.entries(layouts)) {
        // Unknown is not remembered as an answer: a later view may read it.
        if (layout === 'unknown') asked.delete(url);
        else known.set(url, layout);
      }
      emit();
    })
    .catch(() => {
      for (const url of urls) asked.delete(url);
    });
}

/** Ask for these URLs' layouts, once each, batched. */
export function requestLayouts(urls: readonly (string | null | undefined)[]): void {
  for (const url of urls) {
    if (!url || !/\.safetensors(\?|$)/i.test(url) || asked.has(url) || known.has(url)) continue;
    asked.add(url);
    queue.add(url);
  }
  if (queue.size > 0 && !timer) timer = setTimeout(flush, 50);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The entries with every layout learnt so far laid over them. */
export function useWithLayouts(entries: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  const at = useSyncExternalStore(subscribe, () => version);
  return useMemo(
    () =>
      entries.map((entry) => {
        const layout = known.get(entry.url);
        return layout && entry.weightsLayout !== layout ? { ...entry, weightsLayout: layout } : entry;
      }),
    // `at` is the store's version: a new answer re-lays the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, at],
  );
}

/**
 * Ask for these entries' layouts once the element is on screen. Entries that already carry one are
 * skipped.
 */
export function useLayoutsWhenSeen(target: RefObject<Element | null>, entries: readonly ModelCatalogEntry[]): void {
  const urls = entries.filter((entry) => !entry.weightsLayout && !entry.installed).map((entry) => entry.url).join('\n');
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !urls) return;
    const element = target.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen, urls, target]);
  useEffect(() => {
    if (seen && urls) requestLayouts(urls.split('\n'));
  }, [seen, urls]);
}

/**
 * The download URL of another file in the same Hugging Face repository and
 * revision as `entryUrl`, so a version's header is read and cached exactly as a
 * card's is. Null when the entry is not a Hugging Face resolve URL.
 */
export function variantUrl(entryUrl: string, path: string): string | null {
  const base = /^(https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[^/]+\/)/.exec(entryUrl)?.[1];
  return base ? base + path.split('/').map(encodeURIComponent).join('/') : null;
}

/** Look up a URL's learnt layout; re-renders as answers arrive. */
export function useLayoutOf(): (url: string | null | undefined) => WeightsLayout | undefined {
  const at = useSyncExternalStore(subscribe, () => version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (url) => (url ? known.get(url) : undefined), [at]);
}
