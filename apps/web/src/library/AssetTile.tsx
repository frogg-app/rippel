import type { LibraryAsset } from '../lib/api-library';
import { clockDuration } from './grouping';
import { GlobeIcon, LinkIcon, LockIcon, PlayIcon, StarIcon } from './icons';
import { VISIBILITY_HINT, VISIBILITY_LABEL } from '../lib/sharing';
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
  index = 0,
  onOpen,
  onToggleStar,
  me = null,
}: {
  asset: LibraryAsset;
  /** The signed-in user; someone else's asset gets a byline and no star. */
  me?: string | null;
  selected: boolean;
  /** Position within its group, for the staggered entrance. */
  index?: number;
  onOpen: (asset: LibraryAsset) => void;
  onToggleStar: (asset: LibraryAsset) => void;
}) {
  return (
    <div
      className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}
      style={{ '--i': index } as React.CSSProperties}
    >
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
        {/* The prompt, on hover only: the grid stays pictures, and the words
            arrive when you ask for them. */}
        {asset.prompt ? (
          <span className={styles.scrim} aria-hidden>
            <span className={styles.caption}>{asset.prompt}</span>
          </span>
        ) : null}
      </button>

      {asset.kind === 'video' && asset.duration !== null ? (
        <span className={`mono ${styles.duration}`}>
          <PlayIcon size={10} />
          {clockDuration(asset.duration)}
        </span>
      ) : null}

      {me !== null && asset.ownerId !== me ? (
        <span className={styles.byline}>{asset.ownerName}</span>
      ) : null}
      {asset.purgesAt ? (
        <span className={styles.byline}>{daysLeft(asset.purgesAt)}</span>
      ) : null}

      {/* Who can see it, on every tile: a lock, a link or a globe. Private
          is muted so the shared ones stand out at a glance. */}
      <span
        className={`${styles.shared} ${asset.visibility === 'private' ? styles.sharedPrivate : ''}`}
        title={`${VISIBILITY_LABEL[asset.visibility]}: ${VISIBILITY_HINT[asset.visibility]}`}
        aria-label={VISIBILITY_LABEL[asset.visibility]}
        role="img"
      >
        {asset.visibility === 'public' ? (
          <GlobeIcon size={11} />
        ) : asset.visibility === 'link' ? (
          <LinkIcon size={11} />
        ) : (
          <LockIcon size={11} />
        )}
      </span>

      {(me === null || asset.ownerId === me) && !asset.archivedAt ? (
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
      ) : null}
    </div>
  );
}

function daysLeft(purgesAt: string): string {
  const days = Math.ceil((Date.parse(purgesAt) - Date.now()) / 86_400_000);
  return days <= 1 ? 'Deletes soon' : `${days} days left`;
}
