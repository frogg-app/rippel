/**
 * "What's what?" — the legend for the words in `vocabulary.ts`.
 *
 * Closed by default: somebody who knows the words should not have to scroll
 * past a glossary on every visit, and somebody who does not needs to see that
 * one exists. A native `<details>` rather than a popover, so it works by
 * keyboard, by tap and with a screen reader without any of our code.
 *
 * `compact` is the Create page's form: a small link-sized summary that sits in
 * a group heading, opening into the same list beneath it.
 */
import { GROUPS, GROUP_ORDER, VOCABULARY } from './vocabulary';
import styles from './modelKinds.module.css';

export function ModelKinds({ compact = false }: { compact?: boolean }) {
  return (
    <details className={`${styles.kinds} ${compact ? styles.compact : ''}`}>
      <summary className={styles.summary}>What’s what?</summary>
      <dl className={styles.list}>
        {GROUP_ORDER.map((group) => {
          const words = GROUPS[group];
          return (
            <div key={group} className={styles.row}>
              <dt className={styles.title}>{words.title}</dt>
              <dd className={styles.blurb}>
                {words.blurb}
                <ul className={styles.types}>
                  {words.types.map((type) => (
                    <li key={type}>
                      <span className={styles.name}>{VOCABULARY[type].name}</span>{' '}
                      <span className={styles.expert}>{VOCABULARY[type].expert}</span>
                      <span className={styles.explain}> — {VOCABULARY[type].explain}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
