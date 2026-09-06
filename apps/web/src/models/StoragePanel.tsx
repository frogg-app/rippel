/**
 * The Storage tab: what rippel has left on one ComfyUI machine's disk, by
 * folder and by person, with a way to clear it.
 *
 * Two facts shape the screen. Deleting here touches the ComfyUI disk only —
 * the library copy is elsewhere and untouched — so the confirmation says so,
 * and a row with a library asset links to it. And the listing depends on a
 * helper node the operator has to install, so the "not installed" state is a
 * set of instructions rather than an empty list.
 *
 * Selection is per folder: a checkbox on each row, "select all" per owner,
 * and one sticky bar that names what will go. The bar's button confirms in
 * place (press once to arm, again to remove) rather than opening a dialog.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Backend, BackendStorage, StorageFile, StorageFolder } from '@comfy/shared';
import { Mark } from '../components/Mark';
import { ApiRequestError } from '../lib/api';
import { ageLabel, formatBytes, type StorageApi } from '../lib/api-storage';
import { Notice } from './Notice';
import { TrashIcon } from '../library/icons';
import styles from './StoragePanel.module.css';

const HELPER_PATH = 'tools/comfyui-rippel-storage';

export function StoragePanel({ api, backend }: { api: StorageApi; backend: Backend }) {
  const [data, setData] = useState<BackendStorage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const next = await api.list(backend.id, signal);
        if (!signal?.aborted) setData(next);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Could not read the backend.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [api, backend.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // A failed removal is said once, then goes away on its own.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const remove = useCallback(
    async (folder: StorageFolder, paths: string[]) => {
      // Optimistic: the rows go now, and come back if the helper refuses.
      const before = data;
      setData((current) => {
        if (!current) return current;
        const group = current[folder];
        const gone = new Set(paths);
        const kept = group.files.filter((file) => !gone.has(file.path));
        return {
          ...current,
          [folder]: { files: kept, totalBytes: kept.reduce((sum, file) => sum + file.size, 0) },
        };
      });
      try {
        const result = await api.remove(backend.id, folder, paths);
        if (result.missing.length > 0) {
          setToast(
            `${result.missing.length} of those ${result.missing.length === 1 ? 'was' : 'were'} already gone.`,
          );
        }
      } catch (cause) {
        setData(before);
        setToast(
          cause instanceof ApiRequestError
            ? cause.message
            : 'Could not remove those files. The backend did not answer.',
        );
      }
    },
    [api, backend.id, data],
  );

  if (loading && !data) {
    return (
      <div className={styles.loading} role="status">
        <Mark size={22} ripple="loop" />
        Reading {backend.name}’s disk…
      </div>
    );
  }

  if (error) {
    return (
      <Notice
        tone="danger"
        title="Could not read the backend"
        message={error}
        action={{ label: 'Try again', onClick: () => void load() }}
      />
    );
  }

  if (!data) return null;

  if (data.helper !== 'ok') {
    return <HelperMissing state={data.helper} backend={backend} onRetry={() => void load()} />;
  }

  return (
    <div className={styles.panel}>
      <p className={styles.lede}>
        Files rippel has put on <strong>{backend.name}</strong>. Removing one clears it from that
        machine’s disk only — nothing in anyone’s library changes.
      </p>

      <FolderSection
        folder="input"
        title="Inputs"
        blurb="Starting images sent to the backend for img2img and video jobs."
        group={data.input}
        backend={backend}
        onRemove={(paths) => remove('input', paths)}
      />
      <FolderSection
        folder="output"
        title="Outputs"
        blurb="Renders as ComfyUI wrote them, before rippel copied them into the library."
        group={data.output}
        backend={backend}
        onRemove={(paths) => remove('output', paths)}
      />

      {toast ? (
        <div className={`${styles.toast} pop`} role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- a folder

interface OwnerGroup {
  key: string;
  label: string;
  sub: string | null;
  files: StorageFile[];
  bytes: number;
}

/** Files by person, biggest first; the untracked pile last whatever its size. */
function groupByOwner(files: StorageFile[]): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>();
  for (const file of files) {
    const key = file.owner?.id ?? '';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: file.owner ? (file.owner.displayName ?? file.owner.email) : 'Not tracked by rippel',
        sub: file.owner?.displayName ? file.owner.email : null,
        files: [],
        bytes: 0,
      };
      groups.set(key, group);
    }
    group.files.push(file);
    group.bytes += file.size;
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === '') return 1;
    if (b.key === '') return -1;
    return b.bytes - a.bytes;
  });
}

function FolderSection({
  folder,
  title,
  blurb,
  group,
  backend,
  onRemove,
}: {
  folder: StorageFolder;
  title: string;
  blurb: string;
  group: BackendStorage['input'];
  backend: Backend;
  onRemove: (paths: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const owners = useMemo(() => groupByOwner(group.files), [group.files]);
  const now = Date.now();

  // Rows that vanished (removed, or reloaded away) leave the selection too.
  useEffect(() => {
    setSelected((current) => {
      const present = new Set(group.files.map((file) => file.path));
      const next = new Set([...current].filter((path) => present.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [group.files]);

  // Arming times out: a button that stays red while you read something else
  // is a button you press by accident later.
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!armed) return;
    disarm.current = setTimeout(() => setArmed(false), 5000);
    return () => {
      if (disarm.current) clearTimeout(disarm.current);
    };
  }, [armed]);

  const selectedBytes = useMemo(
    () => group.files.filter((file) => selected.has(file.path)).reduce((sum, f) => sum + f.size, 0),
    [group.files, selected],
  );

  const toggle = (path: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleOwner = (owner: OwnerGroup) =>
    setSelected((current) => {
      const next = new Set(current);
      const all = owner.files.every((file) => next.has(file.path));
      for (const file of owner.files) {
        if (all) next.delete(file.path);
        else next.add(file.path);
      }
      return next;
    });

  const confirm = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy(true);
    const paths = [...selected];
    setSelected(new Set());
    await onRemove(paths);
    setBusy(false);
  };

  const count = selected.size;

  return (
    <section className={styles.section} aria-label={title}>
      <header className={styles.sectionHead}>
        <div className={styles.sectionTitle}>
          <h2 className={styles.sectionName}>{title}</h2>
          <span className={styles.sectionBlurb}>{blurb}</span>
        </div>
        <span className={`mono ${styles.sectionTotal}`}>
          {group.files.length} {group.files.length === 1 ? 'file' : 'files'} ·{' '}
          {formatBytes(group.totalBytes)}
        </span>
      </header>

      {group.files.length === 0 ? (
        <p className={styles.empty}>Nothing of rippel’s in this folder.</p>
      ) : (
        owners.map((owner, index) => {
          const allOn = owner.files.every((file) => selected.has(file.path));
          const someOn = !allOn && owner.files.some((file) => selected.has(file.path));
          return (
            <div
              key={owner.key || 'untracked'}
              className={`${styles.owner} rise`}
              style={{ '--i': index } as React.CSSProperties}
            >
              <div className={styles.ownerHead}>
                <label className={styles.ownerCheck}>
                  <input
                    type="checkbox"
                    checked={allOn}
                    ref={(el) => {
                      if (el) el.indeterminate = someOn;
                    }}
                    onChange={() => toggleOwner(owner)}
                    aria-label={`Select all of ${owner.label}’s ${title.toLowerCase()}`}
                  />
                  <span className={styles.checkBox} aria-hidden />
                </label>
                <span className={owner.key ? styles.ownerName : styles.ownerUntracked}>
                  {owner.label}
                </span>
                {owner.sub ? <span className={styles.ownerSub}>{owner.sub}</span> : null}
                <span className={`mono ${styles.ownerTotal}`}>
                  {owner.files.length} · {formatBytes(owner.bytes)}
                </span>
              </div>
              <ul className={styles.rows}>
                {owner.files.map((file) => {
                  const on = selected.has(file.path);
                  return (
                    <li key={file.path} className={on ? `${styles.row} ${styles.rowOn}` : styles.row}>
                      <label className={styles.rowCheck}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(file.path)}
                          aria-label={`Select ${file.path}`}
                        />
                        <span className={styles.checkBox} aria-hidden />
                      </label>
                      <span className={`mono ${styles.rowPath}`} title={file.path}>
                        {file.path}
                      </span>
                      {file.assetId ? (
                        <Link className={styles.rowLink} to="/library" title="This render is in the library">
                          in library
                        </Link>
                      ) : null}
                      <span className={styles.rowAge}>{ageLabel(file.modifiedAt, now)}</span>
                      <span className={`mono ${styles.rowSize}`}>{formatBytes(file.size)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}

      {count > 0 ? (
        <div className={`${styles.bar} pop`} role="region" aria-label={`${title} selection`}>
          <span className={styles.barText}>
            <strong>{count}</strong> {count === 1 ? 'file' : 'files'} selected ·{' '}
            <span className="mono">{formatBytes(selectedBytes)}</span>
          </span>
          <button type="button" className={styles.barClear} onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button
            type="button"
            className={armed ? `${styles.barRemove} ${styles.barArmed}` : styles.barRemove}
            disabled={busy}
            onClick={() => void confirm()}
            aria-label={
              armed
                ? `Confirm: remove ${count} ${count === 1 ? 'file' : 'files'} from ${backend.name}`
                : `Remove ${count} ${count === 1 ? 'file' : 'files'} from ${backend.name}`
            }
          >
            <TrashIcon size={14} />
            {armed
              ? `Really remove from ${backend.name}?`
              : `Remove ${count} ${count === 1 ? 'file' : 'files'} (${formatBytes(selectedBytes)}) from ${backend.name}`}
          </button>
          <span className={styles.barNote}>{folder === 'output' ? 'Library copies stay.' : 'Uploads in rippel stay.'}</span>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- no helper

function HelperMissing({
  state,
  backend,
  onRetry,
}: {
  state: Exclude<BackendStorage['helper'], 'ok'>;
  backend: Backend;
  onRetry: () => void;
}) {
  const headline =
    state === 'offline'
      ? `${backend.name} is not answering`
      : state === 'unauthorised'
        ? 'The storage helper is installed but the tokens do not match'
        : `The storage helper is not installed on ${backend.name}`;

  return (
    <div className={`${styles.helper} rise`}>
      <div className={styles.helperIcon}>
        <Mark size={30} />
      </div>
      <h2 className={styles.helperTitle}>{headline}</h2>
      <p className={styles.helperBody}>
        ComfyUI itself cannot list below the top of its input and output folders, or delete
        anything, so rippel reads the disk through a small helper node it ships with. It only ever
        touches rippel’s own <span className="mono">comfy-studio</span> folders.
      </p>
      {state === 'offline' ? (
        <p className={styles.helperBody}>
          Check the backend is up — the status pill at the top right — and try again.
        </p>
      ) : (
        <ol className={styles.steps}>
          <li>
            Copy <span className="mono">{HELPER_PATH}</span> from the rippel repository into{' '}
            <span className="mono">ComfyUI\custom_nodes\</span> on {backend.name}.
          </li>
          <li>
            Set <span className="mono">RIPPEL_STORAGE_TOKEN</span> to a long random value for the
            ComfyUI process, and restart ComfyUI.
          </li>
          <li>
            Set the same value as <span className="mono">COMFY_STORAGE_TOKEN</span> in rippel’s{' '}
            <span className="mono">.env</span>, and restart the rippel API.
          </li>
        </ol>
      )}
      <button type="button" className={styles.helperRetry} onClick={onRetry}>
        Check again
      </button>
    </div>
  );
}
