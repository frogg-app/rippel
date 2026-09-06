/**
 * What each backend actually holds.
 *
 * The question this list exists to answer is "which machines have this", so
 * every row ends in a chip per backend that holds the file, with the ones the
 * selected backend is missing marked rather than hidden. A model on two boxes
 * is one row with two chips, not two rows — `/api/models` already returns
 * `backendIds` per model, and splitting them would make a shared file look like
 * two different files.
 *
 * Grouped by type first, family second: the type is which slot the file fills,
 * the family is what it is compatible with, and those are the two questions
 * asked before any other.
 */
import type { Model, Uuid } from '@comfy/shared';
import { TYPE_LABELS, basename, groupInstalled } from './catalogue';
import styles from './ModelsPanels.module.css';

export interface InstalledListProps {
  models: Model[];
  /** Backends in registry order, for stable chip ordering. */
  backendOrder: { id: Uuid; name: string; online: boolean }[];
  /** The backend the rest of the screen is acting on; its chip is emphasised. */
  selectedBackendId: Uuid | null;
}

export function InstalledList({ models, backendOrder, selectedBackendId }: InstalledListProps) {
  const groups = groupInstalled(models);

  return (
    <div className={styles.groups}>
      {groups.map((group) => (
        <section key={group.key} className={styles.group} aria-label={`${TYPE_LABELS[group.type]} · ${group.family}`}>
          <header className={styles.groupHead}>
            <h3 className={styles.groupType}>{TYPE_LABELS[group.type]}</h3>
            <span className={styles.groupFamily}>{group.family}</span>
            <span className={`mono ${styles.groupCount}`}>{group.models.length}</span>
          </header>

          <ul className={styles.rows}>
            {group.models.map((model) => (
              <li key={model.id} className={styles.row}>
                <div className={styles.rowText}>
                  <span className={styles.rowName}>{model.displayName}</span>
                  {/* The basename, because a filename may carry a subfolder —
                      including a Windows one, e.g. "SDXL\\sd_xl_base_1.0". */}
                  <span className={`mono ${styles.rowFile}`} title={model.filename}>
                    {basename(model.filename)}
                  </span>
                </div>
                <ul className={styles.hosts} aria-label="Backends holding this model">
                  {backendOrder
                    .filter((backend) => model.backendIds.includes(backend.id))
                    .map((backend) => (
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
                    // removed. Saying so beats an empty cell that reads as a
                    // rendering bug.
                    <li className={`${styles.host} ${styles.hostNone}`}>No backend</li>
                  ) : null}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
