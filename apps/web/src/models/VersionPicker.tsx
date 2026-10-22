/**
 * Which build of a Hugging Face model to install.
 *
 * A repository usually holds one model several ways: the full weights, a
 * smaller fp8 file, a distilled fewer-step build, a ladder of GGUF
 * quantisations. Which one is right is a question about the graphics card, so
 * the sizes come from the API (it reads the repository's file list when the
 * drawer opens) along with the one it recommends for this machine, and that
 * is selected until somebody chooses otherwise.
 */
import { useEffect, useState } from 'react';
import { requestLayouts, useLayoutOf, variantUrl } from './weightsLayouts';
import type { ModelCatalogEntry, ModelVariant } from '@comfy/shared';
import { formatBytes } from './catalogue';
import { UNLOADABLE_WORDS } from './intents';
import styles from './ModelsPanels.module.css';

export type LoadVariants = (ref: string, signal?: AbortSignal) => Promise<{ variants: ModelVariant[]; memoryBytes: number | null }>;

/** "Full (fp16)", "Smaller (fp8)", "GGUF Q4_K_M", with "· distilled" when it is. */
export function variantLabel(variant: Pick<ModelVariant, 'kind' | 'precision' | 'distilled'>): string {
  const base =
    variant.kind === 'gguf'
      ? `GGUF ${variant.precision ?? ''}`.trim()
      : variant.kind === 'fp8'
        ? 'Smaller (fp8)'
        : variant.precision
          ? `Full (${variant.precision})`
          : 'Full';
  return variant.distilled ? `${base} · distilled` : base;
}

/** What each kind of build is, for the line under the picker. */
const KIND_NOTE: Record<ModelVariant['kind'], string> = {
  full: 'The model as published. Best quality, largest file.',
  fp8: 'Half the size of the full weights, with very little lost.',
  gguf: 'Compressed for smaller cards. Q8 looks all but identical; below Q4 it shows. Needs ComfyUI-GGUF on the machine.',
};

/**
 * The versions an entry offers and the one chosen, loaded when there is a
 * choice to make. Falls back to the catalogue's own list (names, no sizes)
 * when the sizes cannot be read.
 */
export function useVariants(entry: ModelCatalogEntry, load: LoadVariants | undefined) {
  const [state, setState] = useState<{ variants: ModelVariant[]; memoryBytes: number | null; loading: boolean }>(() => ({
    variants: entry.variants ?? [],
    memoryBytes: null,
    loading: Boolean(load && (entry.variants?.length ?? 0) > 0),
  }));
  const [chosen, setChosen] = useState<string | null>(entry.variants?.[0]?.path ?? null);
  // The drawer's file picker swaps the entry in place; start again from its own list.
  const [forRef, setForRef] = useState(entry.ref);
  if (forRef !== entry.ref) {
    setForRef(entry.ref);
    setState({ variants: entry.variants ?? [], memoryBytes: null, loading: Boolean(load && (entry.variants?.length ?? 0) > 0) });
    setChosen(entry.variants?.[0]?.path ?? null);
  }

  useEffect(() => {
    if (!load || !(entry.variants?.length ?? 0)) return;
    const controller = new AbortController();
    load(entry.ref, controller.signal)
      .then((result) => {
        setState({ variants: result.variants, memoryBytes: result.memoryBytes, loading: false });
        const recommended = result.variants.find((variant) => variant.recommended);
        if (recommended) setChosen(recommended.path);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, loading: false }));
      });
    return () => controller.abort();
  }, [entry.ref, entry.variants, load]);

  return { ...state, chosen, choose: setChosen };
}

export function VersionPicker({
  variants,
  memoryBytes,
  loading,
  chosen,
  onChoose,
  backendName,
  disabled,
  unloadable,
}: {
  variants: ModelVariant[];
  memoryBytes: number | null;
  loading: boolean;
  chosen: string | null;
  onChoose: (path: string) => void;
  backendName: string | null;
  disabled?: boolean;
  /** Paths whose header says no ComfyUI loader reads them; shown, not choosable. */
  unloadable?: ReadonlySet<string>;
}) {
  if (variants.length === 0) return null;
  const selected = variants.find((variant) => variant.path === chosen) ?? variants[0]!;
  return (
    <div className={styles.versions}>
      <div className={styles.versionsHead}>
        <span className={styles.versionsTitle}>Version</span>
        <span className={styles.versionsMemory}>
          {loading
            ? 'Reading sizes…'
            : memoryBytes
              ? `${backendName ?? 'This machine'} has ${formatBytes(memoryBytes)} of graphics memory`
              : null}
        </span>
      </div>
      <div className={styles.versionList} role="radiogroup" aria-label="Version">
        {variants.map((variant) => {
          const on = variant.path === selected.path;
          const wont = unloadable?.has(variant.path) ?? false;
          return (
            <button
              key={variant.path}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled || (wont && !on)}
              className={`${styles.versionRow} ${on ? styles.versionRowOn : ''} ${wont ? styles.versionRowWont : ''}`}
              onClick={() => onChoose(variant.path)}
              title={wont ? UNLOADABLE_WORDS.detail : variant.filename}
            >
              <span className={styles.versionLabel}>
                {variantLabel(variant)}
                {wont ? (
                  <span className={styles.versionBadgeWont}>{UNLOADABLE_WORDS.pill}</span>
                ) : variant.recommended ? (
                  <span className={styles.versionBadge}>Recommended</span>
                ) : null}
              </span>
              <span className={`mono ${styles.versionFile}`}>{variant.filename}</span>
              <span className={`mono ${styles.versionSize}`}>
                {variant.sizeBytes != null ? formatBytes(variant.sizeBytes) : ''}
              </span>
            </button>
          );
        })}
      </div>
      <p className={styles.versionNote}>{KIND_NOTE[selected.kind]}</p>
    </div>
  );
}

/**
 * Which of these versions will not load, from the same cached header check as
 * the cards, and a loadable path to fall back to when the chosen one is not.
 * Asks for the headers it has not read yet.
 */
export function useUnloadableVariants(entryUrl: string, variants: readonly ModelVariant[], chosen: string | null) {
  const layoutOf = useLayoutOf();
  const urls = variants.map((variant) => variantUrl(entryUrl, variant.path));
  const key = urls.join('\n');
  useEffect(() => {
    if (key) requestLayouts(key.split('\n'));
  }, [key]);
  const wont = new Set(variants.filter((_, i) => layoutOf(urls[i]) === 'diffusers').map((variant) => variant.path));
  const pick = chosen ?? variants[0]?.path ?? null;
  const fallback =
    pick && wont.has(pick)
      ? (variants.find((v) => v.recommended && !wont.has(v.path)) ?? variants.find((v) => !wont.has(v.path)))?.path ?? null
      : null;
  return { wont, fallback };
}
