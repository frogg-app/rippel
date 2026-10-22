/**
 * One installed file in full: the same side panel Discover opens, for a file
 * that is already on a machine.
 *
 * Its source is found by `installedSource`: exactly, from the download URL of
 * an install rippel made, or by filename, from the catalogue match the API
 * already makes for the card's picture. A file neither finds (a checkpoint
 * dropped in by hand) still gets the panel, with its local facts and a plain
 * "No source info" note rather than an empty space where a description goes.
 *
 * The Installed tab's own actions live here too: the machines holding it,
 * Workflows, Fix, and Remove.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Model, ModelCatalogInfo, ModelRunnability, Uuid } from '@comfy/shared';
import { SUPPORT_ROLES, basename, familyLabel, formatBytes, generates } from './catalogue';
import { drawerFit, fitOf, installedSource, type InstalledSource } from './cardFacts';
import { DRAWER_TAG_ORDER, tagKey } from './discover';
import { artGradient } from './CatalogueCard';
import { FitFact } from './FitFact';
import { RemoveButton } from './InstalledCard';
import { FixModel } from './FixModel';
import { NeedsPills } from './MissingParts';
import { PreviewLightbox } from './PreviewLightbox';
import { TagChip } from './TagChip';
import { CloseIcon, ExpandIcon, HeartIcon, WorkflowIcon } from './icons';
import { expertFor } from './vocabulary';
import styles from './ModelsPanels.module.css';

export interface InstalledDrawerProps {
  model: Model;
  verdict: ModelRunnability | null;
  info: ModelCatalogInfo | null;
  /** Precomputed by the list, which has the installs; see `installedSource`. */
  source?: InstalledSource;
  backendOrder: { id: Uuid; name: string; online: boolean }[];
  selectedBackendId: Uuid | null;
  memoryBytes: number | null;
  onClose: () => void;
  onWorkflows?: (model: Model) => void;
  onRemove?: (model: Model) => void;
  onFixed?: () => void;
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function InstalledDrawer({
  model,
  verdict,
  info: matchedInfo,
  source = installedSource(model, matchedInfo),
  backendOrder,
  selectedBackendId,
  memoryBytes,
  onClose,
  onWorkflows,
  onRemove,
  onFixed,
}: InstalledDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreTo = useRef<Element | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);

  // The filename match's facts belong to the install's repo only when the two
  // agree; an exact source that disagrees keeps its link and drops the rest.
  const info =
    matchedInfo && (source.how !== 'install' || sameRepo(matchedInfo.referenceUrl, source.url)) ? matchedInfo : null;
  const repo = source.url ? /huggingface\.co\/([^/]+)\/([^/?#]+)/i.exec(source.url) : null;
  const preview = imageBroken ? null : info?.previewUrl ?? model.previewUrl ?? null;
  const full = preview ? info?.previewFullUrl ?? null : null;
  const isSupport = !generates(model.type);
  const role = SUPPORT_ROLES[model.type];
  const fit = fitOf({ type: model.type, runnability: isSupport ? null : verdict }, model.sizeBytes, memoryBytes, role.noun);
  const hosts = backendOrder.filter((backend) => model.backendIds.includes(backend.id));
  const tags = info?.tags;

  useEffect(() => {
    restoreTo.current = document.activeElement;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (restoreTo.current instanceof HTMLElement && restoreTo.current.isConnected) restoreTo.current.focus();
    };
  }, []);

  useEffect(() => {
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
        <img className={styles.cardImage} src={preview} alt="" decoding="async" onError={() => setImageBroken(true)} />
      ) : null}
      <span className={styles.drawerType} title={expertFor(model.type, model.filename)}>
        {role.noun}
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
      <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label={`Details of ${model.displayName}`}>
        <button ref={closeRef} type="button" className={styles.drawerClose} onClick={onClose} aria-label="Close the details">
          <CloseIcon size={16} />
        </button>

        {full ? (
          <button
            type="button"
            className={`${styles.drawerArt} ${styles.drawerArtButton}`}
            onClick={() => setEnlarged(true)}
            aria-label={`See the full-size preview of ${model.displayName}`}
          >
            {artInner}
          </button>
        ) : (
          <div className={styles.drawerArt} style={preview ? undefined : artGradient(model.baseModel ?? model.type)}>
            {artInner}
          </div>
        )}

        <div className={styles.drawerBody}>
          <header className={styles.drawerHead}>
            <div className={styles.drawerTitle}>
              <h2 className={styles.drawerName} title={model.filename}>
                {model.displayName}
              </h2>
              {source.url ? (
                <a className={styles.hfLink} href={source.url} target="_blank" rel="noreferrer noopener">
                  View on Hugging Face <span aria-hidden>↗</span>
                </a>
              ) : null}
            </div>
            {repo ? (
              <p className={styles.drawerAuthor}>
                {repo[1]} / {repo[2]}
                {source.how === 'filename' ? ' · matched by filename' : ' · installed through rippel'}
              </p>
            ) : null}
          </header>

          <dl className={styles.factsGrid}>
            <Fact label="Size" value={model.sizeBytes ? formatBytes(model.sizeBytes) : null} />
            {isSupport ? null : <FitFact fit={drawerFit(fit, model.sizeBytes)} />}
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
            <Fact label="Type" value={role.noun} />
            <Fact label="Family" value={familyLabel(model.baseModel ?? 'unclassified')} />
          </dl>

          <ul className={styles.hosts} aria-label="Backends holding this model">
            {hosts.map((backend) => (
              <li
                key={backend.id}
                className={`${styles.host} ${backend.id === selectedBackendId ? styles.hostSelected : ''} ${
                  backend.online ? '' : styles.hostOffline
                }`}
              >
                {backend.name}
              </li>
            ))}
            {model.backendIds.length === 0 ? <li className={`${styles.host} ${styles.hostNone}`}>No backend</li> : null}
          </ul>

          {isSupport ? (
            <p className={styles.drawerDescription}>
              {role.what} {role.where}
            </p>
          ) : verdict ? (
            <div className={styles.verdict}>
              <NeedsPills verdict={verdict} />
              <span className={styles.verdictText}>{verdict.detail ?? verdict.summary}</span>
            </div>
          ) : null}

          {verdict &&
          (verdict.status === 'wrong-folder' || (verdict.status === 'needs-companion' && verdict.missing.length > 0)) &&
          verdict.backendId ? (
            onRemove ? (
              <FixModel modelId={model.id} backendId={verdict.backendId} onDone={onFixed} />
            ) : (
              <p className={styles.drawerNote}>Ask an admin to fix this.</p>
            )
          ) : null}

          {onWorkflows || onRemove ? (
            <div className={styles.cardActions}>
              {onWorkflows ? (
                <button type="button" className={styles.rowAction} onClick={() => onWorkflows(model)}>
                  <WorkflowIcon size={13} />
                  {generates(model.type) ? 'Workflows' : 'What is this?'}
                </button>
              ) : null}
              {onRemove ? <RemoveButton model={model} onRemove={onRemove} /> : null}
            </div>
          ) : null}

          {info?.description ? (
            <p className={styles.drawerDescription}>{info.description}</p>
          ) : !info ? (
            <p className={styles.drawerNote}>
              {source.url
                ? 'No source info cached for this repo yet.'
                : 'No source info. This file was not installed through rippel and matches nothing in the catalogue.'}
            </p>
          ) : null}
          {info?.baseModels?.length ? <p className={styles.drawerNote}>Built on {info.baseModels.join(', ')}.</p> : null}

          <dl className={`${styles.drawerFacts} ${styles.drawerFactsQuiet}`}>
            <dt>File</dt>
            <dd className="mono" title={model.filename}>
              {basename(model.filename)}
            </dd>
            <dt>Path</dt>
            <dd className="mono" title={model.filename}>
              {model.filename}
            </dd>
            {info?.previewBorrowedFrom && preview ? (
              <>
                <dt>Picture</dt>
                <dd className={styles.borrowed}>sample from {info.previewBorrowedFrom}</dd>
              </>
            ) : null}
          </dl>

          {tags && DRAWER_TAG_ORDER.some((group) => tags[group].length > 0) ? (
            <div className={styles.drawerTags} role="group" aria-label="Tags">
              {DRAWER_TAG_ORDER.flatMap((group) =>
                tags[group].map((value) => <TagChip key={tagKey(group, value)} group={group} value={value} size="drawer" />),
              )}
            </div>
          ) : null}
        </div>
      </aside>

      {enlarged && full ? (
        <PreviewLightbox
          name={model.displayName}
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

function sameRepo(a: string | null, b: string | null): boolean {
  const key = (url: string | null) => /huggingface\.co\/([^/]+\/[^/?#]+)/i.exec(url ?? '')?.[1]?.toLowerCase() ?? null;
  return key(a) !== null && key(a) === key(b);
}
