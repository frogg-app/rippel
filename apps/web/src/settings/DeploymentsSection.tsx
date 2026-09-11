import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  AgentPlatform,
  AgentProbe,
  AgentTask,
  Deployment,
  SshRun,
} from '@comfy/shared';
import { CheckIcon, CopyIcon, DownloadIcon, PlusIcon } from '../library/icons';
import { Mark } from '../components/Mark';
import { gb } from '../lib/format';
import { ApiRequestError } from '../lib/api';
import {
  deploymentsApi as defaultApi,
  type DeploymentsApi,
  type InstallInstructions,
} from '../lib/api-deployments';
import { refreshBackends } from '../shell/useBackends';
import shared from './SettingsModal.module.css';
import { Dropdown } from '../components/Dropdown';
import styles from './DeploymentsSection.module.css';

/** The three platforms the agent installer knows how to reach. */
const PLATFORM_OPTIONS = [
  { value: 'linux', label: 'Linux' },
  { value: 'darwin', label: 'macOS' },
  { value: 'win32', label: 'Windows (OpenSSH)' },
];

/**
 * Deployment, for administrators.
 *
 * A *backend* is an address rippel sends prompts to. A *deployment* is a
 * machine rippel can act on — install ComfyUI, update it, restart it, put the
 * storage helper back. This panel is the second of those, and it links to the
 * first with one button once the machine has a ComfyUI worth generating on.
 *
 * There are two ways in and they install exactly the same thing. Managed hands
 * rippel an SSH credential and lets it run the installer for you; manual gives
 * you the one line that installer would have been fetched by, to paste on a
 * machine rippel cannot SSH to — a Windows desktop, a box behind a bastion, or
 * one where you would simply rather read the script first.
 */

const POLL_MS = 2000;

export function DeploymentsSection({ api = defaultApi }: { api?: DeploymentsApi }) {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | 'ssh' | 'manual'>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setDeployments(await api.list(signal));
        setFailed(null);
      } catch (cause) {
        if (signal?.aborted) return;
        setFailed(cause instanceof Error ? cause.message : 'Could not load the deployments.');
      }
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    // The list is a heartbeat view: an agent that stopped checking in becomes
    // offline without anything on this page having done anything.
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  const onCreated = (deployment: Deployment) => {
    setDeployments((prev) =>
      [...(prev ?? []).filter((d) => d.id !== deployment.id), deployment].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
  };

  return (
    <div className={shared.section}>
      <p className={shared.blurb}>
        Machines rippel manages through the rippel agent. The agent installs and updates ComfyUI,
        starts and stops it, and keeps the storage helper in place — so a new GPU box is a form
        rather than an afternoon.
      </p>

      {failed ? (
        <div className={shared.notice} role="alert">
          {failed}
        </div>
      ) : null}

      {deployments === null && !failed ? (
        <div className={shared.loading} role="status">
          <Mark size={20} ripple="loop" />
          Reading the fleet…
        </div>
      ) : null}

      <ul className={shared.cards}>
        {(deployments ?? []).map((deployment, index) => (
          <DeploymentCard
            key={deployment.id}
            deployment={deployment}
            index={index}
            api={api}
            onChange={(next) =>
              setDeployments((prev) => (prev ?? []).map((d) => (d.id === next.id ? next : d)))
            }
            onRemoved={() =>
              setDeployments((prev) => (prev ?? []).filter((d) => d.id !== deployment.id))
            }
            onError={setToast}
          />
        ))}
      </ul>

      {deployments !== null && deployments.length === 0 && !adding ? (
        <p className={shared.empty}>
          No machines are managed yet. Deploy an agent onto the box ComfyUI should run on.
        </p>
      ) : null}

      {adding === 'ssh' ? (
        <SshInstallForm
          api={api}
          onCancel={() => setAdding(null)}
          onDone={(deployment) => {
            onCreated(deployment);
            void load();
          }}
        />
      ) : adding === 'manual' ? (
        <ManualInstall
          api={api}
          onCancel={() => setAdding(null)}
          onCreated={onCreated}
          onError={setToast}
        />
      ) : (
        <div className={styles.addRow}>
          <button type="button" className={shared.add} onClick={() => setAdding('ssh')}>
            <PlusIcon size={14} />
            Deploy over SSH
          </button>
          <button type="button" className={shared.add} onClick={() => setAdding('manual')}>
            <DownloadIcon size={14} />
            Install by hand
          </button>
        </div>
      )}

      {toast ? (
        <div className={`${shared.toast} pop`} role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- one machine

const PLATFORM_LABEL: Record<AgentPlatform, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
  // Not "unknown platform": nothing is wrong, the agent simply has not said
  // yet. The card's next-action line explains what that means.
  unknown: 'platform not known yet',
};

function DeploymentCard({
  deployment,
  index,
  api,
  onChange,
  onRemoved,
  onError,
}: {
  deployment: Deployment;
  index: number;
  api: DeploymentsApi;
  onChange: (next: Deployment) => void;
  onRemoved: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [task, setTask] = useState<AgentTask | null>(null);
  const [probe, setProbe] = useState<AgentProbe | null>(null);
  const [armed, setArmed] = useState(false);
  // A machine that has never been heard from has exactly one useful next step,
  // so the panel holding it is already open rather than behind another click.
  const [showInstall, setShowInstall] = useState(() => !deployment.lastSeenAt);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  const comfy = deployment.comfy;
  const online = deployment.status === 'online';

  /**
   * Why a control is refusing, in the words the card would use out loud.
   *
   * Every one of these buttons used to go simply grey, which answers nothing —
   * "Install ComfyUI" greyed out on a brand-new machine looks like a bug
   * rather than a machine that has not been set up yet.
   */
  const offlineReason = online
    ? null
    : deployment.lastSeenAt
      ? 'The agent is not answering. Press Test to try it again.'
      : 'Waiting for the agent to check in. Install the agent on this machine first.';
  const busyReason = busy ? `Waiting for “${busy}” to finish.` : null;

  /** Follow an agent task to its end, appending only what is new each poll. */
  const follow = useCallback(
    async (started: AgentTask) => {
      setTask(started);
      let since = 0;
      let current = started;
      while (current.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        try {
          const next = await api.task(deployment.id, started.id, since);
          since = next.logOffset;
          current = { ...next.task, log: [...current.log, ...next.task.log] };
          setTask(current);
        } catch (cause) {
          // A task poll that fails is not a task that failed — the agent may
          // be restarting ComfyUI, which is a step in several of these.
          if (cause instanceof ApiRequestError && cause.status === 404) break;
          setTask({
            ...current,
            status: 'failed',
            error: cause instanceof Error ? cause.message : 'Lost contact with the agent.',
          });
          return;
        }
      }
    },
    [api, deployment.id],
  );

  /** Run one action, keeping exactly one in flight and reporting failures. */
  const act = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    try {
      await fn();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : `Could not ${label}.`);
    } finally {
      setBusy(null);
    }
  };

  const refresh = () =>
    act('read the machine', async () => {
      const status = await api.status(deployment.id);
      onChange({ ...deployment, comfy: status.comfy, status: 'online' });
    });

  const test = () =>
    act('test the agent', async () => {
      setProbe(await api.probe(deployment.id));
    });

  const install = () =>
    act('install ComfyUI', async () => {
      await follow(await api.installComfy(deployment.id, 'auto'));
      const status = await api.status(deployment.id).catch(() => null);
      if (status) onChange({ ...deployment, comfy: status.comfy });
    });

  const update = () =>
    act('update ComfyUI', async () => {
      await follow(await api.updateComfy(deployment.id));
    });

  const power = (action: 'start' | 'stop' | 'restart') =>
    act(`${action} ComfyUI`, async () => {
      await api.power(deployment.id, action);
      // Starting ComfyUI takes a few seconds to bind its port, so the status
      // read that would say "running" is deliberately delayed rather than
      // immediate and wrong.
      await new Promise((resolve) => setTimeout(resolve, action === 'stop' ? 500 : 4000));
      const status = await api.status(deployment.id).catch(() => null);
      if (status) onChange({ ...deployment, comfy: status.comfy });
      refreshBackends();
    });

  const helper = () =>
    act('install the storage helper', async () => {
      await follow(await api.installHelper(deployment.id));
      const status = await api.status(deployment.id).catch(() => null);
      if (status) onChange({ ...deployment, comfy: status.comfy });
    });

  const register = () =>
    act('register the backend', async () => {
      const { deployment: next, adopted } = await api.registerBackend(deployment.id);
      onChange(next);
      refreshBackends();
      if (adopted) onError(`Linked to the existing backend "${next.backendName}".`);
    });

  const remove = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    await act('remove the deployment', async () => {
      await api.remove(deployment.id);
      onRemoved();
    });
  };

  return (
    <li className={shared.card} style={{ '--i': index } as React.CSSProperties}>
      <div className={shared.cardMain}>
        <span className={shared.dot} data-status={deployment.status === 'pending' ? 'unknown' : deployment.status} aria-hidden />
        <div className={shared.cardText}>
          <div className={shared.cardName}>
            {deployment.name}
            <span className={shared.cardStatus} data-status={deployment.status === 'pending' ? 'unknown' : deployment.status}>
              {deployment.status === 'pending' ? 'waiting for the agent' : deployment.status}
            </span>
          </div>
          <div className={`mono ${shared.cardUrl}`}>
            {deployment.host}:{deployment.agentPort}
          </div>
          <div className={shared.cardMeta}>
            <span>{PLATFORM_LABEL[deployment.platform]}</span>
            {deployment.agentVersion ? <span className="mono">agent {deployment.agentVersion}</span> : null}
            {comfy?.diskTotal ? (
              <span className="mono">
                {gb(comfy.diskFree ?? 0)} GB free of {gb(comfy.diskTotal)} GB
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <NextAction deployment={deployment} />
      <ComfySummary deployment={deployment} />

      <div className={shared.cardActions}>
        <button type="button" className={shared.action} onClick={() => void test()} disabled={busy !== null}>
          {busy === 'test the agent' ? 'Testing…' : 'Test'}
        </button>
        <ReasonedButton
          className={shared.action}
          reason={busyReason ?? offlineReason}
          onClick={() => void refresh()}
        >
          {busy === 'read the machine' ? 'Reading…' : 'Refresh'}
        </ReasonedButton>

        {comfy?.installed ? (
          <>
            <ReasonedButton
              className={shared.action}
              reason={busyReason ?? offlineReason}
              onClick={() => void power(comfy.running ? 'restart' : 'start')}
            >
              {busy?.endsWith('ComfyUI') && busy.startsWith(comfy.running ? 'restart' : 'start')
                ? 'Working…'
                : comfy.running
                  ? 'Restart ComfyUI'
                  : 'Start ComfyUI'}
            </ReasonedButton>
            {comfy.running ? (
              <ReasonedButton className={shared.action} reason={busyReason} onClick={() => void power('stop')}>
                Stop
              </ReasonedButton>
            ) : null}
            <ReasonedButton
              className={shared.action}
              reason={busyReason ?? offlineReason}
              onClick={() => void update()}
            >
              {busy === 'update ComfyUI' ? 'Updating…' : 'Update'}
            </ReasonedButton>
          </>
        ) : (
          <ReasonedButton
            className={`${shared.action} ${shared.actionPrimary}`}
            reason={busyReason ?? offlineReason}
            onClick={() => void install()}
          >
            {busy === 'install ComfyUI' ? 'Installing…' : 'Install ComfyUI'}
          </ReasonedButton>
        )}

        {comfy?.installed && !comfy.helperReady ? (
          <ReasonedButton
            className={shared.action}
            reason={busyReason ?? offlineReason}
            onClick={() => void helper()}
          >
            {busy === 'install the storage helper' ? 'Installing…' : 'Install storage helper'}
          </ReasonedButton>
        ) : null}

        {comfy?.installed && !deployment.backendId ? (
          <ReasonedButton
            className={`${shared.action} ${shared.actionPrimary}`}
            reason={busyReason}
            onClick={() => void register()}
          >
            {busy === 'register the backend' ? 'Adding…' : 'Add as backend'}
          </ReasonedButton>
        ) : null}

        <button type="button" className={shared.action} onClick={() => setShowInstall((v) => !v)}>
          {/* "Hide Install Agent" parsed as a verb phrase — an instruction to
              hide the agent, rather than the toggle for this section. */}
          {showInstall ? 'Hide install options' : 'Install Agent'}
        </button>

        <button
          type="button"
          className={armed ? `${shared.action} ${shared.actionDanger}` : shared.action}
          onClick={() => void remove()}
          disabled={busy !== null}
          aria-label={armed ? `Really remove ${deployment.name}` : `Remove ${deployment.name}`}
        >
          {armed ? 'Really remove?' : 'Remove'}
        </button>
      </div>

      {probe ? (
        <span
          className={probe.ok ? `${shared.probe} ${shared.probeOk} pop` : `${shared.probe} ${shared.probeBad} pop`}
          role="status"
        >
          {probe.ok ? (
            <>
              Answered in <span className="mono">{probe.latencyMs} ms</span>
              {probe.version ? (
                <>
                  {' '}
                  · agent <span className="mono">{probe.version}</span>
                </>
              ) : null}
              {probe.hostname ? ` · ${probe.hostname}` : ''}
            </>
          ) : (
            probe.error ?? 'No answer.'
          )}
        </span>
      ) : null}

      {showInstall ? <InstallInstructionsPanel api={api} deployment={deployment} /> : null}
      {task ? <TaskLog task={task} onDismiss={() => setTask(null)} /> : null}
    </li>
  );
}

/**
 * What this machine is waiting for, in one sentence with the next move in it.
 *
 * Three states, and the difference between the first two is the one the old
 * panel hid: a machine that has never been heard from needs the agent
 * installed, while one that checks in and has no ComfyUI needs a button on
 * this very card. Saying only "waiting for the agent" left both looking alike.
 */
function NextAction({ deployment }: { deployment: Deployment }) {
  const comfy = deployment.comfy;
  const neverSeen = !deployment.lastSeenAt;

  if (neverSeen) {
    return (
      <p className={`${styles.next} ${styles.nextWaiting}`}>
        <span className={styles.nextText}>
          <strong>Waiting for the agent to check in.</strong> Nothing has been heard from this
          machine yet. Use <strong>Install Agent</strong> below to put the agent on it — once it
          starts, this card fills in by itself.
        </span>
      </p>
    );
  }
  if (deployment.status !== 'online') {
    return (
      <p className={`${styles.next} ${styles.nextWaiting}`}>
        <span className={styles.nextText}>
          <strong>The agent has stopped answering.</strong> It checked in before, so it is
          installed — the machine may be asleep or the agent stopped. Press <strong>Test</strong> to
          try it again.
        </span>
      </p>
    );
  }
  if (comfy && !comfy.installed) {
    return (
      <p className={`${styles.next} ${styles.nextReady}`}>
        <span className={styles.nextText}>
          <strong>The agent is running.</strong> There is no ComfyUI on this machine yet — press{' '}
          <strong>Install ComfyUI</strong> to put one there.
        </span>
      </p>
    );
  }
  return null;
}

/** The ComfyUI on that machine, in one line per fact worth knowing. */
function ComfySummary({ deployment }: { deployment: Deployment }) {
  const comfy = deployment.comfy;
  if (!comfy) {
    return (
      <p className={styles.summary}>
        Nothing reported yet. Once the agent checks in, what ComfyUI it has appears here.
      </p>
    );
  }
  return (
    <dl className={styles.summary}>
      <div>
        <dt>ComfyUI</dt>
        <dd>
          {comfy.installed ? (
            <>
              <span data-state={comfy.running ? 'on' : 'off'} className={styles.pip} />
              {comfy.running ? 'running' : 'installed, stopped'}
              {comfy.version ? <span className="mono"> · {comfy.version}</span> : null}
              {comfy.commit ? <span className="mono"> · {comfy.commit}</span> : null}
            </>
          ) : (
            'not installed'
          )}
        </dd>
      </div>
      <div>
        <dt>Storage helper</dt>
        <dd>
          <span data-state={comfy.helperReady ? 'on' : comfy.helperInstalled ? 'warn' : 'off'} className={styles.pip} />
          {comfy.helperReady
            ? 'answering'
            : comfy.helperInstalled
              ? 'installed, not answering — restart ComfyUI'
              : 'not installed'}
        </dd>
      </div>
      <div>
        <dt>Backend</dt>
        <dd>
          {deployment.backendName ? (
            <>
              <span data-state="on" className={styles.pip} />
              {deployment.backendName}
            </>
          ) : (
            'not registered'
          )}
        </dd>
      </div>
      {comfy.path ? (
        <div>
          <dt>Path</dt>
          <dd className="mono">{comfy.path}</dd>
        </div>
      ) : null}
    </dl>
  );
}

// ---------------------------------------------------------------- logs

function LogLines({ lines }: { lines: string[] }) {
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // Follow the tail, but only while the reader is already at it — scrolling
    // back to read an error should not be yanked away by the next line.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre className={`mono ${styles.log}`} ref={box} tabIndex={0}>
      {lines.length ? lines.join('\n') : 'waiting for output…'}
    </pre>
  );
}

function TaskLog({ task, onDismiss }: { task: AgentTask; onDismiss: () => void }) {
  return (
    <div className={styles.logBox}>
      <div className={styles.logHead}>
        <span>
          {task.kind.replace(/-/g, ' ')} —{' '}
          <span data-status={task.status}>{task.status === 'running' ? 'running…' : task.status}</span>
        </span>
        <button type="button" className={shared.action} onClick={onDismiss}>
          {task.status === 'running' ? 'Hide' : 'Dismiss'}
        </button>
      </div>
      {task.error ? (
        <div className={shared.notice} role="alert">
          {task.error}
        </div>
      ) : null}
      <LogLines lines={task.log} />
    </div>
  );
}

// ---------------------------------------------------------------- copy button

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard the browser refuses is not an error worth a dialog: the
      // text is on screen and selectable, which is the fallback anyway.
      setCopied(false);
    }
  };
  return (
    <div className={styles.copyField}>
      <span className="label">{label}</span>
      <div className={styles.copyRow}>
        <code className={`mono ${styles.code}`}>{value}</code>
        <button type="button" className={shared.action} onClick={() => void copy()} aria-label={`Copy ${label}`}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- manual path

const PLATFORM_ORDER: AgentPlatform[] = ['linux', 'darwin', 'win32'];

/** One static binary, so this is single-digit megabytes and always will be. */
function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Which agent build the person reading this screen would need.
 *
 * Detected from the *browser*, not from the deployment row. The row's platform
 * is whatever the agent last reported, and on a machine that has never checked
 * in it is "unknown" — which is precisely when this panel matters most. The
 * person looking at it is usually the one who will run the file, so their own
 * browser is the better evidence, and every other build stays one click away.
 *
 * Apple silicon versus Intel is the one genuinely hard case: a Mac reports
 * "MacIntel" either way. `userAgentData` answers it properly where it exists
 * (Chromium), and everywhere else the tie is broken towards Apple silicon —
 * every Mac sold since 2020 — with the Intel build listed right beside it.
 */
export function detectTarget(nav: Navigator = navigator): string {
  const data = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = `${data?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent ?? ''}`.toLowerCase();

  if (platform.includes('win')) return 'windows-amd64';
  if (platform.includes('linux') && !platform.includes('android')) return 'linux-amd64';
  if (platform.includes('mac') || platform.includes('darwin') || platform.includes('iphone')) {
    // A Mac with more than a handful of cores reporting "MacIntel" under a
    // browser that will not tell us the architecture is, overwhelmingly, an
    // Apple-silicon machine running a page that cannot see it.
    return 'macos-arm64';
  }
  return 'linux-amd64';
}

// ---------------------------------------------------------------- why disabled

/**
 * A button that says why it cannot be used, instead of going quiet.
 *
 * A `disabled` button answers "why is this grey?" with nothing at all: it takes
 * no hover, no focus and no tap, so a `title` attribute reaches a mouse and
 * nobody else. This keeps the button in the tab order and marks it
 * `aria-disabled` instead, which is the same promise to a screen reader without
 * the silence — the same trade the model cards' TypeBadge makes.
 *
 * `reason` present means "refuse, and explain". `reason` absent means the
 * button is simply live.
 */
function ReasonedButton({
  reason,
  className,
  onClick,
  children,
  ...rest
}: {
  reason?: string | null;
  className?: string;
  onClick: () => void;
  children: ReactNode;
  'aria-label'?: string;
}) {
  const tipId = useId();
  const [pinned, setPinned] = useState(false);

  if (!reason) {
    return (
      <button type="button" className={className} onClick={onClick} {...rest}>
        {children}
      </button>
    );
  }

  return (
    <span className={styles.reasonWrap}>
      <button
        type="button"
        className={`${className} ${styles.reasonButton}`}
        aria-disabled
        aria-describedby={tipId}
        // A tap is the only way to reach this on a touch screen, so it reveals
        // the sentence rather than doing nothing at all.
        onClick={() => setPinned((open) => !open)}
        onBlur={() => setPinned(false)}
        {...rest}
      >
        {children}
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={pinned ? `${styles.reasonTip} ${styles.reasonTipOn}` : styles.reasonTip}
      >
        {reason}
      </span>
    </span>
  );
}

/**
 * The install command carries the agent token in its query string, and the
 * agent then checks in to that same address forever. Over a LAN in plaintext
 * that is how everyone runs this; to a public host it means the token crosses
 * the internet in clear text, which is worth saying out loud rather than
 * leaving for someone to notice.
 */
function plaintextToPublicHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (!host.includes('.') && !host.includes(':')) return false;
  return true;
}

function InstallInstructionsPanel({ api, deployment }: { api: DeploymentsApi; deployment: Deployment }) {
  const [data, setData] = useState<InstallInstructions | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The command-line tabs still choose a platform; the download chooses a
  // build, which is a finer thing (two of them are macOS).
  const [platform, setPlatform] = useState<AgentPlatform>(
    deployment.platform === 'unknown' ? 'linux' : deployment.platform,
  );
  const target = useMemo(() => detectTarget(), []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .instructions(deployment.id, controller.signal)
      .then(setData)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setFailed(cause instanceof Error ? cause.message : 'Could not build the install command.');
      });
    return () => controller.abort();
  }, [api, deployment.id]);

  if (failed) {
    return (
      <div className={shared.notice} role="alert">
        {failed}
      </div>
    );
  }
  if (!data) {
    return (
      <div className={shared.loading} role="status">
        <Mark size={16} ripple="loop" />
        Building the command…
      </div>
    );
  }

  // Prefer a binary this rippel has on disk — its filename carries the address
  // and token, so opening it is the whole install. Fall back to the GitHub
  // release only when nothing is built here.
  const chosen = data.downloads.find((d) => d.target === target) ?? data.downloads[0] ?? null;
  const others = data.downloads.filter((d) => d.target !== chosen?.target);

  return (
    <div className={styles.panel}>
      {/* ---------------------------------------------------- the easy path */}
      {chosen ? (
        <div className={`${styles.step} ${styles.stepLead}`}>
          <div className={styles.stepHead}>
            <h4 className={styles.stepTitle}>Download the agent here</h4>
          </div>
          <p className={styles.stepNote}>
            Usually the whole job: whoever opened this screen is usually sitting at the machine
            ComfyUI should run on. One file, about {fileSize(chosen.sizeBytes)} — nothing needs to
            be installed first and there is nothing to unpack. Run it and it registers itself with
            this rippel.
          </p>
          <div className={styles.downloadRow}>
            <a
              className={`${shared.action} ${shared.actionPrimary} ${styles.downloadPrimary}`}
              href={chosen.url}
              download={chosen.fileName}
            >
              <DownloadIcon size={14} />
              Download for {chosen.label}
              <span className="mono"> ({fileSize(chosen.sizeBytes)})</span>
            </a>
            {others.length ? (
              <>
                <span className={styles.otherLabel}>Another computer?</span>
                {others.map((d) => (
                  <a key={d.target} className={shared.action} href={d.url} download={d.fileName}>
                    {d.label}
                  </a>
                ))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* --------------------------- when somebody else is at that machine */}
      <div className={styles.step}>
        <div className={styles.stepHead}>
          <h4 className={styles.stepTitle}>Send a setup link</h4>
        </div>
        <p className={styles.stepNote}>
          <strong>Needs no rippel login at the other end.</strong> Use this when somebody else is
          sitting at <strong>{deployment.name}</strong>, or when you would rather not sign in to
          rippel from there. They open it, click the button for their computer, and open the file
          that downloads — nothing to type and nothing to unpack.
        </p>
        <p className={styles.stepNote}>
          The link is only as reachable as the address inside it: it points at{' '}
          <code className="mono">{data.serverUrl}</code>, so it will not open for someone who cannot
          reach that address — send them the downloaded file instead.
        </p>
        <CopyField label="Setup link" value={data.setupLink} />
        <div className={styles.downloadRow}>
          <a className={shared.action} href={data.setupLink} target="_blank" rel="noreferrer">
            Open the setup page
          </a>
        </div>
      </div>

      {/* ------------------------------------------------ the command line */}
      <details className={styles.details} open={!chosen}>
        <summary>Install from a command line instead</summary>
        <p className={styles.stepNote}>
          For a machine nobody is sitting at — an SSH session, or a headless box that cannot click.
          Run this on <strong>{deployment.name}</strong> as the account that should own the ComfyUI
          install. It fetches the same single binary, writes its configuration, and starts it as a{' '}
          {platform === 'win32' ? 'scheduled task' : platform === 'darwin' ? 'LaunchAgent' : 'systemd user service'}.
          Re-running it upgrades in place.
        </p>

        <div className={styles.tabs} role="tablist" aria-label="Platform">
          {PLATFORM_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={platform === p}
              className={platform === p ? `${styles.tab} ${styles.tabOn}` : styles.tab}
              onClick={() => setPlatform(p)}
            >
              {PLATFORM_LABEL[p]}
            </button>
          ))}
        </div>

        <CopyField label="Install Agent" value={data.commands[platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux']} />

        <p className={styles.stepNote}>
          The command points that machine at <code className="mono">{data.serverUrl}</code> — the
          address you are reaching rippel on right now. The agent checks in there from then on, so
          it has to be an address <strong>{deployment.name}</strong> can reach too. If it cannot,
          set
          <code className="mono"> AGENT_SERVER_URL</code> on the rippel server to the address it
          should use and copy the command again.
        </p>
        {plaintextToPublicHost(data.serverUrl) ? (
          <p className={styles.warn}>
            That address is plain <code className="mono">http</code> on a public host, and this
            command carries the agent token in its URL. Anything on the path between the two
            machines can read it. Reach rippel over https before running this, or install over SSH
            instead.
          </p>
        ) : null}
      </details>

      <details className={styles.details}>
        <summary>Configure it by hand instead</summary>
        <p className={styles.stepNote}>
          The agent reads its setup from its own filename, so this is only needed if the file was
          renamed on the way. Run it once and it will ask for these, or put them in
          <code className="mono"> ~/.rippel-agent/config.json</code>.
        </p>
        <CopyField label="rippel address" value={data.serverUrl} />
        <CopyField label="Deployment id" value={deployment.id} />
        <CopyField label="Agent token" value={data.token} />
        <p className={styles.warn}>
          That token lets whoever holds it install software on this machine. Treat it the way you
          would an SSH key, and remove the deployment here if it ever leaks.
        </p>
      </details>

      <div className={styles.release}>
        <div>
          <span className="label">Agent release</span>
          <div className={styles.releaseName}>
            {data.release.tag ? (
              <>
                <span className="mono">{data.release.tag}</span>
                {data.release.publishedAt ? (
                  <span className={styles.muted}>
                    {' '}
                    · {new Date(data.release.publishedAt).toLocaleDateString()}
                  </span>
                ) : null}
              </>
            ) : (
              <span className={styles.muted}>latest</span>
            )}
          </div>
        </div>
        <a className={shared.action} href={data.release.url} target="_blank" rel="noreferrer">
          All releases
        </a>
      </div>
      {!chosen ? (
        <p className={styles.muted}>
          This rippel has no agent binaries built, so the downloads above are not available. Run{' '}
          <code className="mono">npm run build:release -w @comfy/agent</code> where rippel is
          installed, or take the binary for this machine from the release page.
        </p>
      ) : null}
      {data.release.note ? <p className={styles.muted}>{data.release.note}</p> : null}
    </div>
  );
}

function ManualInstall({
  api,
  onCancel,
  onCreated,
  onError,
}: {
  api: DeploymentsApi;
  onCancel: () => void;
  onCreated: (deployment: Deployment) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [created, setCreated] = useState<Deployment | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const deployment = await api.create({ name: name.trim(), host: host.trim() });
      onCreated(deployment);
      setCreated(deployment);
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        setError({ field: (cause as ApiRequestError & { field?: string }).field, message: cause.message });
      } else {
        onError(cause instanceof Error ? cause.message : 'Could not create the deployment.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    // The machine now has a card of its own, and because it has never checked
    // in that card already has the setup link and the download open on it.
    // Repeating the whole panel here would be the same thing twice on one
    // screen — so this just says where it went.
    return (
      <div className={shared.form}>
        <p className={shared.blurb}>
          <strong>{created.name}</strong> is registered and waiting. Its card above has the setup
          link and the download for it; it will appear as online here within a minute of the agent
          starting.
        </p>
        <div className={shared.formActions}>
          <button type="button" className={`${shared.action} ${shared.actionPrimary}`} onClick={onCancel}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className={shared.form} onSubmit={(event) => void submit(event)} aria-label="Install the agent by hand">
      <p className={shared.blurb}>
        Register the machine first so rippel can generate a command with its address and token
        already filled in. Nothing is installed until you run that command on the machine itself.
      </p>
      <div className={shared.formRow}>
        <label className={shared.field}>
          <span className="label">Name</span>
          <input
            className={shared.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="studio-4090"
            autoFocus
            required
          />
        </label>
        <label className={shared.field}>
          <span className="label">Address on your network</span>
          <input
            className={`mono ${shared.input}`}
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="192.168.1.50"
            required
          />
        </label>
      </div>
      {error ? (
        <div className={shared.notice} role="alert">
          {error.message}
        </div>
      ) : null}
      <div className={shared.formActions}>
        <button type="button" className={shared.action} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={`${shared.action} ${shared.actionPrimary}`} disabled={busy}>
          {busy ? 'Registering…' : 'Register and show the command'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- managed SSH

function SshInstallForm({
  api,
  onCancel,
  onDone,
}: {
  api: DeploymentsApi;
  onCancel: () => void;
  onDone: (deployment: Deployment) => void;
}) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [method, setMethod] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [platform, setPlatform] = useState<'linux' | 'darwin' | 'win32'>('linux');
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<SshRun | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api.sshInstall({
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        platform,
        ...(method === 'key' ? { privateKey, passphrase: passphrase || undefined } : { password }),
      });
      onDone(started.deployment);
      setRun(started.run);

      // The credential has been used; there is nothing to gain by keeping it in
      // a React state that a devtools panel can read.
      setPassword('');
      setPrivateKey('');
      setPassphrase('');

      let since = 0;
      let current = started.run;
      while (current.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const next = await api.run(started.run.id, since);
        since = next.logOffset;
        current = { ...next.run, log: [...current.log, ...next.run.log] };
        setRun(current);
      }
      if (current.status === 'done') onDone(started.deployment);
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        setError({ field: (cause as ApiRequestError & { field?: string }).field, message: cause.message });
      } else {
        setError({ message: cause instanceof Error ? cause.message : 'The install could not start.' });
      }
    } finally {
      setBusy(false);
    }
  };

  if (run) {
    return (
      <div className={shared.form}>
        <div className={styles.logHead}>
          <span>
            Installing on <strong>{run.host}</strong> —{' '}
            <span data-status={run.status}>{run.status === 'running' ? 'running…' : run.status}</span>
          </span>
        </div>
        {run.error ? (
          <div className={shared.notice} role="alert">
            {run.error}
          </div>
        ) : null}
        <LogLines lines={run.log} />
        {run.status !== 'running' ? (
          <div className={shared.formActions}>
            <button type="button" className={`${shared.action} ${shared.actionPrimary}`} onClick={onCancel}>
              Done
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <form className={shared.form} onSubmit={(event) => void submit(event)} aria-label="Deploy the agent over SSH">
      <p className={shared.blurb}>
        rippel connects once, runs the same installer the manual path would have pasted, and streams
        the output here. The credential is used for that one connection and never stored.
      </p>

      <div className={shared.formRow}>
        <label className={shared.field}>
          <span className="label">Name</span>
          <input
            className={shared.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="studio-4090"
            autoFocus
            required
          />
        </label>
        <label className={shared.field}>
          <span className="label">Operating system</span>
          <Dropdown
            className={shared.input}
            aria-label="Operating system"
            value={platform}
            options={PLATFORM_OPTIONS}
            onChange={(next) => setPlatform(next as typeof platform)}
          />
        </label>
      </div>

      <div className={shared.formRow}>
        <label className={shared.field}>
          <span className="label">Address</span>
          <input
            className={`mono ${shared.input}`}
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="192.168.1.50"
            required
          />
        </label>
        <label className={shared.field}>
          <span className="label">SSH port</span>
          <input
            className={`mono ${shared.input}`}
            value={port}
            onChange={(event) => setPort(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className={shared.field}>
          <span className="label">Username</span>
          <input
            className={shared.input}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="steve"
            required
          />
        </label>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Authentication">
        <button
          type="button"
          role="tab"
          aria-selected={method === 'password'}
          className={method === 'password' ? `${styles.tab} ${styles.tabOn}` : styles.tab}
          onClick={() => setMethod('password')}
        >
          Password
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === 'key'}
          className={method === 'key' ? `${styles.tab} ${styles.tabOn}` : styles.tab}
          onClick={() => setMethod('key')}
        >
          Private key
        </button>
      </div>

      {method === 'password' ? (
        <label className={shared.field}>
          <span className="label">Password</span>
          <input
            className={shared.input}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            required
          />
        </label>
      ) : (
        <>
          <label className={shared.field}>
            <span className="label">Private key</span>
            <textarea
              className={`mono ${shared.input} ${styles.keyBox}`}
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              spellCheck={false}
              required
            />
          </label>
          <label className={shared.field}>
            <span className="label">Key passphrase (if it has one)</span>
            <input
              className={shared.input}
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="off"
            />
          </label>
        </>
      )}

      <p className={styles.muted}>
        The account needs no root: the agent installs into its own home directory and runs as a user
        service. The agent itself is one static binary and needs nothing preinstalled — only ComfyUI
        does, so the installer checks for git and Python and says so before it downloads anything.
      </p>

      {error ? (
        <div className={shared.notice} role="alert">
          {error.message}
        </div>
      ) : null}

      <div className={shared.formActions}>
        <button type="button" className={shared.action} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={`${shared.action} ${shared.actionPrimary}`} disabled={busy}>
          {busy ? 'Connecting…' : 'Install the agent'}
        </button>
      </div>
    </form>
  );
}
