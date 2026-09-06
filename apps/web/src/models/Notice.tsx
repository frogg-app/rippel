/**
 * The one component every empty, blocked and failed state on this screen uses.
 *
 * They are deliberately not styled differently from each other: "this backend
 * has no way to install models", "you are not an admin", "nothing matched" and
 * "the catalogue call failed" are all the same thing to a reader — a panel that
 * says what happened and, where there is one, what to do. Sharing the component
 * is what stops one of the four from quietly becoming a bare spinner.
 */
import type { ReactNode } from 'react';
import { WarningIcon } from './icons';
import styles from './ModelsPanels.module.css';

export interface NoticeProps {
  title: string;
  /** The API's own words where there are any — never paraphrase a 501. */
  message: ReactNode;
  tone?: 'plain' | 'warning' | 'danger';
  action?: { label: string; onClick: () => void };
  /** Rendered under the message: a filename, a URL, a transport detail. */
  footnote?: ReactNode;
}

export function Notice({ title, message, tone = 'plain', action, footnote }: NoticeProps) {
  return (
    <div
      className={`${styles.notice} rise ${tone === 'warning' ? styles.noticeWarning : ''} ${
        tone === 'danger' ? styles.noticeDanger : ''
      }`}
      role={tone === 'plain' ? undefined : 'alert'}
    >
      {tone === 'plain' ? null : (
        <span className={styles.noticeIcon}>
          <WarningIcon size={18} />
        </span>
      )}
      <h2 className={styles.noticeTitle}>{title}</h2>
      <p className={styles.noticeText}>{message}</p>
      {footnote ? <p className={styles.noticeFootnote}>{footnote}</p> : null}
      {action ? (
        <button type="button" className={styles.noticeAction} onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
