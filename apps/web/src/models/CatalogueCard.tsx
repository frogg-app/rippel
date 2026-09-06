/**
 * One catalogue entry.
 *
 * The artboard's card is a photograph with a badge on it. The catalogue has no
 * photographs — `ModelCatalogEntry` carries no preview URL, verified against
 * the live endpoint — so the art band is a gradient derived from the entry's
 * family. Same family, same colour: the grid stays scannable by family, and
 * nothing on it pretends to be a picture of a model we do not have.
 *
 * The states are the ones the API can actually distinguish:
 *
 *   available   the install button
 *   starting    the POST is in flight
 *   queued /    the transport has it; no percentage exists, so an
 *   downloading indeterminate bar and the transport's own words
 *   complete    treated as installed even before the catalogue's own
 *               `installed` flag catches up — completion is decided by ComfyUI
 *               listing the file, and Manager's flag can lag that by a poll
 *   failed      the error, and the button back, labelled as a retry
 *   installed   no button at all: a re-install is answered with a 409, and
 *               offering the click would be a lie
 */
import type { ModelCatalogEntry, ModelInstall } from '@comfy/shared';
import { TYPE_LABELS, familyHue, isLive } from './catalogue';
import { CheckIcon, InstallIcon } from './icons';
import { InstallProgress } from './InstallProgress';
import styles from './ModelsPanels.module.css';

export interface CatalogueCardProps {
  entry: ModelCatalogEntry;
  /** The most recent install of this file on this backend, if any. */
  install: ModelInstall | null;
  starting: boolean;
  /** False when nothing can be installed here — an offline backend. */
  canInstall: boolean;
  onInstall: (entry: ModelCatalogEntry) => void;
  /** A refusal from the last attempt on this entry: a 400, a 409, a 502. */
  failure: string | null;
  now: number;
}

export function CatalogueCard({
  entry,
  install,
  starting,
  canInstall,
  onInstall,
  failure,
  now,
}: CatalogueCardProps) {
  const hue = familyHue(entry.base);
  const live = install !== null && isLive(install);
  const done = entry.installed || install?.status === 'complete';
  const retryable = install !== null && (install.status === 'failed' || install.status === 'cancelled');

  return (
    <article className={`${styles.card} ${live ? styles.cardBusy : ''}`} aria-label={entry.name}>
      <div
        className={styles.cardArt}
        style={{
          // Two stops off one hue, in the artboard's radial treatment.
          background: `radial-gradient(120% 100% at 32% 24%, hsl(${hue} 62% 62%) 0%, hsl(${
            (hue + 28) % 360
          } 48% 28%) 55%, #0f0d14 100%)`,
        }}
      >
        <span className={styles.cardType}>{TYPE_LABELS[entry.type].toUpperCase()}</span>
        {done ? (
          <span className={styles.cardInstalled}>
            <CheckIcon size={10} /> Installed
          </span>
        ) : null}
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardName} title={entry.name}>
            {entry.name}
          </h3>
          <p className={styles.cardMeta}>
            {entry.base}
            {entry.size ? (
              <>
                {' '}
                &middot; <span className="mono">{entry.size}</span>
              </>
            ) : null}
          </p>
          <p className={styles.cardFile} title={entry.filename}>
            {entry.filename}
          </p>
        </div>

        {install && !done ? <InstallProgress install={install} now={now} compact /> : null}

        {done ? (
          <p className={styles.cardResting}>Already on this backend</p>
        ) : live || starting ? null : (
          <button
            type="button"
            className={styles.installButton}
            onClick={() => onInstall(entry)}
            disabled={!canInstall}
          >
            <InstallIcon size={13} />
            {retryable ? 'Try again' : 'Install'}
          </button>
        )}

        {starting ? <p className={styles.cardResting}>Starting…</p> : null}

        {failure ? (
          <p className={styles.cardFailure} role="alert">
            {failure}
          </p>
        ) : null}
      </div>
    </article>
  );
}
