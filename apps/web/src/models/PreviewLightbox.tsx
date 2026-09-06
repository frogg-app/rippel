/**
 * A catalogue preview, big enough to actually read.
 *
 * This exists because of what the pictures *are*. A large share of HuggingFace
 * model-card images are contact sheets — a 3x3 or 4x4 grid of samples in one
 * file — and in a card that is one cell at 80 pixels: a thumbnail of a
 * thumbnail. Enlarging the cards helps, but a 4x4 sheet needs the whole screen
 * before you can see what a model actually produces, and that is a click, not a
 * bigger grid.
 *
 * The API stores a second, ~1600px rendition for exactly this, so opening one
 * is a real gain in detail rather than the card's image scaled up. It is
 * fetched only on the click: a page of 48 cards must not download it.
 *
 * Deliberately small and self-contained — no dialog library, no focus trap
 * beyond moving focus to the close button and putting it back. Escape closes,
 * the backdrop closes, and the caption says which model and where its picture
 * came from, because a borrowed sample must stay labelled even at full size.
 */
import { useEffect, useRef } from 'react';
import { CloseIcon } from './icons';
import styles from './ModelsPanels.module.css';

export interface PreviewLightboxProps {
  /** Model name, for the caption and the dialog's label. */
  name: string;
  /** The large rendition's URL, on this API. */
  src: string;
  /** "huggingface.co/org/repo/…/sample.png" — where the picture came from. */
  from: string | null;
  /** Set when the picture belongs to the model this one is derived from. */
  borrowedFrom: string | null;
  onClose: () => void;
}

export function PreviewLightbox({ name, src, from, borrowedFrom, onClose }: PreviewLightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Whatever had focus when this opened — the card's image button, normally.
  // Returning focus there is what makes Escape feel like "back" rather than
  // like being dropped at the top of a 372-card grid.
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement;
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    // The grid behind this must not scroll while it is open: a wheel over a
    // full-screen image that moves the page underneath reads as broken.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, [onClose]);

  return (
    <div
      className={styles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${name}`}
      // Only a click that started *and* ended on the backdrop closes, so a drag
      // that begins on the image and finishes outside it does not.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.lightboxInner}>
        <div className={styles.lightboxBar}>
          <p className={styles.lightboxName}>{name}</p>
          <button
            ref={closeRef}
            type="button"
            className={styles.lightboxClose}
            onClick={onClose}
            aria-label="Close the preview"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <img className={styles.lightboxImage} src={src} alt={`Sample output for ${name}`} />

        {from || borrowedFrom ? (
          <p className={styles.lightboxSource}>
            {borrowedFrom ? `Sample from ${borrowedFrom}, which this is built on` : null}
            {borrowedFrom && from ? ' · ' : null}
            {from}
          </p>
        ) : null}
      </div>
    </div>
  );
}
