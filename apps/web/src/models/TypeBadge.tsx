/**
 * The badge on a card's artwork, and the sentence behind it.
 *
 * The badge says what kind of file this is in plain words — "MODEL", "EXTRA
 * STYLE" — and the two-band split above it says which half of the screen that
 * puts it in. Neither answers the question somebody actually has when the
 * bands are not both on screen, which is *why* a LoRA is in the other band. So
 * the badge explains itself.
 *
 * It explains itself on **hover, focus and tap** rather than only on hover: a
 * `title` attribute reaches a mouse and nothing else, and the whole point of
 * these words is that they are for the person who does not already know what a
 * LoRA is — who is at least as likely to be on a tablet or a keyboard. So it is
 * a real button (focusable, in the tab order, announced), the sentence is a
 * live element referenced by `aria-describedby` so a screen reader reads it
 * with the badge, and a tap toggles it for a pointer that cannot hover.
 *
 * The sentences are `SUPPORT_ROLES` from catalogue.ts, unchanged — the same
 * text the band headings and the Workflows sheet use. Writing a second set for
 * a tooltip is how two descriptions of the same thing start to disagree.
 */
import { useId, useState } from 'react';
import type { ModelType } from '@comfy/shared';
import { SUPPORT_ROLES, TYPE_LABELS, generates } from './catalogue';
import styles from './ModelsPanels.module.css';

export interface TypeBadgeProps {
  type: ModelType;
  /** Extra class for the card that owns it — position is the card's business. */
  className?: string;
}

/** The whole explanation, in one sentence per half of the split. */
export function typeExplanation(type: ModelType): string {
  const role = SUPPORT_ROLES[type];
  return generates(type)
    ? `${role.what} ${role.where} Technically a ${TYPE_LABELS[type]}.`
    : `You cannot generate with this on its own. ${role.what} ${role.where} Technically a ${TYPE_LABELS[type]}.`;
}

export function TypeBadge({ type, className = '' }: TypeBadgeProps) {
  const [pinned, setPinned] = useState(false);
  const describedBy = useId();
  const role = SUPPORT_ROLES[type];
  const explanation = typeExplanation(type);

  return (
    <span className={`${styles.typeBadgeWrap} ${className}`}>
      <button
        type="button"
        className={`${styles.cardType} ${generates(type) ? '' : styles.cardTypeSupport}`}
        aria-describedby={describedBy}
        // The badge is a label that explains itself, not a control that does
        // something, so the click only reveals the sentence — which is the
        // whole of its behaviour on a touch screen.
        aria-expanded={pinned}
        onClick={() => setPinned((open) => !open)}
        onBlur={() => setPinned(false)}
      >
        {role.noun.toUpperCase()}
      </button>
      <span
        id={describedBy}
        role="tooltip"
        className={`${styles.typeTip} ${pinned ? styles.typeTipOn : ''}`}
      >
        {explanation}
      </span>
    </span>
  );
}
