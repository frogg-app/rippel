import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Lockup, Mark } from '@web/components/Mark';
import { call, type AgentLogs, type AgentStatus, type AgentTask, type EngineState } from './agent';

/** How often the panel asks the agent for its state while it is open. */
const POLL_MS = 2000;

type Busy = null | 'pause' | 'resume' | 'start' | 'stop' | 'restart' | 'update' | 'check' | 'quit';

export function App() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [reachError, setReachError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [view, setView] = useState<'home' | 'logs'>('home');
  const panelRef = useRef<HTMLDivElement>(null);
  useFitWindow(panelRef, view === 'home' && status !== null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<AgentStatus>('GET /status'));
      setReachError(null);
    } catch (cause) {
      setReachError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const act = async (what: Exclude<Busy, null>, route: Parameters<typeof call>[0]) => {
    setBusy(what);
    setNotice(null);
    try {
      await call(route);
      await refresh();
    } catch (cause) {
      setNotice(String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel" ref={panelRef}>
      <header className="head" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <Lockup size={17} />
          <span className="brandSub">agent</span>
          {status ? <span className="brandVersion mono">v{status.agentVersion}</span> : null}
        </div>
        <button className="iconButton" aria-label="Close" onClick={() => void getCurrentWindow().hide()}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {view === 'logs' ? (
        <Logs onBack={() => setView('home')} />
      ) : !status ? (
        <div className="empty">
          <Mark size={34} ripple="loop" />
          <p>{reachError ?? 'Talking to the agent…'}</p>
        </div>
      ) : (
        <main className="body">
          <Connection status={status} stale={reachError} />
          <Update
            status={status}
            busy={busy}
            onUpdate={() => void act('update', 'POST /update')}
            onCheck={() => void act('check', 'POST /update/check')}
          />
          <Engine
            engine={status.engine}
            busy={busy}
            onStart={() => void act('start', 'POST /engine/start')}
            onStop={() => void act('stop', 'POST /engine/stop')}
            onRestart={() => void act('restart', 'POST /engine/restart')}
          />
          <Activity status={status} />
        </main>
      )}

      {notice ? (
        <div className="notice" role="alert">
          {notice}
          <button className="noticeClose" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      ) : null}

      {status && view === 'home' ? (
        <Footer
          paused={status.paused}
          busy={busy}
          onPause={() => void act(status.paused ? 'resume' : 'pause', status.paused ? 'POST /resume' : 'POST /pause')}
          onLogs={() => setView('logs')}
          onQuit={() => void act('quit', 'POST /quit')}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- sizing

/** The height the logs and the waiting screen use: room to read, not content-sized. */
const PLAIN_HEIGHT = 600;

/**
 * Keep the window as tall as the panel's content, so there is no empty space
 * below Activity and no scrollbar until the content outgrows the screen. The
 * body measures by its scrollHeight because it shrinks (and scrolls) when the
 * window is capped; everything else is its own height.
 */
function useFitWindow(panelRef: React.RefObject<HTMLDivElement | null>, fitContent: boolean) {
  const last = useRef(0);
  useLayoutEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const measure = () => {
      const panel = panelRef.current;
      if (!panel) return;
      let height = PLAIN_HEIGHT;
      if (fitContent) {
        height = 0;
        for (const child of Array.from(panel.children) as HTMLElement[]) {
          height += child.classList.contains('body') ? child.scrollHeight : child.offsetHeight;
        }
      }
      height = Math.ceil(height);
      if (height !== last.current) {
        last.current = height;
        void invoke('fit', { height });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    const body = panelRef.current?.querySelector('.body');
    for (const child of Array.from(body?.children ?? [])) observer.observe(child);
    return () => observer.disconnect();
  });
}

// ---------------------------------------------------------------- connection

function tone(status: AgentStatus): 'ok' | 'warn' | 'off' {
  if (status.paused) return 'warn';
  if (status.connection === 'Connected') return 'ok';
  if (status.connection.startsWith('Waiting')) return 'warn';
  return 'off';
}

function headline(status: AgentStatus): string {
  if (status.paused) return 'Paused';
  if (status.connection === 'Connected') return 'Connected to rippel';
  return status.connection;
}

function Connection({ status, stale }: { status: AgentStatus; stale: string | null }) {
  const host = hostOf(status.server);
  const detail = status.paused
    ? 'rippel cannot send work or changes here until you resume.'
    : status.checkin.error || (status.connection === 'Connected' ? `Last check-in ${ago(status.checkin.lastSuccess)}.` : '');

  return (
    <section className="hero">
      <div className="heroTop">
        <span className={`dot dot-${tone(status)}`} aria-hidden />
        <h1 className="heroTitle">{headline(status)}</h1>
      </div>
      <p className="heroDetail">{stale ? `Lost the agent: ${stale}` : detail}</p>
      <dl className="facts">
        <div>
          <dt>Machine</dt>
          <dd>{status.hostname}</dd>
        </div>
        <div>
          <dt>Server</dt>
          <dd className="mono">{host ?? 'not set'}</dd>
        </div>
      </dl>
      {status.server ? (
        <button className="action actionPrimary heroOpen" onClick={() => void openUrl(status.server)}>
          Open rippel
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
            <path d="M4 2h6v6M10 2L3 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- update

function Update({
  status,
  busy,
  onUpdate,
  onCheck,
}: {
  status: AgentStatus;
  busy: Busy;
  onUpdate: () => void;
  onCheck: () => void;
}) {
  const update = status.update;
  if (!update) return null;
  const task = status.tasks.find((t) => t.kind === 'update-agent' && (t.status === 'running' || recent(t)));

  if (task && task.status !== 'failed') {
    // Once the download is in, the agent swaps itself out and this panel goes
    // with it; the new agent opens a fresh one a few seconds later.
    const done = task.status !== 'running' || (task.bytesTotal > 0 && task.bytesReceived >= task.bytesTotal);
    const fraction = task.bytesTotal > 0 ? task.bytesReceived / task.bytesTotal : null;
    return (
      <section className="card update">
        <div className="cardHead">
          <p className="label">Updating the agent</p>
          <span className="chip chip-ok">{update.latest ? `v${update.latest}` : 'new version'}</span>
        </div>
        <div className="disk">
          <div className="diskBar">
            <div
              className={fraction === null || done ? 'diskFill indeterminate' : 'diskFill'}
              style={fraction === null || done ? undefined : { width: `${Math.round(fraction * 100)}%` }}
            />
          </div>
          <span className="diskText">
            {done
              ? 'Restarting with the new version. ComfyUI keeps running.'
              : fraction === null
                ? 'Downloading…'
                : `Downloading… ${bytes(task.bytesReceived)} of ${bytes(task.bytesTotal)}`}
          </span>
        </div>
      </section>
    );
  }

  if (update.available) {
    return (
      <section className="card update updateReady">
        <div className="cardHead">
          <p className="label">Update available</p>
          <span className="chip chip-ok">v{update.latest}</span>
        </div>
        <p className="small muted">
          You have v{update.current}. Updating takes a few seconds; ComfyUI and anything it is generating keep running.
        </p>
        {task?.error ? <p className="taskError">The last attempt failed: {task.error}</p> : null}
        <button className="action actionPrimary" disabled={busy !== null} onClick={onUpdate}>
          {busy === 'update' ? 'Starting…' : 'Update now'}
        </button>
      </section>
    );
  }

  return (
    <section className="card updateIdle">
      <span className={`dot ${update.error ? 'dot-warn' : update.checkedAt ? 'dot-ok' : 'dot-off'}`} />
      <div className="updateText">
        <p className="updateTitle">
          {update.error ? "Couldn't check for updates" : update.checkedAt ? 'Agent is up to date' : 'Checking for updates…'}
        </p>
        {update.error || update.checkedAt ? (
          <p className="small muted updateDetail">
            {update.error || `Checked ${ago(update.checkedAt!)}`}
          </p>
        ) : null}
      </div>
      <button className="action actionSmall" disabled={busy !== null} onClick={onCheck}>
        {busy === 'check' ? 'Checking…' : 'Check now'}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------- engine

function Engine({
  engine,
  busy,
  onStart,
  onStop,
  onRestart,
}: {
  engine: EngineState;
  busy: Busy;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const state = !engine.installed ? 'Not installed' : engine.running ? 'Running' : 'Stopped';
  const working = busy === 'start' || busy === 'stop' || busy === 'restart';
  const used = engine.diskTotal && engine.diskFree !== null ? 1 - engine.diskFree / engine.diskTotal : null;

  return (
    <section className="card">
      <div className="cardHead">
        <h2 className="label">Engine</h2>
        <span className={`chip chip-${!engine.installed ? 'off' : engine.running ? 'ok' : 'idle'}`}>{state}</span>
      </div>
      <div className="engineName">
        ComfyUI
        {engine.version ? <span className="mono muted"> v{engine.version.replace(/^v/, '')}</span> : null}
      </div>
      <div className="engineMeta mono">
        {engine.commit ? <span>{engine.commit.slice(0, 7)}</span> : null}
        {engine.installed ? <span>port {engine.port}</span> : null}
        {engine.memoryMode ? <span>{engine.memoryMode}</span> : null}
      </div>
      {used !== null ? (
        <div className="disk">
          <div className="diskBar">
            <div className="diskFill" style={{ width: `${Math.round(used * 100)}%` }} />
          </div>
          <span className="diskText">{bytes(engine.diskFree!)} free of {bytes(engine.diskTotal!)}</span>
        </div>
      ) : null}
      {engine.installed ? (
        <div className="row">
          {engine.running ? (
            <>
              <button className="action" disabled={working} onClick={onRestart}>
                {busy === 'restart' ? 'Restarting…' : 'Restart'}
              </button>
              <button className="action" disabled={working} onClick={onStop}>
                {busy === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </>
          ) : (
            <button className="action actionPrimary" disabled={working} onClick={onStart}>
              {busy === 'start' ? 'Starting…' : 'Start ComfyUI'}
            </button>
          )}
        </div>
      ) : (
        <p className="muted small">Install ComfyUI from rippel’s Settings → Deployments.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- activity

const TASK_LABEL: Record<string, string> = {
  'install-comfy': 'Installing ComfyUI',
  'update-comfy': 'Updating ComfyUI',
  'update-agent': 'Updating the agent',
  'set-memory': 'Applying memory settings',
  'install-helper': 'Installing the storage helper',
};

function Activity({ status }: { status: AgentStatus }) {
  const running = status.queue?.running.length ?? 0;
  const pending = status.queue?.pending.length ?? 0;
  const tasks = status.tasks.filter((t) => t.status === 'running' || recent(t));

  return (
    <section className="card">
      <div className="cardHead">
        <h2 className="label">Activity</h2>
      </div>
      <div className="stats">
        <Stat value={running} label="generating" live={running > 0} />
        <Stat value={pending} label="queued" />
      </div>
      {status.queueError && status.engine.running ? <p className="muted small">{status.queueError}</p> : null}
      {tasks.length ? (
        <ul className="tasks">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Stat({ value, label, live }: { value: number; label: string; live?: boolean }) {
  return (
    <div className="stat">
      <span className={live ? 'statValue statLive' : 'statValue'}>{value}</span>
      <span className="statLabel">{label}</span>
    </div>
  );
}

function TaskRow({ task }: { task: AgentTask }) {
  const fraction = task.bytesTotal > 0 ? task.bytesReceived / task.bytesTotal : null;
  return (
    <li className="task">
      <div className="taskHead">
        <span>{TASK_LABEL[task.kind] ?? task.kind.replace(/-/g, ' ')}</span>
        <span className={`taskState taskState-${task.status}`}>{task.status}</span>
      </div>
      {task.status === 'running' ? (
        <div className="diskBar">
          <div
            className={fraction === null ? 'diskFill indeterminate' : 'diskFill'}
            style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
      ) : null}
      {task.error ? <p className="taskError">{task.error}</p> : null}
    </li>
  );
}

// ---------------------------------------------------------------- footer

function Footer({
  paused,
  busy,
  onPause,
  onLogs,
  onQuit,
}: {
  paused: boolean;
  busy: Busy;
  onPause: () => void;
  onLogs: () => void;
  onQuit: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const disarm = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(disarm.current), []);

  return (
    <footer className="foot">
      <label className="switchRow">
        <button
          role="switch"
          aria-checked={!paused}
          className="switch"
          disabled={busy === 'pause' || busy === 'resume'}
          onClick={onPause}
        >
          <span className="switchKnob" />
        </button>
        <span>
          <span className="switchTitle">Remote management</span>
          <span className="switchNote">{paused ? 'Paused — rippel can only watch' : 'rippel can send work here'}</span>
        </span>
      </label>
      <div className="row">
        <button className="action" onClick={onLogs}>
          Logs
        </button>
        <button
          className={armed ? 'action actionDanger' : 'action'}
          disabled={busy === 'quit'}
          onClick={() => {
            if (!armed) {
              setArmed(true);
              disarm.current = window.setTimeout(() => setArmed(false), 3000);
              return;
            }
            onQuit();
          }}
        >
          {busy === 'quit' ? 'Quitting…' : armed ? 'Really quit?' : 'Quit agent'}
        </button>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------- logs

function Logs({ onBack }: { onBack: () => void }) {
  const [logs, setLogs] = useState<AgentLogs | null>(null);
  const [which, setWhich] = useState<'engine' | 'agent'>('engine');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      call<AgentLogs>('GET /logs')
        .then((l) => live && setLogs(l))
        .catch((e) => live && setError(String(e)));
    void load();
    const timer = window.setInterval(load, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  // Scroll the log box alone. scrollIntoView would also scroll the window,
  // which in a fixed-size panel pushes the header and Back off screen.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs, which]);
  const lines = logs?.[which] ?? [];

  return (
    <main className="body logs">
      <div className="logsHead">
        <button className="action" onClick={onBack}>
          ← Back
        </button>
        <div className="seg" role="tablist">
          {(['engine', 'agent'] as const).map((key) => (
            <button key={key} role="tab" aria-selected={which === key} className={which === key ? 'segOn' : ''} onClick={() => setWhich(key)}>
              {key === 'engine' ? 'ComfyUI' : 'Agent'}
            </button>
          ))}
        </div>
      </div>
      <div className="logBox mono" ref={box}>
        {error ? <p className="muted">{error}</p> : null}
        {lines.length === 0 && !error ? <p className="muted">Nothing logged yet.</p> : null}
        {lines.map((line, i) => (
          <div key={i} className="logLine">
            {line}
          </div>
        ))}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- helpers

function hostOf(url: string): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return url || null;
  }
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function recent(task: AgentTask): boolean {
  return task.finishedAt !== null && Date.now() - Date.parse(task.finishedAt) < 10 * 60_000;
}

function bytes(n: number): string {
  const gb = n / 1024 ** 3;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}
