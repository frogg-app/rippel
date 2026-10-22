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
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ModelCatalogEntry } from '@comfy/shared';
import { SUPPORT_ROLES, basename, formatBytes, generates } from './catalogue';
import { FitFact } from './FitFact';
import { authorOf, drawerFit, fitOf, fullId, huggingFaceUrl, shortName, sizeBytesOf } from './cardFacts';
import { expertFor } from './vocabulary';
import { DRAWER_TAG_ORDER, entryTags, tagKey, type TagKey } from './discover';
import {
  CardVerdict,
  InstallControls,
  artGradient,
  UnloadablePill,
  type InstallControlsProps,
} from './CatalogueCard';
import { CloseIcon, ExpandIcon, HeartIcon } from './icons';
import { PreviewLightbox } from './PreviewLightbox';
import { requestLayouts } from './weightsLayouts';
import { UNLOADABLE_WORDS, unloadable } from './intents';
import { useVariants, VersionPicker, type LoadVariants } from './VersionPicker';
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
  /** Reads a Hugging Face model's versions; without it the picker shows names only. */
  loadVariants?: LoadVariants;
  /** Every file from the same repo, this one included; a picker when more than one. */
  siblings?: ModelCatalogEntry[];
  onPick?: (entry: ModelCatalogEntry) => void;
  /** The backend's graphics memory, for the fit. */
  memoryBytes?: number | null;
}

/** One cell of the facts grid; absent facts are left out, never invented. */
function Fact({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className={styles.fact} title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function CatalogueDrawer({
  entry,
  onClose,
  onTag,
  activeTags,
  onWorkflows,
  backendName,
  loadVariants,
  siblings = [],
  onPick,
  memoryBytes = null,
  ...install
}: CatalogueDrawerProps) {
  const title = shortName(entry);
  const author = authorOf(entry);
  const hfUrl = huggingFaceUrl(entry);
  const bytes = sizeBytesOf(entry);
  const fit = fitOf(entry, bytes, memoryBytes, SUPPORT_ROLES[entry.type].noun);
  const versions = useVariants(entry, loadVariants);
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

  // Looking at a file is the moment to read what it holds; see weightsLayouts.ts.
  useEffect(() => {
    requestLayouts([entry, ...siblings].filter((member) => !member.installed && !member.weightsLayout).map((member) => member.url));
  }, [entry, siblings]);

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
          <header className={styles.drawerHead}>
            <div className={styles.drawerTitle}>
              <h2 className={styles.drawerName} title={fullId(entry)}>
                {title}
              </h2>
              {hfUrl ? (
                <a className={styles.hfLink} href={hfUrl} target="_blank" rel="noreferrer noopener">
                  View on Hugging Face <span aria-hidden>↗</span>
                </a>
              ) : null}
            </div>
            {author ? <p className={styles.drawerAuthor}>{author}</p> : null}
          </header>

          <dl className={styles.factsGrid}>
            <Fact label="Size" value={bytes ? formatBytes(bytes) : null} />
            {isSupport ? null : <FitFact fit={drawerFit(fit, bytes)} />}
            <Fact label="Memory here" value={memoryBytes ? formatBytes(memoryBytes) : null} />
            <Fact label="Licence" value={info?.license ?? null} />
            <Fact label="Downloads" value={info?.downloads ? info.downloads.toLocaleString() : null} />
            <Fact
              label="Likes"
              value={
                info?.likes ? (
                  <>
                    <HeartIcon size={11} /> {info.likes.toLocaleString()}
                  </>
                ) : null
              }
            />
            <Fact label="Type" value={role.noun} title={expertFor(entry.type, entry.filename)} />
            <Fact label="Family" value={entry.base} />
          </dl>

          {siblings.length > 1 ? (
            <div className={styles.versions}>
              <div className={styles.versionsHead}>
                <span className={styles.versionsTitle}>File</span>
                <span className={styles.versionsMemory}>{siblings.length} files from this repo</span>
              </div>
              <div className={styles.versionList} role="radiogroup" aria-label="File">
                {siblings.map((sibling) => {
                  const on = sibling.ref === entry.ref;
                  const size = sizeBytesOf(sibling);
                  return (
                    <button
                      key={sibling.ref}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`${styles.versionRow} ${on ? styles.versionRowOn : ''}`}
                      onClick={() => onPick?.(sibling)}
                      title={sibling.name}
                    >
                      <span className={styles.versionLabel}>
                        {basename(sibling.filename)}
                        {sibling.installed ? <span className={styles.versionBadge}>Installed</span> : null}
                        {unloadable(sibling) ? <span className={styles.versionBadge} title={UNLOADABLE_WORDS.detail}>{UNLOADABLE_WORDS.pill}</span> : null}
                      </span>
                      <span className={`mono ${styles.versionFile}`}>{sibling.savePath || (sibling.ref.startsWith('hugging-face:') ? 'Hugging Face repo' : '—')}</span>
                      <span className={`mono ${styles.versionSize}`}>{size ? formatBytes(size) : ''}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {versions.variants.length > 0 && !entry.installBlockedReason ? (
            <VersionPicker
              variants={versions.variants}
              memoryBytes={versions.memoryBytes}
              loading={versions.loading}
              chosen={versions.chosen}
              onChoose={versions.choose}
              backendName={backendName}
            />
          ) : null}

          {unloadable(entry) && !versions.chosen ? <p><UnloadablePill /></p> : null}
          <CardVerdict entry={entry} onWorkflows={onWorkflows}>
            {isSupport ? <span className={styles.verdictWhere}> {role.where}</span> : null}
          </CardVerdict>
          {!isSupport && entry.runnability && backendName ? (
            <p className={styles.drawerOn}>Judged against {backendName}.</p>
          ) : null}
          {entry.sourceWorkflow ? (
            <p className={styles.drawerNote}>Used by the workflow “{entry.sourceWorkflow.title}”.</p>
          ) : null}

          <div className={styles.drawerActions}>
            <InstallControls
              // A chosen version is another file; the header read was of the default.
              entry={versions.chosen ? { ...entry, weightsLayout: undefined } : entry}
              {...install}
              onInstall={(chosen) => install.onInstall(chosen, versions.chosen ?? undefined)}
            />
          </div>

          {info?.description || entry.description ? (
            <p className={styles.drawerDescription}>{info?.description || entry.description}</p>
          ) : null}
          {info?.baseModels?.length ? (
            <p className={styles.drawerNote}>Built on {info.baseModels.join(', ')}.</p>
          ) : null}

          <dl className={`${styles.drawerFacts} ${styles.drawerFactsQuiet}`}>
            <dt>File</dt>
            <dd className="mono" title={entry.filename}>
              {entry.filename}
            </dd>
            <dt>Installs to</dt>
            <dd className="mono">{entry.savePath || '—'}</dd>
            {info?.previewBorrowedFrom && preview ? (
              <>
                <dt>Picture</dt>
                <dd className={styles.borrowed}>sample from {info.previewBorrowedFrom}</dd>
              </>
            ) : null}
          </dl>

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
