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
import { FixModel } from './FixModel';
import { useState, type CSSProperties } from 'react';
import type { Model, ModelCatalogInfo, ModelRunnability, Uuid } from '@comfy/shared';
import {
  SUPPORT_ROLES,
  familyHue,
  familyLabel,
  formatCount,
  generates,

} from './catalogue';
import { CloseIcon, DownloadCountIcon, ExpandIcon, WorkflowIcon } from './icons';
import { PreviewLightbox } from './PreviewLightbox';
import { TypeBadge } from './TypeBadge';
import { Mark } from '../components/Mark';
import { FitPill } from './CatalogueCard';
import { modelFit } from './cardFacts';
import { NeedsPills } from './MissingParts';
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
  onFixed?: () => void;
  /** Position in the grid, for the staggered entrance. */
  index?: number;
  /** The selected backend's graphics memory, for the fit pill. */
  memoryBytes?: number | null;
  /** Opens the side panel. */
  onOpen?: (model: Model) => void;
}

export function InstalledCard({
  model,
  verdict,
  info,
  backendOrder,
  selectedBackendId,
  onWorkflows,
  onRemove,
  onFixed,
  index = 0,
  memoryBytes = null,
  onOpen,
}: InstalledCardProps) {
  const fit = modelFit(model, isSupportType(model) ? null : verdict, memoryBytes, SUPPORT_ROLES[model.type].noun);
  // The model page's owner, when the file was matched to a catalogue row.
  const author = info?.referenceUrl ? /huggingface\.co\/([^/]+)\//i.exec(info.referenceUrl)?.[1] ?? null : null;
  const [imageBroken, setImageBroken] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  // `model.previewUrl` is whatever the source registry gave us at discovery,
  // which for a locally-found file is nothing; the matched catalogue picture is
  // the one that actually exists. Either is same-origin.
  const preview = imageBroken ? null : info?.previewUrl ?? model.previewUrl ?? null;
  const full = preview ? info?.previewFullUrl ?? null : null;

  const isSupport = !generates(model.type);
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
        {onOpen ? (
          // The side panel, as on Discover; the large preview is one more
          // click, from the panel's own art.
          <button
            type="button"
            className={`${artClass} ${styles.cardArtButton} ${styles.cardArtOpen}`}
            style={artStyle}
            onClick={() => onOpen(model)}
            aria-label={`Details of ${model.displayName}`}
          >
            {art}
          </button>
        ) : full ? (
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
          {/* The short name; the whole path, which may carry a Windows
              subfolder, is the hover. */}
          <h3 className={styles.cardTitle} title={model.filename}>
            {model.displayName}
          </h3>
          {author ? <p className={styles.cardAuthor}>{author}</p> : null}
        </div>

        <div className={styles.cardFacts}>
          <FitPill fit={fit} />
          {verdict && !isSupport ? <NeedsPills verdict={verdict} /> : null}
        </div>

        <div className={styles.cardChips}>
          <span className={`${styles.tagChip} ${styles.familyChip}`}>
            {familyLabel(model.baseModel ?? 'unclassified')}
          </span>
          {info?.downloads ? (
            <p className={styles.cardStats}>
              <span title={`${info.downloads.toLocaleString()} downloads at the source`}>
                <DownloadCountIcon size={11} />
                <span className="mono">{formatCount(info.downloads)}</span>
              </span>
            </p>
          ) : null}
        </div>


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

        {/* Licence and the model page are the side panel's now. */}

        {verdict && (verdict.status === 'wrong-folder' || (verdict.status === 'needs-companion' && verdict.missing.length > 0)) && verdict.backendId ? (
          onRemove ? <FixModel modelId={model.id} backendId={verdict.backendId} onDone={onFixed} /> : <p>Ask an admin to fix this.</p>
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
            {onRemove ? <RemoveButton model={model} machines={hosts} onRemove={onRemove} /> : null}
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
 * "Delete <name> from <machine>?" with a confirm, so a slip of the pointer over
 * a card cannot delete a file, and no browser dialog interrupts the page. It
 * names the machine because the file itself goes, not only rippel's record.
 */
export function RemoveButton({
  model,
  machines,
  onRemove,
}: {
  model: Model;
  machines: readonly { name: string }[];
  onRemove: (model: Model) => void;
}) {
  const [armed, setArmed] = useState(false);
  const where = machines.length > 0 ? machines.map((m) => m.name).join(' and ') : 'rippel';
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
    <span className={`${styles.rowConfirm} pop`} role="group" aria-label={`Delete ${model.displayName}?`}>
      <span className={styles.rowConfirmText} title={`Deletes ${model.filename} from disk. This cannot be undone.`}>
        Delete {model.displayName} from {where}?
      </span>
      <button
        type="button"
        className={`${styles.rowAction} ${styles.rowActionDanger}`}
        onClick={() => {
          setArmed(false);
          onRemove(model);
        }}
      >
        Delete
      </button>
      <button type="button" className={styles.rowAction} onClick={() => setArmed(false)}>
        Keep
      </button>
    </span>
  );
}

function isSupportType(model: Model): boolean {
  return !generates(model.type);
}
