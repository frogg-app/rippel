/**
 * One tag, HuggingFace-style: a small rounded chip with the group's glyph.
 *
 * Always a button when it has somewhere to go — every chip on a card, in the
 * drawer and in the autocomplete filters by itself, which is the whole point of
 * showing tags rather than a description. `on` marks a tag that is already an
 * active filter, so pressing it again visibly takes it off.
 *
 * Licences carry their group name ("Licence: apache-2.0") because the value on
 * its own — "other", "openrail" — does not say what kind of fact it is.
 */
import type { ModelTagGroup } from '@comfy/shared';
import { TAG_GROUP_ICON } from './discover';
import styles from './ModelsPanels.module.css';

export interface TagChipProps {
  group: ModelTagGroup;
  value: string;
  on?: boolean;
  /** Absent renders a static chip — the autocomplete row is the button there. */
  onClick?: () => void;
  size?: 'card' | 'drawer';
}

export function TagChip({ group, value, on = false, onClick, size = 'card' }: TagChipProps) {
  const className = [
    styles.tagChip,
    size === 'drawer' ? styles.tagChipLarge : '',
    group === 'task' ? styles.tagChipTask : '',
    on ? styles.tagChipOn : '',
  ].join(' ');

  const body = (
    <>
      {group === 'tag' ? null : (
        <span className={styles.tagChipIcon} aria-hidden>
          {TAG_GROUP_ICON[group]}
        </span>
      )}
      {group === 'license' ? <span className={styles.tagChipKey}>Licence:</span> : null}
      {value}
    </>
  );

  if (!onClick) return <span className={className}>{body}</span>;
  return (
    <button
      type="button"
      className={className}
      aria-pressed={on}
      onClick={onClick}
      title={on ? `Stop filtering by ${value}` : `Filter by ${value}`}
    >
      {body}
    </button>
  );
}
