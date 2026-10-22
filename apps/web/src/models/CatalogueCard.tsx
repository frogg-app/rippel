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
import { useState, type CSSProperties, type ReactNode } from 'react';
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
import { cardTags, ownerOf, tagKey, type TagKey } from './discover';
import { needsLine } from './intents';
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
  const recommended = isRecommendedHere(entry) ? (
    <span
      className={styles.recommendedBadge}
      title={`On rippel's short list: ${recommendationFor(entry)!.label}`}
    >
      Recommended
    </span>
  ) : null;
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
  // The parts it is missing, by their plain names. The API's sentence names
  // the exact file; this is the line a person reads first.
  const needs = needsLine(entry);
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
        <span className={styles.verdictChip}>
          {entry.sourceWorkflow && verdict.status === 'no-workflow'
            ? 'Workflow setup needed'
            : RUNNABILITY_LABEL[verdict.status]}
        </span>
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
      {needs ? <p className={styles.cardNeeds}>{needs}</p> : null}
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
    </>
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
  onWorkflows,
  onOpen,
  onTag,
  activeTags,
}: CatalogueCardProps) {
  const live = install !== null && isLive(install);
  const done = isDone(entry, install);

  // A cached preview can still 404 — the row was written before someone
  // cleared the table, say. One failure per card, then the gradient.
  const [imageBroken, setImageBroken] = useState(false);
  const preview = imageBroken ? null : entry.info?.previewUrl ?? null;
  const info = entry.info;
  const tags = cardTags(entry);

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
    </>
  );

  const artClass = `${styles.cardArt} ${preview ? styles.cardArtPhoto : ''}`;
  const artStyle = preview ? undefined : artGradient(entry.base);

  return (
    <article
      className={`${styles.card} ${live ? styles.cardBusy : ''}`}
      style={{ '--i': index } as CSSProperties}
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
        {/* The badge sits beside the art rather than inside it: it explains
            itself on focus, and a button cannot be nested in a button. */}
        <TypeBadge type={entry.type} className={styles.cardTypeSlot} />
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardName} title={entry.name}>
            <OwnedName entry={entry} />
          </h3>
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
            {entry.size ? <span className="mono">{entry.size}</span> : null}
            {(entry.variants?.length ?? 0) > 1 && !entry.installBlockedReason ? (
              onOpen ? (
                <button
                  type="button"
                  className={styles.cardVersions}
                  onClick={() => onOpen(entry)}
                  title="Choose which version to install"
                >
                  {entry.variants!.length} versions
                </button>
              ) : (
                <span>{entry.variants!.length} versions</span>
              )
            ) : null}
          </p>
        </div>

        {tags.shown.length > 0 ? (
          <div className={styles.cardTags}>
            {tags.shown.map(({ group, value }) => {
              const key = tagKey(group, value);
              return (
                <TagChip
                  key={key}
                  group={group}
                  value={value}
                  on={activeTags?.has(key) ?? false}
                  onClick={onTag ? () => onTag(key) : undefined}
                />
              );
            })}
            {tags.more > 0 && onOpen ? (
              <button
                type="button"
                className={`${styles.tagChip} ${styles.tagChipGhost}`}
                onClick={() => onOpen(entry)}
                aria-label={`${tags.more} more tags on ${entry.name}`}
              >
                +{tags.more}
              </button>
            ) : null}
          </div>
        ) : null}

        <CardVerdict entry={entry} onWorkflows={onWorkflows} />

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
