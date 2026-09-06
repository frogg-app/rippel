/**
 * The Downloads tab: installs on this backend, newest first.
 *
 * Deliberately shows finished and failed ones alongside the live ones. An
 * install that failed twenty minutes ago is the single most useful row on this
 * screen — it carries the transport's error, which is the only place the reason
 * appears — and a list that only showed what is running would throw it away the
 * moment it mattered.
 */
import type { ModelInstall, Uuid } from '@comfy/shared';
import { TYPE_LABELS } from './catalogue';
import { InstallProgress } from './InstallProgress';
import styles from './ModelsPanels.module.css';

export interface InstallsListProps {
  installs: ModelInstall[];
  backendName: (id: Uuid) => string;
  /** True when the list spans backends, so each row names its machine. */
  showBackend: boolean;
  now: number;
}

export function InstallsList({ installs, backendName, showBackend, now }: InstallsListProps) {
  return (
    <ul className={styles.installs}>
      {installs.map((install) => (
        <li key={install.id} className={styles.install}>
          <div className={styles.installHead}>
            <span className={styles.installType}>{TYPE_LABELS[install.type].toUpperCase()}</span>
            <span className={styles.installName}>{install.displayName}</span>
            <span className={styles.installBase}>{install.base}</span>
            {showBackend ? (
              <span className={styles.installBackend}>{backendName(install.backendId)}</span>
            ) : null}
          </div>

          <p className={`mono ${styles.installFile}`}>{install.filename}</p>

          <InstallProgress install={install} now={now} />

          {/* The source is shown because an operator pulling gigabytes onto
              their own machine is entitled to see where they come from. */}
          <p className={styles.installUrl} title={install.url}>
            {install.url}
          </p>
        </li>
      ))}
    </ul>
  );
}
