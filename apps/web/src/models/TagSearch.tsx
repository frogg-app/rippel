/**
 * The Discover search box: free text plus tag tokens, with autocomplete.
 *
 * Two things share one input, and the rule that keeps them apart is the one in
 * `parseToken`: a bare word is a **name search**, live on every keystroke as it
 * always was; a word with a group prefix (`task:`, `base:`, `licence:`, `tag:`)
 * or a leading `-` is a **tag**, and becomes a token when it is committed —
 * by picking it from the list, or by Enter. Committed tokens sit in front of
 * the text as chips, includes in the accent and excludes in the danger tint.
 *
 * Keys, as in the mockup:
 *
 *   ArrowUp/Down   move through the suggestions
 *   Enter          take the highlighted suggestion; with none, turn every
 *                  tag-shaped word typed so far into a token. A bare word
 *                  starts with nothing highlighted, so Enter keeps it the
 *                  name search it already is rather than picking the top
 *                  suggestion; a tag-shaped word starts on its best match
 *   Escape         close the suggestions, keep the text
 *   Backspace      on an empty box, remove the last token (excludes first,
 *                  since they are the ones drawn last)
 *
 * It is an ARIA combobox — input, listbox, active descendant — because that is
 * what a screen reader already knows how to drive; focus never leaves the
 * input, so typing straight on after a pick works.
 */
import { useId, useMemo, useState } from 'react';
import type { ModelTagGroup } from '@comfy/shared';
import {
  TAG_GROUP_LABEL,
  parseSearch,
  splitKey,
  suggestTags,
  type TagKey,
  type TagSuggestion,
} from './discover';
import { SearchIcon } from './icons';
import { TagChip } from './TagChip';
import styles from './ModelsPanels.module.css';

export interface TagSearchProps {
  q: string;
  onQ: (q: string) => void;
  include: readonly TagKey[];
  exclude: readonly TagKey[];
  /** Commit tags. The caller also gets the text that is left in the box. */
  onCommit: (tags: { include: TagKey[]; exclude: TagKey[] }, rest: string) => void;
  onRemove: (key: TagKey, negate: boolean) => void;
  /** Every key in the catalogue, for the suggestions. */
  known: ReadonlySet<TagKey>;
  /** Facet counts under the current filter, to rank and label suggestions. */
  counts: ReadonlyMap<TagKey, number>;
  resolve: (value: string) => ModelTagGroup | null;
  label: string;
  placeholder: string;
}

export function TagSearch({
  q,
  onQ,
  include,
  exclude,
  onCommit,
  onRemove,
  known,
  counts,
  resolve,
  label,
  placeholder,
}: TagSearchProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  // -1 is "nothing highlighted".
  const [highlight, setHighlight] = useState(-1);

  // The word under the cursor is the last one; earlier words are either text
  // or tags waiting for Enter.
  const words = q.split(/\s+/);
  const word = words[words.length - 1] ?? '';
  const before = words.slice(0, -1).join(' ');

  const suggestions = useMemo(
    () => suggestTags(word, known, counts, [...include, ...exclude]),
    [word, known, counts, include, exclude],
  );
  const showList = open && suggestions.length > 0;

  function pick(suggestion: TagSuggestion) {
    onCommit(
      suggestion.negate
        ? { include: [], exclude: [suggestion.key] }
        : { include: [suggestion.key], exclude: [] },
      before,
    );
    setHighlight(-1);
    setOpen(false);
  }

  function commitTyped() {
    const parsed = parseSearch(q, resolve);
    if (parsed.include.length || parsed.exclude.length) {
      onCommit({ include: parsed.include, exclude: parsed.exclude }, parsed.text);
    }
    setOpen(false);
  }

  const tokens = [
    ...include.map((key) => ({ key, negate: false })),
    ...exclude.map((key) => ({ key, negate: true })),
  ];

  return (
    <div className={styles.tagSearch}>
      <SearchIcon size={16} className={styles.searchIcon} />
      {tokens.map(({ key, negate }) => {
        const { group, value } = splitKey(key);
        return (
          <span key={`${negate ? '-' : ''}${key}`} className={`${styles.token} ${negate ? styles.tokenNeg : ''}`}>
            <span className={styles.tokenKey}>
              {negate ? '−' : ''}
              {group}:
            </span>
            {value}
            <button
              type="button"
              className={styles.tokenRemove}
              onClick={() => onRemove(key, negate)}
              aria-label={`Remove ${negate ? 'exclusion ' : ''}${group} ${value}`}
            >
              ×
            </button>
          </span>
        );
      })}
      <input
        className={styles.tagSearchInput}
        type="search"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${listId}-${highlight}` : undefined}
        autoComplete="off"
        value={q}
        placeholder={tokens.length ? '' : placeholder}
        onChange={(event) => {
          onQ(event.target.value);
          const typed = event.target.value.split(/\s+/).pop() ?? '';
          setHighlight(typed.startsWith('-') || typed.includes(':') ? 0 : -1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Closing on blur would swallow a click on a suggestion; each row
        // prevents the blur on mousedown instead, so this only fires for a
        // click genuinely elsewhere.
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!suggestions.length) return;
            event.preventDefault();
            setOpen(true);
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setHighlight((current) =>
              current < 0
                ? step > 0 ? 0 : suggestions.length - 1
                : (current + step + suggestions.length) % suggestions.length,
            );
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const chosen = showList && highlight >= 0 ? suggestions[highlight] : undefined;
            if (chosen) pick(chosen);
            else commitTyped();
          } else if (event.key === 'Escape') {
            setOpen(false);
          } else if (event.key === 'Backspace' && q === '' && tokens.length > 0) {
            event.preventDefault();
            const last = tokens[tokens.length - 1]!;
            onRemove(last.key, last.negate);
          }
        }}
      />
      {showList ? (
        <ul className={styles.suggest} id={listId} role="listbox" aria-label="Matching tags">
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              className={`${styles.suggestRow} ${index === highlight ? styles.suggestRowOn : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => pick(suggestion)}
            >
              <span className={styles.suggestGroup}>
                {suggestion.negate ? 'exclude ' : ''}
                {TAG_GROUP_LABEL[suggestion.group]}
              </span>
              <TagChip group={suggestion.group} value={suggestion.value} />
              <span className={`mono ${styles.suggestCount}`}>{suggestion.count}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
