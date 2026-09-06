import type { LibraryAsset } from '../lib/api-library';
import { clockDuration } from './grouping';
import { PlayIcon, StarIcon } from './icons';
import styles from './AssetGrid.module.css';

/**
 * One tile.
 *
 * The artboard gives the tile nothing but the image: no caption, no chrome, and
 * a 1.5px accent ring when it is the one open in the drawer. Everything else —
 * the star, the duration badge — is small, dark and sits *on* the picture,
 * because the whole aesthetic is that images carry the colour and the app
 * carries none.
 */
export function AssetTile({
  asset,
  selected,
  onOpen,
  onToggleStar,
}: {
  asset: LibraryAsset;
  selected: boolean;
  onOpen: (asset: LibraryAsset) => void;
  onToggleStar: (asset: LibraryAsset) => void;
}) {
  return (
    <div className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}>
      <button
        type="button"
        className={styles.tileButton}
        onClick={() => onOpen(asset)}
        aria-pressed={selected}
        // The prompt is the only thing that distinguishes one tile from
        // another to a screen reader, so it is the accessible name.
        aria-label={asset.prompt ?? 'Untitled generation'}
      >
        <img
          className={styles.thumb}
          src={asset.thumbUrl}
          alt=""
          loading="lazy"
          decoding="async"
          // Known before the bytes arrive, so the grid never reflows as images
          // land — the single worst thing an infinite scroll can do.
          width={asset.width}
          height={asset.height}
        />
      </button>

      {asset.kind === 'video' && asset.duration !== null ? (
        <span className={`mono ${styles.duration}`}>
          <PlayIcon size={10} />
          {clockDuration(asset.duration)}
        </span>
      ) : null}

      <button
        type="button"
        className={`${styles.star} ${asset.starred ? styles.starOn : ''}`}
        onClick={() => onToggleStar(asset)}
        aria-pressed={asset.starred}
        aria-label={asset.starred ? 'Unstar' : 'Star'}
        title={asset.starred ? 'Unstar' : 'Star'}
      >
        <StarIcon size={14} filled={asset.starred} />
      </button>
    </div>
  );
}
