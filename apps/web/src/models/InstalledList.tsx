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
 *
 * A row also says whether the file can actually be *used*. "Installed" and
 * "usable" are different claims and this list was only making the first: the
 * two video checkpoints on the box have sat here looking available for weeks
 * while every job against them failed, because their text encoder was never
 * downloaded. A row that cannot run now says so, in the API's words, and a row
 * that can says nothing — the absence of bad news is the common case and does
 * not need a badge of its own.
 */
import { useState } from 'react';
import type { Model, ModelRunnability, Uuid } from '@comfy/shared';
import { CloseIcon, WorkflowIcon } from './icons';
import {
  RUNNABILITY_LABEL,
  RUNNABILITY_TONE,
  TYPE_LABELS,
  basename,
  groupInstalled,
  runs,
} from './catalogue';
import styles from './ModelsPanels.module.css';

export interface InstalledListProps {
  models: Model[];
  /** Backends in registry order, for stable chip ordering. */
  backendOrder: { id: Uuid; name: string; online: boolean }[];
  /** The backend the rest of the screen is acting on; its chip is emphasised. */
  selectedBackendId: Uuid | null;
  /** Verdict per model id. Absent ids simply get no verdict shown. */
  runnability: Record<Uuid, ModelRunnability>;
  /** Opens the Workflows sheet for a model. */
  onWorkflows?: (model: Model) => void;
  /** Present for an administrator: the row offers a two-step Remove. */
  onRemove?: (model: Model) => void;
}

export function InstalledList({
  models,
  backendOrder,
  selectedBackendId,
  runnability,
  onWorkflows,
  onRemove,
}: InstalledListProps) {
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
                  <RowVerdict verdict={runnability[model.id] ?? null} />
                </div>
                {onWorkflows || onRemove ? (
                  <div className={styles.rowActions}>
                    {onWorkflows ? (
                      <button
                        type="button"
                        className={styles.rowAction}
                        onClick={() => onWorkflows(model)}
                        aria-label={`Workflows for ${model.displayName}`}
                      >
                        <WorkflowIcon size={13} />
                        Workflows
                      </button>
                    ) : null}
                    {onRemove ? <RemoveButton model={model} onRemove={onRemove} /> : null}
                  </div>
                ) : null}
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

/**
 * Remove, in two steps and in place: the first press turns the button into
 * "Remove from rippel?" with a confirm, so a slip of the pointer over a row
 * cannot drop a model, and no browser dialog interrupts the page.
 */
function RemoveButton({ model, onRemove }: { model: Model; onRemove: (model: Model) => void }) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button
        type="button"
        className={`${styles.rowAction} ${styles.rowActionQuiet}`}
        onClick={() => setArmed(true)}
        aria-label={`Remove ${model.displayName}`}
      >
        <CloseIcon size={12} />
        Remove
      </button>
    );
  }
  return (
    <span className={`${styles.rowConfirm} pop`} role="group" aria-label={`Remove ${model.displayName}?`}>
      <span className={styles.rowConfirmText}>Remove from rippel?</span>
      <button
        type="button"
        className={`${styles.rowAction} ${styles.rowActionDanger}`}
        onClick={() => {
          setArmed(false);
          onRemove(model);
        }}
      >
        Confirm
      </button>
      <button type="button" className={styles.rowAction} onClick={() => setArmed(false)}>
        Keep
      </button>
    </span>
  );
}

/**
 * The bad news, when there is any.
 *
 * Silent for a model that runs and for a support file: neither is a problem,
 * and a badge on every row would leave the two that matter nowhere to stand
 * out. The text is the API's whole sentence, because it names the file to
 * download or the folder to move — a badge alone would be an accusation with
 * no remedy.
 */
function RowVerdict({ verdict }: { verdict: ModelRunnability | null }) {
  if (!verdict || runs(verdict.status) || verdict.status === 'support') return null;
  return (
    <span className={`${styles.rowVerdict} ${styles[`verdict_${RUNNABILITY_TONE[verdict.status]}`]}`}>
      <span className={styles.verdictChip}>{RUNNABILITY_LABEL[verdict.status]}</span>
      <span className={styles.rowVerdictText}>{verdict.detail ?? verdict.summary}</span>
    </span>
  );
}
