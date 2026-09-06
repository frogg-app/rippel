/**
 * Picking a starting image out of your own library.
 *
 * The other half of PLAN.md §6's "two equal sources". It reuses the library's
 * own list endpoint rather than a bespoke one — the pictures you can start from
 * are exactly the pictures you have — and shows only the first page, because
 * this is a picker and not the Library screen.
 */

import { useEffect, useState } from 'react';
import type { Asset } from '@comfy/shared';

import { libraryApi } from '../lib/api-library';
import styles from './libraryPicker.module.css';

interface Props {
  onPick: (asset: Asset) => void;
  onClose: () => void;
}

export function LibraryPicker({ onPick, onClose }: Props) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    libraryApi.assets
      .list({ limit: 24, signal: controller.signal })
      .then((page) => setAssets(page.items))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Could not load your library.');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.backdrop} role="dialog" aria-modal aria-label="Pick a starting image">
      <div className={styles.panel}>
        <header className={styles.head}>
          <h2 className={styles.title}>Start from a generation</h2>
          <button type="button" className={styles.close} onClick={onClose}>
            Close
          </button>
        </header>

        {error ? <p className={styles.message}>{error}</p> : null}
        {!error && assets === null ? <p className={styles.message}>Loading…</p> : null}
        {assets?.length === 0 ? (
          <p className={styles.message}>
            You have not generated anything yet. Drop a file instead.
          </p>
        ) : null}

        <div className={styles.grid}>
          {assets?.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className={styles.tile}
              onClick={() => onPick(asset)}
            >
              <img src={asset.thumbUrl} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
