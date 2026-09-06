import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  Collection,
  LibraryApi,
  LibraryAsset,
  LibraryJob,
} from '../lib/api-library';
import { downloadAsset, libraryApi as defaultApi } from '../lib/api-library';
import { renderTime } from './grouping';
import { buildPrefill, type CreatePrefill, type PrefillMode } from './remix';
import { useClipboard } from './useClipboard';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  PlayIcon,
  RemixIcon,
  StarIcon,
  TrashIcon,
} from './icons';
import styles from './DetailDrawer.module.css';

/**
 * The detail view: a centred modal over the grid.
 *
 * It was a 404px side drawer, which squeezed a 1344-wide render into a
 * 360px column. As a modal the picture gets most of the viewport, plays
 * video at a size you can actually judge, and the settings sit underneath in
 * two columns instead of a long scroll. It portals to `document.body` so no
 * transformed ancestor (a lifted tile) can trap it.
 *
 * It shows the image, the actions, and the parameters the picture was made
 * with — read from the *originating job*, not from the asset. That distinction
 * is the whole point of the panel: an asset knows its pixels, and only the job
 * knows the prompt, the seed and the sampler that produced them, which is what
 * makes a render reproducible.
 *
 * Prompt and seed are the two things anyone ever wants out of this panel by
 * hand, so both have a copy button. Everything else is read-only text.
 */
export function DetailDrawer({
  asset,
  position,
  hasPrev = false,
  hasNext = false,
  onNavigate,
  onClose,
  onToggleStar,
  onDelete,
  onPrefill,
  collections,
  onAddToCollection,
  onRemoveFromCollection,
  onAssetPatched,
  api = defaultApi,
}: {
  asset: LibraryAsset;
  /** Where this asset sits in the grid, for the "3 of 40" readout. */
  position?: { index: number; total: number };
  hasPrev?: boolean;
  hasNext?: boolean;
  /** Step to the neighbouring asset; the page changes `asset`. */
  onNavigate?: (direction: -1 | 1) => void;
  onClose: () => void;
  onToggleStar: (asset: LibraryAsset) => void;
  onDelete: (asset: LibraryAsset) => void;
  /** Hands a built payload up; the page does the navigating. */
  onPrefill: (prefill: CreatePrefill) => void;
  collections: Collection[];
  onAddToCollection: (
    collectionId: string,
    assetId: string,
  ) => Promise<boolean>;
  onRemoveFromCollection: (
    collectionId: string,
    assetId: string,
  ) => Promise<boolean>;
  /** So membership ticks stay right in the grid's copy of the row too. */
  onAssetPatched: (id: string, patch: Partial<LibraryAsset>) => void;
  api?: LibraryApi;
}) {
  const [job, setJob] = useState<LibraryJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const clipboard = useClipboard();

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setLoading(true);
    setFailed(false);
    setJob(null);
    setMenuOpen(false);

    api.assets
      .get(asset.id, controller.signal)
      .then((detail) => {
        if (!live) return;
        setJob(detail.job);
        // The detail response is authoritative about membership and starring;
        // the grid row may have been listed before either changed.
        onAssetPatched(asset.id, {
          starred: detail.asset.starred,
          collectionIds: detail.asset.collectionIds,
        });
      })
      .catch(() => {
        if (live) setFailed(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
    // `onAssetPatched` is stable (useCallback in the feed); re-running this on
    // every parent render would refetch the drawer constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, asset.id]);

  // The direction of the last step, so the incoming media slides from that
  // side; 0 until the first step, so the open plays the plain entrance.
  const [travel, setTravel] = useState<-1 | 0 | 1>(0);
  const step = (direction: -1 | 1) => {
    if (!onNavigate) return;
    if (direction === -1 && !hasPrev) return;
    if (direction === 1 && !hasNext) return;
    setTravel(direction);
    onNavigate(direction);
  };

  // Escape closes, as it must for anything that overlays content; the arrow
  // keys step through the grid, unless the user is typing somewhere.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `step` closes over the latest props; re-binding per render is cheap.
  });

  const params = job?.params;
  const advanced = params?.advanced;
  const seed = job?.seed ?? advanced?.seed ?? null;

  const rows = useMemo(() => {
    if (!job || !params) return [];
    const entries: Array<{
      label: string;
      value: React.ReactNode;
      mono?: boolean;
    }> = [];
    entries.push({ label: 'Model', value: job.modelName ?? '—' });
    if (job.loraNames.length && params.loras?.length) {
      entries.push({
        label: job.loraNames.length > 1 ? 'LoRAs' : 'LoRA',
        value: job.loraNames.map((name, index) => (
          <span key={name}>
            {name}{' '}
            <span className={`mono ${styles.weight}`}>
              {params.loras?.[index]?.weight.toFixed(2)}
            </span>
            {index < job.loraNames.length - 1 ? ', ' : ''}
          </span>
        )),
      });
    }
    entries.push({
      label: 'Size',
      value: `${asset.width} × ${asset.height}`,
      mono: true,
    });
    entries.push({
      label: 'Steps · Guidance',
      value: `${advanced?.steps ?? '—'} · ${advanced?.guidance ?? '—'}`,
      mono: true,
    });
    entries.push({
      label: 'Sampler',
      value: advanced?.sampler ?? '—',
      mono: true,
    });
    if (asset.kind === 'video' && params.video) {
      entries.push({
        label: 'Length · FPS',
        value: `${params.video.lengthSeconds}s · ${params.video.fps}`,
        mono: true,
      });
    }
    entries.push({
      label: 'Rendered on',
      value:
        job.backendName === null && job.durationMs === null
          ? '—'
          : [
              job.backendName,
              job.durationMs === null ? null : renderTime(job.durationMs),
            ]
              .filter(Boolean)
              .join(' · '),
    });
    return entries;
  }, [advanced, asset.height, asset.kind, asset.width, job, params]);

  function prefill(mode: PrefillMode) {
    const payload = buildPrefill(mode, asset, job);
    if (payload) onPrefill(payload);
  }

  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Asset details"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <span className={styles.headTitle}>
            {asset.kind === 'video' ? 'Video' : 'Image'}
            <span className={`mono ${styles.headMeta}`}>
              {asset.width} × {asset.height}
            </span>
            {position && position.index >= 0 ? (
              <span
                className={`mono ${styles.headMeta}`}
                aria-label="Position in library"
              >
                {position.index + 1} of {position.total}
              </span>
            ) : null}
          </span>
          <div className={styles.headActions}>
            <button
              type="button"
              className={`${styles.iconButton} ${asset.starred ? styles.iconOn : ''}`}
              onClick={() => onToggleStar(asset)}
              aria-pressed={asset.starred}
              aria-label={asset.starred ? 'Unstar' : 'Star'}
              title={asset.starred ? 'Unstar' : 'Star'}
            >
              <StarIcon size={17} filled={asset.starred} />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => onDelete(asset)}
              aria-label="Delete"
              title="Delete"
            >
              <TrashIcon size={17} />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              onClick={onClose}
              aria-label="Close details"
              title="Close"
            >
              <CloseIcon size={17} />
            </button>
          </div>
        </header>

        <div className={styles.body}>
          <div className={styles.stage}>
            <div className={styles.preview}>
              {asset.kind === 'video' ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  key={asset.id}
                  className={`${styles.media} ${travel === 1 ? styles.fromRight : travel === -1 ? styles.fromLeft : ''}`}
                  src={asset.url}
                  poster={asset.thumbUrl}
                  controls
                  loop
                />
              ) : (
                <img
                  key={asset.id}
                  className={`${styles.media} ${travel === 1 ? styles.fromRight : travel === -1 ? styles.fromLeft : ''}`}
                  src={asset.url}
                  alt={asset.prompt ?? ''}
                />
              )}
              {onNavigate ? (
                <>
                  <button
                    type="button"
                    className={`${styles.arrow} ${styles.arrowPrev}`}
                    onClick={() => step(-1)}
                    disabled={!hasPrev}
                    aria-label="Previous"
                    title="Previous (←)"
                  >
                    <ChevronLeftIcon size={20} />
                  </button>
                  <button
                    type="button"
                    className={`${styles.arrow} ${styles.arrowNext}`}
                    onClick={() => step(1)}
                    disabled={!hasNext}
                    aria-label="Next"
                    title="Next (→)"
                  >
                    <ChevronRightIcon size={20} />
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <div className={styles.below}>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.action}
                onClick={() => void downloadAsset(asset)}
              >
                <DownloadIcon size={14} />
                Download
              </button>
              <button
                type="button"
                className={styles.action}
                onClick={() => prefill('remix')}
                disabled={!job}
                title={
                  job
                    ? 'Open in Create with these settings and a new seed'
                    : 'No job to remix'
                }
              >
                <RemixIcon size={14} />
                Remix
              </button>
              <button
                type="button"
                className={`${styles.action} ${styles.actionAccent}`}
                onClick={() => prefill('animate')}
                disabled={!job || asset.kind === 'video'}
                title={
                  asset.kind === 'video'
                    ? 'Already a video'
                    : 'Use this frame to start a video'
                }
              >
                <PlayIcon size={13} />
                Animate
              </button>
              <span className={styles.actionsGap} />
              <button
                type="button"
                className={styles.action}
                onClick={() => prefill('re-run')}
                disabled={!job}
                title={
                  job
                    ? 'Run these exact settings again, same seed'
                    : 'No job to re-run'
                }
              >
                <RemixIcon size={14} />
                Re-run
              </button>
              <div className={styles.menuAnchor}>
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  disabled={collections.length === 0}
                  title={
                    collections.length === 0
                      ? 'Make a collection in the sidebar first'
                      : 'Add to a collection'
                  }
                >
                  <FolderIcon size={14} />
                  Collections
                </button>

                {menuOpen ? (
                  <div className={styles.menu} role="menu">
                    {collections.map((collection) => {
                      const inIt = asset.collectionIds.includes(collection.id);
                      return (
                        <button
                          key={collection.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={inIt}
                          className={styles.menuItem}
                          onClick={async () => {
                            // Optimistic here too, for the same reason as the star:
                            // the tick has to move on the click.
                            const next = inIt
                              ? asset.collectionIds.filter(
                                  (id) => id !== collection.id,
                                )
                              : [...asset.collectionIds, collection.id];
                            onAssetPatched(asset.id, { collectionIds: next });
                            const ok = inIt
                              ? await onRemoveFromCollection(
                                  collection.id,
                                  asset.id,
                                )
                              : await onAddToCollection(
                                  collection.id,
                                  asset.id,
                                );
                            if (!ok)
                              onAssetPatched(asset.id, {
                                collectionIds: asset.collectionIds,
                              });
                          }}
                        >
                          <span className={styles.menuTick}>
                            {inIt ? <CheckIcon size={13} /> : null}
                          </span>
                          {collection.name}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>

            <div className={styles.columns}>
              <div className={styles.colMain}>
                {loading ? (
                  <p className={styles.note}>Loading details…</p>
                ) : null}

                {failed ? (
                  <p className={styles.note}>
                    Could not load this render's settings. The image itself is
                    fine.
                  </p>
                ) : null}

                {!loading && !failed && !job ? (
                  <p className={styles.note}>
                    The job behind this image is gone, so there are no settings
                    to show. Download still works.
                  </p>
                ) : null}

                {params ? (
                  <>
                    <section className={styles.field}>
                      <div className={styles.fieldHead}>
                        <span className="label">Prompt</span>
                        <CopyButton
                          id="prompt"
                          text={params.prompt}
                          clipboard={clipboard}
                          label="Copy prompt"
                        />
                      </div>
                      <p className={styles.prompt}>{params.prompt}</p>
                    </section>

                    {params.negativePrompt ? (
                      <section className={styles.field}>
                        <span className="label">Negative</span>
                        <p className={styles.negative}>
                          {params.negativePrompt}
                        </p>
                      </section>
                    ) : null}
                  </>
                ) : null}
              </div>

              {params ? (
                <div className={styles.colSide}>
                  <span className="label">Settings</span>
                  <dl className={styles.meta}>
                    {rows.map((row) => (
                      <div key={row.label} className={styles.metaRow}>
                        <dt className={styles.metaLabel}>{row.label}</dt>
                        <dd
                          className={`${styles.metaValue} ${row.mono ? 'mono' : ''}`}
                        >
                          {row.value}
                        </dd>
                      </div>
                    ))}

                    <div className={styles.metaRow}>
                      <dt className={styles.metaLabel}>Seed</dt>
                      <dd className={`mono ${styles.metaValue} ${styles.seed}`}>
                        {seed ?? '—'}
                        {seed !== null ? (
                          <CopyButton
                            id="seed"
                            text={String(seed)}
                            clipboard={clipboard}
                            label="Copy seed"
                          />
                        ) : null}
                      </dd>
                    </div>
                  </dl>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CopyButton({
  id,
  text,
  label,
  clipboard,
}: {
  id: string;
  text: string;
  label: string;
  clipboard: ReturnType<typeof useClipboard>;
}) {
  const active = clipboard.key === id;
  const copied = active && clipboard.state === 'copied';
  const failed = active && clipboard.state === 'failed';

  return (
    <button
      type="button"
      className={`${styles.copy} ${copied ? styles.copyOk : ''}`}
      onClick={() => void clipboard.copy(text, id)}
      aria-label={label}
      title={failed ? 'Copying is blocked in this browser' : label}
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      {/* A live region rather than only a colour change, so the confirmation
          reaches someone who is not looking at the button. */}
      <span role="status" className={styles.copyStatus}>
        {copied ? 'Copied' : failed ? 'Failed' : ''}
      </span>
    </button>
  );
}
