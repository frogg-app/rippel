/**
 * The starting image control.
 *
 * PLAN.md §6 is explicit that the two sources are equal citizens: a file you
 * drop and a picture already in your library do the same thing and are offered
 * side by side. So this is one control with two ways in, not an upload widget
 * with a library feature bolted on.
 *
 * Choosing an image is also what switches the job to img2img — there is no
 * mode to set. That follows from the capability/manifest design: the user
 * expresses intent by picking a picture, and the server decides which workflow
 * that implies.
 */

import { useCallback, useRef, useState } from 'react';
import type { ImageSource } from '@comfy/shared';

import { ApiRequestError } from '../lib/api';
import { uploadsApi } from '../lib/api-jobs';
import type { InitImageState } from './form';
import { LibraryPicker } from './LibraryPicker';
import styles from './referenceImage.module.css';

interface Props {
  value: InitImageState | null;
  onChange: (next: InitImageState | null) => void;
  disabled?: boolean;
}

/** Denoise, phrased the way the artboard does — as how far to travel. */
const INFLUENCE_MIN = 0.05;
const INFLUENCE_MAX = 1;

export function ReferenceImage({ value, onChange, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(null);
      try {
        const { upload } = await uploadsApi.create(file);
        const source: ImageSource = { from: 'upload', uploadId: upload.id };
        onChange({ source, previewUrl: upload.thumbUrl, influence: 0.6 });
      } catch (err) {
        // The server knows why far better than we do — it decoded the bytes.
        setError(
          err instanceof ApiRequestError ? err.message : 'That file could not be uploaded.',
        );
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );

  if (value) {
    return (
      <section className={styles.block} aria-label="Starting image">
        <div className={styles.header}>
          <span className={styles.label}>Starting image</span>
          <button
            type="button"
            className={styles.clear}
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            Remove
          </button>
        </div>

        <div className={styles.chosen}>
          <img className={styles.thumb} src={value.previewUrl} alt="" />
          <div className={styles.influence}>
            <label className={styles.influenceLabel} htmlFor="init-influence">
              Image influence
              {/* The number is the thing being set; naming it "denoise" here
                  would leak a sampler concept into a control about how much of
                  your picture survives. */}
              <span className={styles.influenceValue}>{Math.round(value.influence * 100)}%</span>
            </label>
            <input
              id="init-influence"
              type="range"
              min={INFLUENCE_MIN}
              max={INFLUENCE_MAX}
              step={0.05}
              value={value.influence}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, influence: Number(e.target.value) })}
            />
            <p className={styles.influenceHint}>
              Lower keeps more of the original; higher follows the prompt.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.block} aria-label="Starting image">
      <div className={styles.header}>
        <span className={styles.label}>Starting image</span>
        <span className={styles.optional}>Optional</span>
      </div>

      <div
        className={dragging ? `${styles.drop} ${styles.dropActive}` : styles.drop}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void accept(e.dataTransfer.files[0]);
        }}
      >
        <p className={styles.dropText}>
          {busy ? 'Uploading…' : 'Drop an image to start from'}
        </p>
        <div className={styles.dropActions}>
          <button
            type="button"
            className={styles.dropButton}
            onClick={() => fileInput.current?.click()}
            disabled={disabled || busy}
          >
            Choose a file
          </button>
          <button
            type="button"
            className={styles.dropButton}
            onClick={() => setPicking(true)}
            disabled={disabled || busy}
          >
            From library
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className={styles.fileInput}
          onChange={(e) => {
            void accept(e.target.files?.[0]);
            // Clear it, or choosing the same file twice in a row fires nothing.
            e.target.value = '';
          }}
        />
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      {picking ? (
        <LibraryPicker
          onClose={() => setPicking(false)}
          onPick={(asset) => {
            onChange({
              source: { from: 'asset', assetId: asset.id },
              previewUrl: asset.thumbUrl,
              influence: 0.6,
            });
            setPicking(false);
          }}
        />
      ) : null}
    </section>
  );
}
