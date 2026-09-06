import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Backend, BackendInput, BackendProbe, Uuid } from '@comfy/shared';
import { CloseIcon } from '../library/icons';
import { CubeIcon, PlusIcon } from '../components/icons';
import { Mark } from '../components/Mark';
import { gb } from '../lib/format';
import { ApiRequestError } from '../lib/api';
import { backendsApi as defaultApi, type BackendsApi } from '../lib/api-backends';
import { refreshBackends } from '../shell/useBackends';
import styles from './SettingsModal.module.css';

/**
 * Settings, for administrators. A centred glass sheet with a section rail on
 * the left; today the sections are Backends and About, and the rail is where
 * the next ones go.
 *
 * Backends is the reason it exists: until now the fleet came from an env
 * variable and a restart. Everything here talks to `api-backends.ts`, and
 * after any change asks the shell's pill to re-read.
 */

type Section = 'backends' | 'about';

export function SettingsModal({
  open,
  onClose,
  api = defaultApi,
  version = __APP_VERSION__,
}: {
  open: boolean;
  onClose: () => void;
  api?: BackendsApi;
  version?: string;
}) {
  const [section, setSection] = useState<Section>('backends');
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Focus lands inside the sheet, on the first section button.
    sheet.current?.querySelector<HTMLElement>('button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={sheet}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <aside className={styles.railCol}>
          <div className={styles.railHead}>Settings</div>
          <nav className={styles.sections} aria-label="Settings sections">
            <button
              type="button"
              className={section === 'backends' ? `${styles.sectionTab} ${styles.sectionOn}` : styles.sectionTab}
              aria-current={section === 'backends' ? 'page' : undefined}
              onClick={() => setSection('backends')}
            >
              <CubeIcon size={15} />
              Backends
            </button>
            <button
              type="button"
              className={section === 'about' ? `${styles.sectionTab} ${styles.sectionOn}` : styles.sectionTab}
              aria-current={section === 'about' ? 'page' : undefined}
              onClick={() => setSection('about')}
            >
              <Mark size={13} />
              About
            </button>
          </nav>
        </aside>

        <div className={styles.pane}>
          <header className={styles.paneHead}>
            <span className={styles.paneTitle}>{section === 'backends' ? 'Backends' : 'About'}</span>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close settings">
              <CloseIcon size={16} />
            </button>
          </header>
          <div className={styles.paneBody} key={section}>
            {section === 'backends' ? <BackendsSection api={api} /> : <AboutSection version={version} />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- backends

function BackendsSection({ api }: { api: BackendsApi }) {
  const [backends, setBackends] = useState<Backend[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setBackends(await api.list(signal));
      setFailed(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setFailed(cause instanceof Error ? cause.message : 'Could not load the backends.');
    }
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const replace = (next: Backend) =>
    setBackends((prev) => (prev ?? []).map((b) => (b.id === next.id ? next : b)));

  const onCreated = (backend: Backend) => {
    setBackends((prev) => [...(prev ?? []), backend].sort((a, b) => a.name.localeCompare(b.name)));
    setAdding(false);
    refreshBackends();
  };

  const onRemoved = (id: Uuid) => {
    setBackends((prev) => (prev ?? []).filter((b) => b.id !== id));
    refreshBackends();
  };

  return (
    <div className={styles.section}>
      <p className={styles.blurb}>
        The ComfyUI servers rippel can generate on. Each one is polled every few seconds; the
        pill at the top of every screen shows the first that answers.
      </p>

      {failed ? (
        <div className={styles.notice} role="alert">
          {failed}
        </div>
      ) : null}

      {backends === null && !failed ? (
        <div className={styles.loading} role="status">
          <Mark size={20} ripple="loop" />
          Reading the fleet…
        </div>
      ) : null}

      <ul className={styles.cards}>
        {(backends ?? []).map((backend, index) => (
          <BackendCard
            key={backend.id}
            backend={backend}
            index={index}
            api={api}
            onChange={(next) => {
              replace(next);
              refreshBackends();
            }}
            onRemoved={() => onRemoved(backend.id)}
            onError={setToast}
          />
        ))}
      </ul>

      {backends !== null && backends.length === 0 && !adding ? (
        <p className={styles.empty}>No backends yet. Add the machine ComfyUI runs on.</p>
      ) : null}

      {adding ? (
        <BackendForm
          api={api}
          onCancel={() => setAdding(false)}
          onSaved={onCreated}
        />
      ) : (
        <button type="button" className={styles.add} onClick={() => setAdding(true)}>
          <PlusIcon size={14} />
          Add backend
        </button>
      )}

      {toast ? (
        <div className={`${styles.toast} pop`} role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function statusOf(backend: Backend): 'online' | 'offline' | 'unknown' {
  return backend.enabled ? backend.status : 'offline';
}

function BackendCard({
  backend,
  index,
  api,
  onChange,
  onRemoved,
  onError,
}: {
  backend: Backend;
  index: number;
  api: BackendsApi;
  onChange: (next: Backend) => void;
  onRemoved: () => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [probe, setProbe] = useState<{ state: 'idle' | 'running' } | { state: 'done'; result: BackendProbe }>({
    state: 'idle',
  });
  const status = statusOf(backend);

  // Arming the remove button is a moment, not a mode: it disarms by itself.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  const toggle = async () => {
    const next = { ...backend, enabled: !backend.enabled };
    onChange(next);
    try {
      onChange(await api.update(backend.id, { enabled: next.enabled }));
    } catch (cause) {
      onChange(backend);
      onError(cause instanceof Error ? cause.message : 'Could not change the backend.');
    }
  };

  const test = async () => {
    setProbe({ state: 'running' });
    try {
      setProbe({ state: 'done', result: await api.probe(backend.id) });
    } catch (cause) {
      setProbe({
        state: 'done',
        result: { ok: false, latencyMs: 0, error: cause instanceof Error ? cause.message : 'The test failed.' },
      });
    }
  };

  const remove = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setRemoving(true);
    try {
      await api.remove(backend.id);
      onRemoved();
    } catch (cause) {
      setRemoving(false);
      setArmed(false);
      onError(
        cause instanceof ApiRequestError && cause.code === 'busy'
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Could not remove the backend.',
      );
    }
  };

  if (editing) {
    return (
      <li className={styles.card} style={{ '--i': index } as React.CSSProperties}>
        <BackendForm
          api={api}
          initial={backend}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            onChange(next);
          }}
        />
      </li>
    );
  }

  return (
    <li className={styles.card} style={{ '--i': index } as React.CSSProperties}>
      <div className={styles.cardMain}>
        <span className={styles.dot} data-status={status} aria-hidden />
        <div className={styles.cardText}>
          <div className={styles.cardName}>
            {backend.name}
            <span className={styles.cardStatus} data-status={status}>
              {status === 'online' ? 'online' : status === 'offline' ? (backend.enabled ? 'offline' : 'disabled') : 'checking'}
            </span>
          </div>
          <div className={`mono ${styles.cardUrl}`}>{backend.baseUrl}</div>
          <div className={styles.cardMeta}>
            {backend.deviceName ? <span>{backend.deviceName}</span> : null}
            {backend.vramTotal !== null ? (
              <span className="mono">
                {gb(backend.vramTotal)} GB reported
                {backend.vramLimitMb !== null ? ` · limit ${backend.vramLimitMb} MB` : ''}
              </span>
            ) : backend.vramLimitMb !== null ? (
              <span className="mono">limit {backend.vramLimitMb} MB</span>
            ) : null}
          </div>
        </div>

        <label className={styles.switch}>
          <input
            type="checkbox"
            role="switch"
            checked={backend.enabled}
            aria-label={`${backend.name} enabled`}
            onChange={() => void toggle()}
          />
          <span className={styles.switchTrack} aria-hidden>
            <span className={styles.switchThumb} />
          </span>
        </label>
      </div>

      <div className={styles.cardActions}>
        <button type="button" className={styles.action} onClick={() => void test()} disabled={probe.state === 'running'}>
          {probe.state === 'running' ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className={styles.action} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className={armed ? `${styles.action} ${styles.actionDanger}` : styles.action}
          onClick={() => void remove()}
          disabled={removing}
          aria-label={armed ? `Really remove ${backend.name}` : `Remove ${backend.name}`}
        >
          {removing ? 'Removing…' : armed ? 'Really remove?' : 'Remove'}
        </button>
        {probe.state === 'done' ? <ProbeResult result={probe.result} /> : null}
      </div>
    </li>
  );
}

function ProbeResult({ result }: { result: BackendProbe }) {
  return (
    <span
      className={result.ok ? `${styles.probe} ${styles.probeOk} pop` : `${styles.probe} ${styles.probeBad} pop`}
      role="status"
    >
      {result.ok ? (
        <>
          Answered in <span className="mono">{result.latencyMs} ms</span>
          {result.version ? (
            <>
              {' '}
              · ComfyUI <span className="mono">{result.version}</span>
            </>
          ) : null}
          {result.device ? ` · ${result.device}` : ''}
        </>
      ) : (
        result.error ?? 'No answer.'
      )}
    </span>
  );
}

// ---------------------------------------------------------------- form

function BackendForm({
  api,
  initial,
  onCancel,
  onSaved,
}: {
  api: BackendsApi;
  initial?: Backend;
  onCancel: () => void;
  onSaved: (backend: Backend) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [limit, setLimit] = useState(initial?.vramLimitMb === null || initial === undefined ? '' : String(initial.vramLimitMb));
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<{ state: 'idle' | 'running' } | { state: 'done'; result: BackendProbe }>({ state: 'idle' });

  const testAddress = async () => {
    setProbe({ state: 'running' });
    try {
      setProbe({ state: 'done', result: await api.probeAddress(baseUrl.trim()) });
    } catch (cause) {
      setProbe({
        state: 'done',
        result: { ok: false, latencyMs: 0, error: cause instanceof Error ? cause.message : 'The test failed.' },
      });
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const trimmedLimit = limit.trim();
    const vramLimitMb = trimmedLimit === '' ? null : Number(trimmedLimit);
    if (vramLimitMb !== null && (!Number.isInteger(vramLimitMb) || vramLimitMb <= 0)) {
      setError({ field: 'vramLimitMb', message: 'The memory limit is a whole number of MB, or empty.' });
      return;
    }
    const input: BackendInput = { name: name.trim(), baseUrl: baseUrl.trim(), vramLimitMb };
    setBusy(true);
    try {
      onSaved(initial ? await api.update(initial.id, input) : await api.create(input));
      refreshBackends();
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        const field = (cause as ApiRequestError & { field?: string }).field;
        setError({ field, message: cause.message });
      } else {
        setError({ message: cause instanceof Error ? cause.message : 'Could not save.' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} aria-label={initial ? 'Edit backend' : 'Add backend'}>
      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className="label">Name</span>
          <input
            className={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="desktop-4090"
            autoFocus
            required
          />
        </label>
        <label className={styles.field}>
          <span className="label">Memory limit (MB, optional)</span>
          <input
            className={`mono ${styles.input}`}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            placeholder="reported"
            inputMode="numeric"
          />
        </label>
      </div>
      <label className={styles.field}>
        <span className="label">ComfyUI address</span>
        <div className={styles.addressRow}>
          <input
            className={`mono ${styles.input}`}
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setProbe({ state: 'idle' });
            }}
            placeholder="http://192.168.1.50:8188"
            required
          />
          <button
            type="button"
            className={styles.action}
            onClick={() => void testAddress()}
            disabled={probe.state === 'running' || baseUrl.trim().length < 8}
          >
            {probe.state === 'running' ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {probe.state === 'done' ? <ProbeResult result={probe.result} /> : null}
      </label>

      {error ? (
        <div className={styles.notice} role="alert">
          {error.message}
        </div>
      ) : null}

      <div className={styles.formActions}>
        <button type="button" className={styles.action} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={`${styles.action} ${styles.actionPrimary}`} disabled={busy}>
          {busy ? 'Saving…' : initial ? 'Save changes' : 'Add backend'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- about

function AboutSection({ version }: { version: string }) {
  return (
    <div className={styles.section}>
      <div className={styles.about}>
        <Mark size={40} ripple="hover" />
        <div>
          <div className={styles.aboutName}>rippel</div>
          <div className={`mono ${styles.aboutVersion}`}>version {version}</div>
        </div>
      </div>
      <p className={styles.blurb}>
        A generation studio in front of your own ComfyUI. Everything you make stays on machines you
        run.
      </p>
    </div>
  );
}
