/**
 * One installed model, as a card.
 *
 * The Installed tab is the one people open most and it was the plainer of the
 * two: a dense text list, while Discover — which you visit once, to shop — got
 * pictures. This closes that gap, deliberately reusing Discover's card parts
 * rather than restating them, so the two tabs stay one design and the fallback
 * artwork (which is being reworked) only has to be changed in one place.
 *
 * ## The picture
 *
 * An installed model is a local file. rippel knows its filename, type and
 * family; it does **not** know which HuggingFace repo it came from, and a local
 * file has no reliable source URL, so there is nothing to go and fetch. What
 * there is instead is a join: the API matches the file's basename against the
 * backend's catalogue, and where a row matches, the picture, licence and
 * download count we already cached for that model page come free. On this box
 * that is 9 of the 10 installed models matched and 7 with a picture.
 *
 * The tenth — a Hunyuan Video checkpoint dropped in by hand — is the case that
 * matters, because it is the common one in the wild. It gets exactly what a
 * catalogue entry with no picture gets: the family gradient and the mark, from
 * the very same classes. Nothing about the card layout changes; it simply has
 * no photograph, like half of Discover.
 *
 * ## Bigger than a catalogue card
 *
 * There are ten of these, not 372, so the grid is wider (320px against 252px)
 * and the extra room is spent on the things the list used to state and the
 * catalogue card has no space for: the whole runnability sentence, which
 * machines hold the file, and the actions.
 */
import { useState, type CSSProperties } from 'react';
import type { Model, ModelCatalogInfo, ModelRunnability, Uuid } from '@comfy/shared';
import {
  RUNNABILITY_LABEL,
  RUNNABILITY_TONE,
  SUPPORT_ROLES,
  basename,
  familyHue,
  familyLabel,
  formatBytes,
  formatCount,
  generates,

} from './catalogue';
import { CloseIcon, DownloadCountIcon, ExpandIcon, LinkIcon, WorkflowIcon } from './icons';
import { PreviewLightbox } from './PreviewLightbox';
import { TypeBadge } from './TypeBadge';
import { Mark } from '../components/Mark';
import { ManualDownloads } from './ManualDownloads';
import styles from './ModelsPanels.module.css';

export interface InstalledCardProps {
  model: Model;
  /** The verdict for this model, when the API had one. */
  verdict: ModelRunnability | null;
  /** Catalogue facts matched by filename: picture, licence, downloads. */
  info: ModelCatalogInfo | null;
  backendOrder: { id: Uuid; name: string; online: boolean }[];
  selectedBackendId: Uuid | null;
  onWorkflows?: (model: Model) => void;
  onRemove?: (model: Model) => void;
  /** Position in the grid, for the staggered entrance. */
  index?: number;
}

export function InstalledCard({
  model,
  verdict,
  info,
  backendOrder,
  selectedBackendId,
  onWorkflows,
  onRemove,
  index = 0,
}: InstalledCardProps) {
  const [imageBroken, setImageBroken] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  // `model.previewUrl` is whatever the source registry gave us at discovery,
  // which for a locally-found file is nothing; the matched catalogue picture is
  // the one that actually exists. Either is same-origin.
  const preview = imageBroken ? null : info?.previewUrl ?? model.previewUrl ?? null;
  const full = preview ? info?.previewFullUrl ?? null : null;

  const isSupport = !generates(model.type);
  const role = SUPPORT_ROLES[model.type];
  const hue = familyHue(model.baseModel ?? model.type);
  const hosts = backendOrder.filter((backend) => model.backendIds.includes(backend.id));

  const art = (
    <>
      {preview ? (
        <img
          className={styles.cardImage}
          src={preview}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageBroken(true)}
        />
      ) : (
        <span className={styles.cardPlaceholder} aria-hidden>
          <Mark size={34} />
        </span>
      )}
      {full ? (
        <span className={styles.cardExpand} aria-hidden>
          <ExpandIcon size={13} />
        </span>
      ) : null}
    </>
  );

  // Identical to the catalogue card's, on purpose: one fallback treatment for
  // both tabs, so reworking it is one edit and not two.
  const artClass = `${styles.cardArt} ${preview ? styles.cardArtPhoto : ''}`;
  const artStyle = preview
    ? undefined
    : {
        background: `radial-gradient(120% 100% at 32% 24%, hsl(${hue} 62% 62%) 0%, hsl(${
          (hue + 28) % 360
        } 48% 28%) 55%, var(--ground-sunken) 100%)`,
      };

  return (
    <article
      className={`${styles.card} ${styles.installedCard}`}
      style={{ '--i': index } as CSSProperties}
      aria-label={model.displayName}
    >
      <div className={styles.cardArtHolder}>
        {full ? (
          <button
            type="button"
            className={`${artClass} ${styles.cardArtButton}`}
            onClick={() => setEnlarged(true)}
            aria-label={`See the full-size preview of ${model.displayName}`}
          >
            {art}
          </button>
        ) : (
          <div className={artClass} style={artStyle}>
            {art}
          </div>
        )}
        {/* Outside the art button: a badge that explains itself is focusable,
            and nesting a button inside a button is invalid. */}
        <TypeBadge type={model.type} className={styles.cardTypeSlot} />
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardName} title={model.displayName}>
            {model.displayName}
          </h3>
          <p className={styles.cardMeta}>
            {familyLabel(model.baseModel ?? 'unclassified')}
            {model.sizeBytes ? (
              <>
                {' '}
                &middot; <span className="mono">{formatBytes(model.sizeBytes)}</span>
              </>
            ) : null}
            {info?.downloads ? (
              <>
                {' '}
                &middot;{' '}
                <span
                  className={styles.cardDownloads}
                  title={`${info.downloads.toLocaleString()} downloads at the source`}
                >
                  <DownloadCountIcon size={11} />
                  <span className="mono">{formatCount(info.downloads)}</span>
                </span>
              </>
            ) : null}
          </p>
          {/* The basename, because a filename may carry a subfolder — including
              a Windows one, e.g. "SDXL\\sd_xl_base_1.0". The whole path is the
              tooltip, as it was in the list. */}
          <p className={`mono ${styles.cardFile}`} title={model.filename}>
            {basename(model.filename)}
          </p>
        </div>

        {isSupport ? (
          // The chip only. The section this card sits in already carries the
          // sentence once, and the badge on the artwork explains itself on
          // focus — printing "a style you add on top of a model" four times
          // down one row is noise, not emphasis.
          <p className={`${styles.verdict} ${styles.verdict_muted}`}>
            <span className={styles.verdictChip}>{role.noun}</span>
          </p>
        ) : verdict ? (
          // Both halves, unlike the old list, which showed only bad news. A
          // card has the room, and "Will run" is the thing somebody scanning
          // for something to generate with is actually looking for — the same
          // judgement Discover's cards already make.
          <p className={`${styles.verdict} ${styles[`verdict_${RUNNABILITY_TONE[verdict.status]}`]}`}>
            <span className={styles.verdictChip}>{RUNNABILITY_LABEL[verdict.status]}</span>
            <span className={styles.verdictText}>{verdict.detail ?? verdict.summary}</span>
          </p>
        ) : null}
        {!isSupport && verdict?.status === 'needs-companion' && verdict.missing.some((m) => m.source) ? (
          // Only when there is somewhere to send them. A bare filename is
          // already in the sentence above; repeating it adds nothing.
          <ManualDownloads missing={verdict.missing} />
        ) : null}

        <ul className={styles.hosts} aria-label="Backends holding this model">
          {hosts.map((backend) => (
            <li
              key={backend.id}
              className={`${styles.host} ${
                backend.id === selectedBackendId ? styles.hostSelected : ''
              } ${backend.online ? '' : styles.hostOffline}`}
            >
              {backend.name}
            </li>
          ))}
          {model.backendIds.length === 0 ? (
            // The API can hold a model row whose every backend has been
            // removed. Saying so beats an empty cell that reads as a bug.
            <li className={`${styles.host} ${styles.hostNone}`}>No backend</li>
          ) : null}
        </ul>

        {info?.license || info?.referenceUrl ? (
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
          </p>
        ) : null}

        {onWorkflows || onRemove ? (
          <div className={styles.cardActions}>
            {onWorkflows ? (
              <button
                type="button"
                className={styles.rowAction}
                onClick={() => onWorkflows(model)}
                aria-label={
                  generates(model.type)
                    ? `Workflows for ${model.displayName}`
                    : `What ${model.displayName} is for`
                }
              >
                <WorkflowIcon size={13} />
                {generates(model.type) ? 'Workflows' : 'What is this?'}
              </button>
            ) : null}
            {onRemove ? <RemoveButton model={model} onRemove={onRemove} /> : null}
          </div>
        ) : null}
      </div>

      {enlarged && full ? (
        <PreviewLightbox
          name={model.displayName}
          src={full}
          from={info?.previewFrom ?? null}
          borrowedFrom={info?.previewBorrowedFrom ?? null}
          onClose={() => setEnlarged(false)}
        />
      ) : null}
    </article>
  );
}

/**
 * Remove, in two steps and in place: the first press turns the button into
 * "Remove from rippel?" with a confirm, so a slip of the pointer over a card
 * cannot drop a model, and no browser dialog interrupts the page.
 */
function RemoveButton({ model, onRemove }: { model: Model; onRemove: (model: Model) => void }) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button
        type="button"
        className={`${styles.rowAction} ${styles.rowActionQuiet}`}
        onClick={() => setArmed(true)}
        aria-label={`Remove ${model.displayName}`}
      >
        <CloseIcon size={12} />
        Remove
      </button>
    );
  }
  return (
    <span className={`${styles.rowConfirm} pop`} role="group" aria-label={`Remove ${model.displayName}?`}>
      <span className={styles.rowConfirmText}>Remove from rippel?</span>
      <button
        type="button"
        className={`${styles.rowAction} ${styles.rowActionDanger}`}
        onClick={() => {
          setArmed(false);
          onRemove(model);
        }}
      >
        Confirm
      </button>
      <button type="button" className={styles.rowAction} onClick={() => setArmed(false)}>
        Keep
      </button>
    </span>
  );
}
