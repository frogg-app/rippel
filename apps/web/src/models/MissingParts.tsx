/**
 * What a "Needs prompt reader" badge opens: each missing part by name, the
 * file the workflow asked for, and a way to go and get it.
 *
 * "Find" searches Discover for the part rather than for the exact filename.
 * The catalogue lists repositories, and a repository's card carries one build
 * of a file, so `t5xxl_fp16` would miss the T5 repository that leads with fp8.
 * The stem without its precision suffix finds it, and the type filter is set
 * too, because Discover leaves parts out unless their type is chosen.
 */
import { createContext, useContext, useId, useState } from 'react';
import type { MissingCompanion, ModelType, RunnabilityStatus } from '@comfy/shared';
import { companionName, neededParts } from './intents';
import { ChevronIcon, LinkIcon, SearchIcon } from './icons';
import styles from './ModelsPanels.module.css';

export interface PartSearch {
  q: string;
  type: ModelType | null;
}

/** Set by the page that can run a search; without it, "Find" is not offered. */
export const FindPartContext = createContext<((search: PartSearch) => void) | null>(null);

/** The Discover search that turns up a missing part. */
export function partSearch(missing: MissingCompanion): PartSearch {
  const said = `${missing.purpose ?? ''} ${missing.filename} ${missing.loader}`.toLowerCase();
  const type: ModelType | null = /\bvae\b|vaeloader|\bae\.safetensors/.test(said)
    ? 'vae'
    : /t5|umt5|clip|text encoder|textencoder/.test(said)
      ? 'clip'
      : null;
  const stem = (missing.filename.split(/[\\/]/).pop() ?? missing.filename)
    .replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, '')
    // Precision and quantisation suffixes: other builds of the same part.
    .replace(/([_.-](fp16|fp32|fp8|bf16|e4m3fn|e5m2|scaled|q\d\w*|f16|f32))+$/i, '');
  return { q: stem, type };
}

export function MissingParts({ missing, id }: { missing: readonly MissingCompanion[]; id: string }) {
  const find = useContext(FindPartContext);
  return (
    <ul className={styles.missingParts} id={id} aria-label="What this model needs">
      {missing.map((part) => (
        <li key={`${part.loader}:${part.filename}`} className={styles.missingPart}>
          <span className={styles.missingPartName}>{companionName(part)}</span>
          <span className={`mono ${styles.missingPartFile}`}>{part.filename}</span>
          <span className={styles.missingPartActions}>
            {find ? (
              <button
                type="button"
                className={styles.missingPartFind}
                onClick={(event) => {
                  event.stopPropagation();
                  find(partSearch(part));
                }}
              >
                <SearchIcon size={11} />
                Find
              </button>
            ) : null}
            {part.source ? (
              <a
                className={styles.sourceLink}
                href={part.source.url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(event) => event.stopPropagation()}
              >
                Download <LinkIcon size={10} />
              </a>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Needs image decoder", "Needs prompt reader": one pill per part, each on one
 * line, each opening its own list of files with Find and Download.
 */
export function NeedsPills({ verdict }: { verdict: { status: RunnabilityStatus; missing?: MissingCompanion[] } }) {
  const pills = neededParts(verdict);
  if (pills.length === 0) return null;
  return (
    <div className={styles.needsRow}>
      {pills.map((pill) => (
        <NeedsPill key={pill.label} label={pill.label} missing={pill.missing} />
      ))}
    </div>
  );
}

function NeedsPill({ label, missing }: { label: string; missing: MissingCompanion[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className={styles.needsPillWrap}>
      <button
        type="button"
        className={styles.needsPill}
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((now) => !now);
        }}
      >
        {label}
        <ChevronIcon size={10} className={open ? styles.verdictChevronOpen : styles.verdictChevron} />
      </button>
      {open ? (
        <div className={styles.needsPopover}>
          <MissingParts missing={missing} id={id} />
        </div>
      ) : null}
    </span>
  );
}
