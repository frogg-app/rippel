/**
 * One catalogue entry.
 *
 * ## The picture
 *
 * The catalogue itself still has no previews — ComfyUI-Manager's list is
 * filenames and sizes. The API resolves each entry's model page, picks a sample
 * image out of the author's own repo, downscales it and serves it from
 * `/api/model-previews/<id>`; `entry.info.previewUrl` is that path. So the
 * `<img>` here is same-origin: no tile ever talks to huggingface.co.
 *
 * Roughly half the catalogue has no picture and never will — a T5 encoder repo
 * contains weights and nothing else — so the family gradient stays as the
 * floor, and it is also what a broken image falls back to. A grid where a third
 * of the tiles are broken icons is worse than a grid with no pictures at all.
 *
 * A card with a picture is **clickable**. Many of these images are contact
 * sheets — a 3x3 or 4x4 grid of samples in one file — where even an enlarged
 * card shows each sample at thumbnail size; the API keeps a second, ~1600px
 * rendition for that click, so opening one is a real gain in detail rather than
 * the card's own image scaled up.
 *
 * ## The verdict
 *
 * Every card says whether this file would actually run on the selected backend,
 * in the API's own words. That is the difference between a grid of 372 things
 * you may install and a grid of 372 things, 31 of which will work — and it is
 * the one thing that was missing before a seven-gigabyte download.
 *
 * The install states are unchanged, and are still the ones the API can
 * distinguish:
 *
 *   available   the install button
 *   starting    the POST is in flight
 *   queued /    the transport has it; no percentage exists, so an
 *   downloading indeterminate bar and the transport's own words
 *   complete    treated as installed even before the catalogue's own
 *               `installed` flag catches up
 *   failed      the error, and the button back, labelled as a retry
 *   installed   no button at all: a re-install is answered with a 409
 */
import { useState, type CSSProperties } from 'react';
import type { ModelCatalogEntry, ModelInstall } from '@comfy/shared';
import {
  RUNNABILITY_LABEL,
  RUNNABILITY_TONE,
  SUPPORT_ROLES,
  familyHue,
  formatCount,
  generates,
  isLive,
} from './catalogue';
import { CheckIcon, DownloadCountIcon, ExpandIcon, InstallIcon, LinkIcon, WorkflowIcon } from './icons';
import { InstallProgress } from './InstallProgress';
import { TypeBadge } from './TypeBadge';
import { PreviewLightbox } from './PreviewLightbox';
import { Mark } from '../components/Mark';
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
  /** Position in the grid, for the staggered entrance. */
  index?: number;
  /** Opens the templates browser filtered to this entry's family. */
  onWorkflows?: (entry: ModelCatalogEntry) => void;
}

export function CatalogueCard({
  entry,
  install,
  starting,
  canInstall,
  onInstall,
  failure,
  now,
  index = 0,
  onWorkflows,
}: CatalogueCardProps) {
  const hue = familyHue(entry.base);
  const live = install !== null && isLive(install);
  const done = entry.installed || install?.status === 'complete';
  const retryable = install !== null && (install.status === 'failed' || install.status === 'cancelled');

  // A cached preview can still 404 — the row was written before someone
  // cleared the table, say. One failure per card, then the gradient.
  const [imageBroken, setImageBroken] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const preview = imageBroken ? null : entry.info?.previewUrl ?? null;
  // Rows cached by an earlier build have only the small rendition; those cards
  // simply are not clickable rather than opening a picture no bigger than the
  // one already on screen.
  const full = preview ? entry.info?.previewFullUrl ?? null : null;

  const verdict = entry.runnability;
  const info = entry.info;
  // Derived from the type, not from the verdict: the verdict is per backend and
  // is absent when one is offline, and "what this file is for" is not a fact
  // about a backend.
  const isSupport = !generates(entry.type);
  const role = SUPPORT_ROLES[entry.type];

  const art = (
    <>
      {preview ? (
        <img
          className={styles.cardImage}
          src={preview}
          // Decorative: the model's name is right underneath it, and a
          // description of somebody's sample render helps nobody.
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageBroken(true)}
        />
      ) : (
        // No sample render: the mark on the card's own hue, so every card in
        // the grid is the same shape whether or not a picture was found.
        <span className={styles.cardPlaceholder} aria-hidden>
          <Mark size={34} />
        </span>
      )}
      {done ? (
        <span className={styles.cardInstalled}>
          <CheckIcon size={10} /> Installed
        </span>
      ) : null}
      {full ? (
        <span className={styles.cardExpand} aria-hidden>
          <ExpandIcon size={13} />
        </span>
      ) : null}
    </>
  );

  const artClass = `${styles.cardArt} ${preview ? styles.cardArtPhoto : ''}`;
  const artStyle = preview
    ? undefined
    : {
        // Two stops off one hue, in the artboard's radial treatment.
        background: `radial-gradient(120% 100% at 32% 24%, hsl(${hue} 62% 62%) 0%, hsl(${
          (hue + 28) % 360
        } 48% 28%) 55%, var(--ground-sunken) 100%)`,
      };

  return (
    <article
      className={`${styles.card} ${live ? styles.cardBusy : ''}`}
      style={{ '--i': index } as CSSProperties}
      aria-label={entry.name}
    >
      <div className={styles.cardArtHolder}>
        {full ? (
          <button
            type="button"
            className={`${artClass} ${styles.cardArtButton}`}
            onClick={() => setEnlarged(true)}
            aria-label={`See the full-size preview of ${entry.name}`}
          >
            {art}
          </button>
        ) : (
          <div className={artClass} style={artStyle}>
            {art}
          </div>
        )}
        {/* The badge sits beside the art rather than inside it: it explains
            itself on focus, and a button cannot be nested in a button. */}
        <TypeBadge type={entry.type} className={styles.cardTypeSlot} />
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
            {info?.downloads ? (
              <>
                {' '}
                &middot;{' '}
                <span className={styles.cardDownloads} title={`${info.downloads.toLocaleString()} downloads at the source`}>
                  <DownloadCountIcon size={11} />
                  <span className="mono">{formatCount(info.downloads)}</span>
                </span>
              </>
            ) : null}
          </p>
          <p className={styles.cardFile} title={entry.filename}>
            {entry.filename}
          </p>
        </div>

        {isSupport ? (
          // Never "Support file" on its own, and never the type word on its
          // own. What it does to a model, and where in rippel it turns up.
          <p className={`${styles.verdict} ${styles.verdict_muted}`} title={`${role.what} ${role.where}`}>
            <span className={styles.verdictChip}>{role.noun}</span>
            <span className={styles.verdictText}>
              {role.what} <span className={styles.verdictWhere}>{role.where}</span>
            </span>
          </p>
        ) : verdict ? (
          <p
            className={`${styles.verdict} ${styles[`verdict_${RUNNABILITY_TONE[verdict.status]}`]}`}
            // The detail is the API's sentence, and it names the missing file or
            // the folder. It is on the element rather than always visible
            // because it is a paragraph, not a label.
            title={verdict.detail ?? verdict.summary}
          >
            <span className={styles.verdictChip}>{RUNNABILITY_LABEL[verdict.status]}</span>
            <span className={styles.verdictText}>{verdict.detail ?? verdict.summary}</span>
            {onWorkflows && verdict.status !== 'support' ? (
              <button
                type="button"
                className={styles.cardWorkflows}
                onClick={() => onWorkflows(entry)}
                aria-label={`Workflows for ${entry.base} models`}
              >
                <WorkflowIcon size={12} />
                Workflows
              </button>
            ) : null}
          </p>
        ) : null}

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

        {info?.license || info?.referenceUrl || info?.previewBorrowedFrom ? (
          <p className={styles.cardSource}>
            {info.license ? <span className={styles.licence}>{info.license}</span> : null}
            {info.referenceUrl ? (
              <a
                className={styles.sourceLink}
                href={info.referenceUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Model page <LinkIcon size={10} />
              </a>
            ) : null}
            {/* Whose picture this is, when it is not this model's own. A GGUF
                quantisation has no samples of its own; showing the original's
                is useful, and pretending it was rendered by this file is not. */}
            {info.previewBorrowedFrom && preview ? (
              <span className={styles.borrowed} title={`Sample image from ${info.previewBorrowedFrom}`}>
                sample from {info.previewBorrowedFrom}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      {enlarged && full ? (
        <PreviewLightbox
          name={entry.name}
          src={full}
          from={info?.previewFrom ?? null}
          borrowedFrom={info?.previewBorrowedFrom ?? null}
          onClose={() => setEnlarged(false)}
        />
      ) : null}
    </article>
  );
}
