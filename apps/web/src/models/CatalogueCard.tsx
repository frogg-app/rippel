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
 * The art is **clickable**, and opens the detail drawer (CatalogueDrawer):
 * everything that used to crowd the card's lower half — the filename, where
 * rippel uses a support file, the licence, the model-page link, whose picture a
 * borrowed sample is — lives there now, beside the full tag row. The large
 * preview (PreviewLightbox) is one more click, from the drawer's own art: many
 * of these images are contact sheets, and the ~1600px rendition is still the
 * only way to see one properly.
 *
 * ## The tags
 *
 * `owner/name`, a stats row (likes, downloads, size) and at most five tag
 * chips — task, then base, then free tags — with a "+N" chip for the rest,
 * which opens the drawer. Every chip filters by itself. See `cardTags`.
 *
 * ## The verdict
 *
 * Every card says whether this file would actually run on the selected backend,
 * in the API's own words. That is the difference between a grid of 372 things
 * you may install and a grid of 372 things, 31 of which will work — and it is
 * the one thing that was missing before a seven-gigabyte download.
 *
 * The install states are unchanged, and are still the ones the API can
 * distinguish. They are `InstallControls`, shared with the drawer, so the two
 * can never disagree about what a click would do:
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
import { useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import type { ModelCatalogEntry, ModelInstall } from '@comfy/shared';
import {
  RUNNABILITY_TONE,
  SUPPORT_ROLES,
  familyHue,
  familyLabel,
  formatCount,
  generates,
  isLive,
} from './catalogue';
import { cardTags, ownerOf, tagKey, type TagKey } from './discover';
import { authorOf, filesLabel, fitOf, fullId, shortName, sizeBytesOf, type EntryGroup, type Fit } from './cardFacts';
import { UNLOADABLE_WORDS, unloadable, verdictLabel } from './intents';
import { useLayoutsWhenSeen } from './weightsLayouts';
import { NeedsPills } from './MissingParts';
import { isRecommendedHere, recommendationFor } from './recommended';
import { CheckIcon, DownloadCountIcon, HeartIcon, InstallIcon, WorkflowIcon } from './icons';
import { InstallProgress } from './InstallProgress';
import { TagChip } from './TagChip';
import { TypeBadge } from './TypeBadge';
import { Mark } from '../components/Mark';
import styles from './ModelsPanels.module.css';

export interface InstallControlsProps {
  entry: ModelCatalogEntry;
  /** The most recent install of this file on this backend, if any. */
  install: ModelInstall | null;
  starting: boolean;
  /** False when nothing can be installed here — an offline backend. */
  canInstall: boolean;
  onInstall: (entry: ModelCatalogEntry, variant?: string) => void;
  /** A refusal from the last attempt on this entry: a 400, a 409, a 502. */
  failure: string | null;
  now: number;
}

export interface CatalogueCardProps extends InstallControlsProps {
  /** Position in the grid, for the staggered entrance. */
  index?: number;
  /** Opens the templates browser filtered to this entry's family. */
  onWorkflows?: (entry: ModelCatalogEntry) => void;
  /** Opens the detail drawer. */
  onOpen?: (entry: ModelCatalogEntry) => void;
  /** Toggles a tag filter; every chip on the card is one. */
  onTag?: (key: TagKey) => void;
  /** Tag keys currently filtered on, so their chips read as pressed. */
  activeTags?: ReadonlySet<TagKey>;
  /** Every catalogue file from the same repo; the card shows `entry`. */
  group?: EntryGroup;
  /** The backend's graphics memory, for the fit pill. */
  memoryBytes?: number | null;
}

/** Installed, or complete even before the catalogue's own flag catches up. */
export function isDone(entry: ModelCatalogEntry, install: ModelInstall | null): boolean {
  return entry.installed || install?.status === 'complete';
}

/** The family gradient: the floor under every card with no picture. */
export function artGradient(base: string): CSSProperties {
  const hue = familyHue(base);
  return {
    // Two stops off one hue, in the artboard's radial treatment.
    background: `radial-gradient(120% 100% at 32% 24%, hsl(${hue} 62% 62%) 0%, hsl(${
      (hue + 28) % 360
    } 48% 28%) 55%, var(--ground-sunken) 100%)`,
  };
}

/** `owner/` in the muted ink, then the name. No owner off HuggingFace. */
export function OwnedName({ entry }: { entry: ModelCatalogEntry }) {
  const owner = ownerOf(entry);
  return (
    <>
      {owner ? <span className={styles.cardOrg}>{owner}/</span> : null}
      {entry.name}
    </>
  );
}

/**
 * The verdict line, as the card has always rendered it.
 *
 * A support file is never labelled "Support file" on its own, and never with
 * the bare type word: what it does to a model, in plain words. Where in rippel
 * it is used (`role.where`) is the drawer's to say; it passes it as children.
 */
export function CardVerdict({
  entry,
  onWorkflows,
  children,
}: {
  entry: ModelCatalogEntry;
  onWorkflows?: (entry: ModelCatalogEntry) => void;
  children?: ReactNode;
}) {
  const verdict = entry.runnability;
  // Recommended only where it will work: see recommended.ts. It is on the
  // verdict rather than the art so the card and the drawer both carry it.
  // Recommended is a star on the art now (RecommendedStar), not a row here.
  const recommended = null;
  // Derived from the type, not from the verdict: the verdict is per backend and
  // is absent when one is offline, and "what this file is for" is not a fact
  // about a backend.
  if (!generates(entry.type)) {
    const role = SUPPORT_ROLES[entry.type];
    return (
      <>
        {recommended}
        <p className={`${styles.verdict} ${styles.verdict_muted}`} title={`${role.what} ${role.where}`}>
          <span className={styles.verdictChip}>{role.noun}</span>
          <span className={styles.verdictText}>
            {role.what}
            {children}
          </span>
        </p>
      </>
    );
  }
  if (!verdict) return null;
  const needsParts = verdict.status === 'needs-companion' && verdict.missing.length > 0;
  return (
    <>
      {recommended}
      <p
        className={`${styles.verdict} ${styles[`verdict_${RUNNABILITY_TONE[verdict.status]}`]}`}
        // The detail is the API's sentence, and it names the missing file or
        // the folder. It is on the element rather than always visible
        // because it is a paragraph, not a label.
        title={verdict.detail ?? verdict.summary}
      >
        {/* A model found in a ComfyUI workflow has a graph waiting for it, so
          "no workflow" would be wrong: it needs that workflow set up. */}
        {needsParts ? (
          <NeedsPills verdict={verdict} />
        ) : (
          <span className={styles.verdictChip}>
            {entry.sourceWorkflow && verdict.status === 'no-workflow'
              ? 'Workflow setup needed'
              : verdictLabel(verdict)}
          </span>
        )}
        <span className={styles.verdictText}>
          {entry.sourceWorkflow && verdict.status === 'no-workflow'
            ? `${entry.sourceWorkflow.title} is available in the workflow library.`
            : (verdict.detail ?? verdict.summary)}
        </span>
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
    </>
  );
}

/** Progress, the install button, "Starting…", and a refusal: the states listed above. */
export function InstallControls({
  entry,
  install,
  starting,
  canInstall,
  onInstall,
  failure,
  now,
}: InstallControlsProps) {
  const live = install !== null && isLive(install);
  const done = isDone(entry, install);
  const retryable = install !== null && (install.status === 'failed' || install.status === 'cancelled');
  return (
    <>
      {install && !done ? <InstallProgress install={install} now={now} compact /> : null}

      {done ? (
        <p className={styles.cardResting}>Already on this backend</p>
      ) : entry.installBlockedReason ? (
        <p className={styles.cardResting}>{entry.installBlockedReason}</p>
      ) : live || starting ? null : unloadable(entry) ? (
        <span title={UNLOADABLE_WORDS.detail}>
          <button type="button" className={styles.installButton} disabled aria-label="Install (won’t run in ComfyUI)">
            <InstallIcon size={13} />
            Install
          </button>
        </span>
      ) : (
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
    </>
  );
}

/** The merged "size · fit" pill, shared by both tabs and the drawer. */
export function FitPill({ fit, className = '', ref }: { fit: Fit; className?: string; ref?: Ref<HTMLSpanElement> }) {
  return (
    <span ref={ref} className={`${styles.fitPill} ${styles[`fit_${fit.tone}`]} ${className}`} title={fit.detail}>
      {fit.label}
    </span>
  );
}

/** "Won't run in ComfyUI", with the reason in its tooltip. */
export function UnloadablePill() {
  return (
    <span className={`${styles.fitPill} ${styles.fit_bad}`} title={UNLOADABLE_WORDS.detail}>
      {UNLOADABLE_WORDS.pill}
    </span>
  );
}

/** Recommended, as a star in the art's corner rather than a row of its own. */
export function RecommendedStar({ entry }: { entry: ModelCatalogEntry }) {
  if (!isRecommendedHere(entry)) return null;
  const label = `Recommended: ${recommendationFor(entry)!.label}`;
  return (
    <span className={styles.recommendedStar} title={label} aria-label={label} role="img">
      ★
    </span>
  );
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
  onOpen,
  onTag,
  activeTags,
  group,
  memoryBytes = null,
}: CatalogueCardProps) {
  const live = install !== null && isLive(install);
  const members = group?.entries ?? [entry];
  const cardRef = useRef<HTMLElement>(null);
  useLayoutsWhenSeen(cardRef, members);
  const done = members.some((member) => isDone(member, member === entry ? install : null));

  // A cached preview can still 404 — the row was written before someone
  // cleared the table, say. One failure per card, then the gradient.
  const [imageBroken, setImageBroken] = useState(false);
  const preview = imageBroken ? null : (members.find((m) => m.info?.previewUrl)?.info?.previewUrl ?? null);
  const info = entry.info ?? members.find((m) => m.info)?.info ?? null;
  const title = shortName(entry);
  const author = authorOf(entry);
  const fit = fitOf(entry, sizeBytesOf(entry), memoryBytes, SUPPORT_ROLES[entry.type].noun);
  const files = group ? filesLabel(group) : (entry.variants?.length ?? 0) > 1 ? `${entry.variants!.length} versions` : null;
  // Task and family only; every other tag is the drawer's.
  const task = cardTags(entry).shown.find((tag) => tag.group === 'task');
  // Hugging Face discovery writes "Hugging Face" when it cannot tell, and a
  // base model's repo id ("Qwen/Qwen-Image-2.1") when it can.
  const family =
    entry.base && !['Unknown', 'Hugging Face'].includes(entry.base)
      ? familyLabel(entry.base.slice(entry.base.lastIndexOf('/') + 1))
      : null;

  const art = (
    <>
      {preview ? (
        <img
          className={styles.cardImage}
          src={preview}
          // Decorative: the model's name is right underneath it.
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
      {done ? (
        <span className={styles.cardInstalled}>
          <CheckIcon size={10} /> Installed
        </span>
      ) : null}
    </>
  );

  const artClass = `${styles.cardArt} ${preview ? styles.cardArtPhoto : ''}`;
  const artStyle = preview ? undefined : artGradient(entry.base);

  return (
    <article
      ref={cardRef}
      className={`${styles.card} ${live ? styles.cardBusy : ''}`}
      style={{ '--i': index } as CSSProperties}
      // The full id: unique where two short names are not.
      aria-label={entry.name}
    >
      <div className={styles.cardArtHolder}>
        {onOpen ? (
          <button
            type="button"
            className={`${artClass} ${styles.cardArtButton} ${styles.cardArtOpen}`}
            style={artStyle}
            onClick={() => onOpen(entry)}
            aria-label={`Details of ${entry.name}`}
          >
            {art}
          </button>
        ) : (
          <div className={artClass} style={artStyle}>
            {art}
          </div>
        )}
        <TypeBadge type={entry.type} className={styles.cardTypeSlot} />
        <RecommendedStar entry={entry} />
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle} title={fullId(entry)}>
            {title}
          </h3>
          {author ? <p className={styles.cardAuthor}>{author}</p> : null}
        </div>

        <div className={styles.cardFacts}>
          <FitPill fit={fit} />
          {unloadable(entry) ? <UnloadablePill /> : entry.runnability ? <NeedsPills verdict={entry.runnability} /> : null}
          {files ? (
            onOpen ? (
              <button
                type="button"
                className={styles.cardVersions}
                onClick={() => onOpen(entry)}
                title="Choose which file to install"
              >
                {files}
              </button>
            ) : (
              <span className={styles.cardVersions}>{files}</span>
            )
          ) : null}
        </div>

        <div className={styles.cardChips}>
          {task ? (
            <TagChip
              group="task"
              value={task.value}
              on={activeTags?.has(tagKey('task', task.value)) ?? false}
              onClick={onTag ? () => onTag(tagKey('task', task.value)) : undefined}
            />
          ) : null}
          {family ? <span className={`${styles.tagChip} ${styles.familyChip}`}>{family}</span> : null}
          <p className={styles.cardStats}>
            {info?.likes ? (
              <span title={`${info.likes.toLocaleString()} likes at the source`}>
                <HeartIcon size={11} />
                <span className="mono">{formatCount(info.likes)}</span>
              </span>
            ) : null}
            {info?.downloads ? (
              <span title={`${info.downloads.toLocaleString()} downloads at the source`}>
                <DownloadCountIcon size={11} />
                <span className="mono">{formatCount(info.downloads)}</span>
              </span>
            ) : null}
          </p>
        </div>

        <InstallControls
          entry={entry}
          install={install}
          starting={starting}
          canInstall={canInstall}
          onInstall={onInstall}
          failure={failure}
          now={now}
        />
      </div>
    </article>
  );
}
