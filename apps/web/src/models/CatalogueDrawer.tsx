/**
 * One catalogue entry in full: the drawer the card's art opens.
 *
 * The card was carrying a filename, a support-role paragraph, a licence, a
 * model-page link and a borrowed-picture credit under its verdict, and in a
 * grid of 48 that is the part nobody reads until they have already picked one.
 * So the card keeps what you choose *by* — name, stats, five tags, verdict,
 * install — and this holds everything you check *before* installing:
 *
 *   - the full tag row, in HuggingFace's own order (task, library, format,
 *     language, base, tags, licence). Every chip closes the drawer and filters
 *     Discover by itself, which is how somebody who found one good model finds
 *     the next five like it;
 *   - the verdict again, plus where rippel uses a support file;
 *   - the facts: type, file, size, where it installs, the counts, the source;
 *   - the same install controls as the card (`InstallControls`), so starting
 *     an install from here is the same click with the same states.
 *
 * The large preview is still reachable: the drawer's art is a button for
 * `PreviewLightbox` whenever a ~1600px rendition exists. Escape closes the
 * lightbox first and the drawer second, never both at once.
 *
 * Like the lightbox, deliberately no dialog library: focus moves to the close
 * button on open and back to whatever opened it on close, the scrim and Escape
 * close, and the page behind does not scroll.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelCatalogEntry } from '@comfy/shared';
import { SUPPORT_ROLES, formatCount, generates } from './catalogue';
import { expertFor } from './vocabulary';
import { DRAWER_TAG_ORDER, entryTags, tagKey, type TagKey } from './discover';
import {
  CardVerdict,
  InstallControls,
  OwnedName,
  artGradient,
  type InstallControlsProps,
} from './CatalogueCard';
import { CloseIcon, ExpandIcon, HeartIcon, LinkIcon } from './icons';
import { PreviewLightbox } from './PreviewLightbox';
import { TagChip } from './TagChip';
import styles from './ModelsPanels.module.css';

export interface CatalogueDrawerProps extends InstallControlsProps {
  onClose: () => void;
  /** Toggle a tag filter. The drawer closes first, so the result is visible. */
  onTag: (key: TagKey) => void;
  activeTags: ReadonlySet<TagKey>;
  onWorkflows?: (entry: ModelCatalogEntry) => void;
  /** "on desktop-4090", after the verdict: a verdict is never global. */
  backendName: string | null;
}

export function CatalogueDrawer({
  entry,
  onClose,
  onTag,
  activeTags,
  onWorkflows,
  backendName,
  ...install
}: CatalogueDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreTo = useRef<Element | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);

  const info = entry.info;
  const preview = imageBroken ? null : info?.previewUrl ?? null;
  const full = preview ? info?.previewFullUrl ?? null : null;
  const tags = entryTags(entry);
  const isSupport = !generates(entry.type);
  const role = SUPPORT_ROLES[entry.type];

  useEffect(() => {
    restoreTo.current = document.activeElement;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (restoreTo.current instanceof HTMLElement && restoreTo.current.isConnected) {
        restoreTo.current.focus();
      }
    };
  }, []);

  useEffect(() => {
    // While the lightbox is open it owns Escape; one press closes one layer.
    if (enlarged) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enlarged, onClose]);

  const artInner = (
    <>
      {preview ? (
        <img
          className={styles.cardImage}
          src={preview}
          alt=""
          decoding="async"
          onError={() => setImageBroken(true)}
        />
      ) : null}
      <span className={styles.drawerType} title={expertFor(entry.type, entry.filename)}>
        {SUPPORT_ROLES[entry.type].noun}
      </span>
      {full ? (
        <span className={styles.drawerExpand} aria-hidden>
          <ExpandIcon size={13} />
        </span>
      ) : null}
    </>
  );

  return createPortal(
    <>
      <div className={styles.drawerScrim} onClick={onClose} aria-hidden />
      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label={`Details of ${entry.name}`}
      >
        <button
          ref={closeRef}
          type="button"
          className={styles.drawerClose}
          onClick={onClose}
          aria-label="Close the details"
        >
          <CloseIcon size={16} />
        </button>

        {full ? (
          <button
            type="button"
            className={`${styles.drawerArt} ${styles.drawerArtButton}`}
            onClick={() => setEnlarged(true)}
            aria-label={`See the full-size preview of ${entry.name}`}
          >
            {artInner}
          </button>
        ) : (
          <div className={styles.drawerArt} style={preview ? undefined : artGradient(entry.base)}>
            {artInner}
          </div>
        )}

        <div className={styles.drawerBody}>
          <div className={styles.drawerTitle}>
            <h2 className={styles.drawerName}>
              <OwnedName entry={entry} />
            </h2>
            {info?.likes ? (
              <span className={styles.drawerLikes} title={`${info.likes.toLocaleString()} likes at the source`}>
                <span>
                  <HeartIcon size={12} /> Likes
                </span>
                <span className="mono">{formatCount(info.likes)}</span>
              </span>
            ) : null}
          </div>

          {DRAWER_TAG_ORDER.some((group) => tags[group].length > 0) ? (
            <div className={styles.drawerTags} role="group" aria-label="Tags">
              {DRAWER_TAG_ORDER.flatMap((group) =>
                tags[group].map((value) => {
                  const key = tagKey(group, value);
                  return (
                    <TagChip
                      key={key}
                      group={group}
                      value={value}
                      size="drawer"
                      on={activeTags.has(key)}
                      onClick={() => {
                        onClose();
                        onTag(key);
                      }}
                    />
                  );
                }),
              )}
            </div>
          ) : (
            <p className={styles.drawerNote}>
              {info
                ? 'Its model page lists no tags.'
                : 'Still reading its model page; tags appear when that finishes.'}
            </p>
          )}

          <CardVerdict entry={entry} onWorkflows={onWorkflows}>
            {isSupport ? <span className={styles.verdictWhere}> {role.where}</span> : null}
          </CardVerdict>
          {!isSupport && entry.runnability && backendName ? (
            <p className={styles.drawerOn}>Judged against {backendName}.</p>
          ) : null}

          <dl className={styles.drawerFacts}>
            <dt>Type</dt>
            <dd>{`${role.noun} (${expertFor(entry.type, entry.filename)})`}</dd>
            <dt>Family</dt>
            <dd>{entry.base}</dd>
            <dt>File</dt>
            <dd className="mono" title={entry.filename}>
              {entry.filename}
            </dd>
            {entry.size ? (
              <>
                <dt>Size</dt>
                <dd className="mono">{entry.size}</dd>
              </>
            ) : null}
            <dt>Installs to</dt>
            <dd className="mono">{entry.savePath}</dd>
            {info?.downloads ? (
              <>
                <dt>Downloads</dt>
                <dd className="mono">{info.downloads.toLocaleString()}</dd>
              </>
            ) : null}
            {info?.referenceUrl ? (
              <>
                <dt>Source</dt>
                <dd>
                  <a
                    className={styles.sourceLink}
                    href={info.referenceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {info.referenceUrl.replace(/^https?:\/\//, '')} <LinkIcon size={10} />
                  </a>
                </dd>
              </>
            ) : null}
            {/* Whose picture this is, when it is not this model's own. A GGUF
                quantisation has no samples of its own; showing the original's
                is useful, and pretending it was rendered by this file is not. */}
            {info?.previewBorrowedFrom && preview ? (
              <>
                <dt>Picture</dt>
                <dd className={styles.borrowed}>sample from {info.previewBorrowedFrom}</dd>
              </>
            ) : null}
          </dl>

          {/* The publisher's own words, from the model card, when we have them;
              the catalogue's one-liner otherwise. */}
          {info?.description || entry.description ? (
            <p className={styles.drawerDescription}>{info?.description || entry.description}</p>
          ) : null}
          {info?.baseModels?.length ? (
            <p className={styles.drawerNote}>Built on {info.baseModels.join(', ')}.</p>
          ) : null}
          {entry.sourceWorkflow ? (
            <p className={styles.drawerNote}>Used by the workflow “{entry.sourceWorkflow.title}”.</p>
          ) : null}

          <div className={styles.drawerActions}>
            <InstallControls entry={entry} {...install} />
          </div>
        </div>
      </aside>

      {enlarged && full ? (
        <PreviewLightbox
          name={entry.name}
          src={full}
          from={info?.previewFrom ?? null}
          borrowedFrom={info?.previewBorrowedFrom ?? null}
          onClose={() => setEnlarged(false)}
        />
      ) : null}
    </>,
    document.body,
  );
}
