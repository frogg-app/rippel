/**
 * What each backend actually holds.
 *
 * This was a dense text list while Discover — the tab you visit once, to shop —
 * was a grid of pictures, which had the two screens the wrong way round: this
 * is the one people open every day. It is now the same card design, at 320px
 * rather than 252px, because there are ten of these and not 372 and the extra
 * width is what lets a card carry the whole runnability sentence, the backend
 * chips and the actions instead of a truncated hint. See InstalledCard.
 *
 * The structure the list had is kept exactly:
 *
 *  - the two bands, generators over support files, each with its heading and
 *    its sentence;
 *  - inside a band, a section per type, so "which slot does this fill" is still
 *    answered by a heading; the family moved onto the card itself, where it can
 *    be read per model — see `groupInstalledByType`;
 *  - the plain-words explanation of a support type, once per type;
 *  - a chip per backend that holds the file, the selected one emphasised, and
 *    the ones with no backend at all still saying so.
 *
 * A model on two boxes is still one card with two chips, not two cards —
 * `/api/models` returns `backendIds` per model, and splitting them would make a
 * shared file look like two different files.
 */
import type { Model, ModelCatalogInfo, ModelRunnability, Uuid } from '@comfy/shared';
import {
  KIND_HEADINGS,
  SUPPORT_ROLES,
  TYPE_LABELS,
  generates,
  groupInstalledByType,
  splitByKind,
} from './catalogue';
import { InstalledCard } from './InstalledCard';
import styles from './ModelsPanels.module.css';

export interface InstalledListProps {
  models: Model[];
  /** Backends in registry order, for stable chip ordering. */
  backendOrder: { id: Uuid; name: string; online: boolean }[];
  /** The backend the rest of the screen is acting on; its chip is emphasised. */
  selectedBackendId: Uuid | null;
  /** Verdict per model id. Absent ids simply get no verdict shown. */
  runnability: Record<Uuid, ModelRunnability>;
  /**
   * Catalogue facts matched to an installed file by name: the cached picture,
   * the licence, the download count. Absent for a file no catalogue row names,
   * which falls back to the family art.
   */
  previews?: Record<Uuid, ModelCatalogInfo>;
  /** Opens the Workflows sheet for a model. */
  onWorkflows?: (model: Model) => void;
  /** Present for an administrator: the card offers a two-step Remove. */
  onRemove?: (model: Model) => void;
}

export function InstalledList({
  models,
  backendOrder,
  selectedBackendId,
  runnability,
  previews = {},
  onWorkflows,
  onRemove,
}: InstalledListProps) {
  const bands = splitByKind(groupInstalledByType(models), (group) => group.type);

  return (
    <div className={styles.bands}>
      {bands.map((band) => {
        const heading = KIND_HEADINGS[band.kind];
        // The plain-words sentence about a type belongs once per type, not once
        // per family: three SDXL LoRA groups do not need three copies of "a
        // style you add on top of a model".
        const seen = new Set<string>();
        return (
          <section
            key={band.kind}
            className={`${styles.band} ${band.kind === 'support' ? styles.bandSupport : ''}`}
            aria-label={heading.title}
          >
            <header className={styles.bandHead}>
              <h2 className={styles.bandTitle}>{heading.title}</h2>
              <span className={`mono ${styles.bandCount}`}>
                {band.items.reduce((total, group) => total + group.models.length, 0)}
              </span>
              <p className={styles.bandBlurb}>{heading.blurb}</p>
            </header>

            <div className={styles.groups}>
              {band.items.map((group) => {
                const role = SUPPORT_ROLES[group.type];
                const firstOfType = !seen.has(group.type);
                seen.add(group.type);
                return (
                  <section
                    key={group.key}
                    className={styles.group}
                    aria-label={TYPE_LABELS[group.type]}
                  >
                    <header className={styles.groupHead}>
                      <h3 className={styles.groupType}>
                        {generates(group.type) ? TYPE_LABELS[group.type] : role.noun}
                      </h3>
                      {!generates(group.type) ? (
                        <span
                          className={styles.groupJargon}
                          title={`Known technically as a ${TYPE_LABELS[group.type]}`}
                        >
                          {TYPE_LABELS[group.type]}
                        </span>
                      ) : null}
                      <span className={`mono ${styles.groupCount}`}>{group.models.length}</span>
                    </header>

                    {!generates(group.type) && firstOfType ? (
                      <p className={styles.groupRole}>
                        {role.what} <span className={styles.groupRoleWhere}>{role.where}</span>
                      </p>
                    ) : null}

                    <div className={styles.installedGrid}>
                      {group.models.map((model, index) => (
                        <InstalledCard
                          key={model.id}
                          index={Math.min(index, 12)}
                          model={model}
                          verdict={runnability[model.id] ?? null}
                          info={previews[model.id] ?? null}
                          backendOrder={backendOrder}
                          selectedBackendId={selectedBackendId}
                          onWorkflows={onWorkflows}
                          onRemove={onRemove}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
