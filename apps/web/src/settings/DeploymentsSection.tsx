import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  GpuHealth,
  GpuState,
  AgentPlatform,
  AgentProbe,
  AgentTask,
  Backend,
  Deployment,
  Engine,
  SdcppState,
  SshRun,
} from '@comfy/shared';
import { CheckIcon, ChipIcon, CopyIcon, DownloadIcon, DriveIcon, PlusIcon, RamIcon } from '../library/icons';
import { Mark } from '../components/Mark';
import { DeleteButton } from '../components/ConfirmDelete';
import { gb, memoryReading } from '../lib/format';
import { ApiRequestError } from '../lib/api';
import {
  deploymentsApi as defaultApi,
  type DeploymentsApi,
  type InstallInstructions,
  type PairingCode,
  withStatus,
} from '../lib/api-deployments';
import { refreshBackends, useBackends } from '../shell/useBackends';
import shared from './SettingsModal.module.css';
import { Dropdown } from '../components/Dropdown';
import styles from './DeploymentsSection.module.css';

/** The three platforms the agent installer knows how to reach. */
const PLATFORM_OPTIONS = [
  { value: 'linux', label: 'Linux' },
  { value: 'darwin', label: 'macOS' },
  { value: 'win32', label: 'Windows (OpenSSH)' },
];

/** Agent-managed machines shown to users as backends. */

const POLL_MS = 2000;

export function DeploymentsSection({ api = defaultApi }: { api?: DeploymentsApi }) {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | 'ssh' | 'manual' | 'command'>(null);
  const [installMethods, setInstallMethods] = useState<Record<string, 'manual' | 'command'>>({});
  const [toast, setToast] = useState<string | null>(null);
  const deploymentRevision = useRef(0);
  // Memory comes from the linked backend, which is what ComfyUI reports it to.
  const { backends } = useBackends();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const revision = deploymentRevision.current;
      try {
        const next = await api.list(signal);
        if (signal?.aborted || revision !== deploymentRevision.current) return;
        setDeployments(next);
        setFailed(null);
      } catch (cause) {
        if (signal?.aborted || revision !== deploymentRevision.current) return;
        setFailed(cause instanceof Error ? cause.message : 'Could not load backends.');
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
    deploymentRevision.current++;
    setDeployments((prev) =>
      [...(prev ?? []).filter((d) => d.id !== deployment.id), deployment].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
  };

  return (
    <div className={shared.section}>
      <p className={shared.blurb}>
        Your generation machines, managed by the rippel agent.
      </p>

      {failed ? (
        <div className={shared.notice} role="alert">
          {failed}
        </div>
      ) : null}

      {deployments === null && !failed ? (
        <div className={shared.loading} role="status">
          <Mark size={20} ripple="loop" />
          Loading backends…
        </div>
      ) : null}

      <ul className={shared.cards}>
        {(deployments ?? []).map((deployment, index) => (
          <DeploymentCard
            key={deployment.id}
            deployment={deployment}
            backend={backends.find((b) => b.id === deployment.backendId) ?? null}
            installMethod={installMethods[deployment.id] ?? 'manual'}
            index={index}
            api={api}
            onChange={(next) => {
              deploymentRevision.current++;
              setDeployments((prev) => (prev ?? []).map((d) => (d.id === next.id ? next : d)));
            }}
            onRemoved={() => {
              deploymentRevision.current++;
              setDeployments((prev) => (prev ?? []).filter((d) => d.id !== deployment.id));
            }}
            onError={setToast}
          />
        ))}
      </ul>

      {deployments !== null && deployments.length === 0 && !adding ? (
        <p className={shared.empty}>
          No backends yet. Install the rippel agent on a machine to get started.
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
      ) : adding === 'manual' || adding === 'command' ? (
        <ManualInstall
          method={adding}
          api={api}
          onCancel={() => setAdding(null)}
          onCreated={deployment => { setInstallMethods(previous => ({...previous, [deployment.id]: adding})); onCreated(deployment); }}
          onError={setToast}
        />
      ) : (
        <div className={styles.addRow}>
          <button type="button" className={`${shared.add} ${styles.preferredInstall}`} onClick={() => setAdding('command')}>
            <span aria-hidden>›_</span> Install with one command
          </button>
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
  backend,
  installMethod,
  index,
  api,
  onChange,
  onRemoved,
  onError,
}: {
  deployment: Deployment;
  backend: Backend | null;
  installMethod: 'manual' | 'command';
  index: number;
  api: DeploymentsApi;
  onChange: (next: Deployment) => void;
  onRemoved: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [task, setTask] = useState<AgentTask | null>(null);
  const [probe, setProbe] = useState<AgentProbe | null>(null);
  const [agentUpdate, setAgentUpdate] = useState<'updating' | 'reconnecting' | 'done' | null>(null);
  const updateController = useRef<AbortController | null>(null);
  useEffect(() => () => updateController.current?.abort(), []);
  // A machine that has never been heard from has exactly one useful next step,
  // so the panel holding it is already open rather than behind another click.
  const agentInstalled = Boolean(deployment.lastSeenAt || deployment.agentVersion || deployment.status === 'online');
  const [showInstall, setShowInstall] = useState(() => !agentInstalled);

  const comfy = deployment.comfy;
  // Which program this machine runs. Older agents never say, and run ComfyUI.
  const engine: Engine = deployment.engine ?? 'comfyui';
  const sdcpp = deployment.sdcpp ?? null;
  const supportsSdcpp = agentAtLeast(deployment.agentVersion, 0, 5);
  const engineInstalled = engine === 'sdcpp' ? Boolean(sdcpp?.installed) : Boolean(comfy?.installed);
  const engineRunning = engine === 'sdcpp' ? Boolean(sdcpp?.running) : Boolean(comfy?.running);
  const [vaeOnGpu, setVaeOnGpu] = useState(comfy?.vaeOnGpu ?? true);
  useEffect(() => { setVaeOnGpu(comfy?.vaeOnGpu ?? true); }, [comfy?.vaeOnGpu]);
  const [memory, setMemory] = useState<'auto' | 'ram'>(comfy?.memoryMode ?? 'auto');
  useEffect(() => { setMemory(comfy?.memoryMode ?? 'auto'); }, [comfy?.memoryMode]);
  const online = deployment.status === 'online';
  const backendStatus = online ? (engineRunning ? 'online' : 'warning') : deployment.status === 'pending' ? 'unknown' : 'offline';
  const backendLabel = online ? (engineRunning ? 'online' : engineInstalled ? 'Engine stopped' : 'Setup needed') : deployment.status === 'pending' ? 'waiting for the agent' : 'offline';

  /**
   * Why a control is refusing, in the words the card would use out loud.
   *
   * Every one of these buttons used to go simply grey, which answers nothing —
   * "Install ComfyUI" greyed out on a brand-new machine looks like a bug
   * rather than a machine that has not been set up yet.
   */
  const offlineReason = online
    ? null
    : agentInstalled
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
      onChange(withStatus(deployment, status));
    });

  const test = () =>
    act('test the agent', async () => {
      setProbe(null);
      const result = await api.probe(deployment.id);
      setProbe(result);
      if (!result.ok) {
        onChange({ ...deployment, status: 'offline' });
        return;
      }

      // A successful ping is already proof the agent is online. Show that
      // immediately, while its more detailed ComfyUI status is being read.
      const next: Deployment = {
        ...deployment,
        status: 'online',
        agentVersion: result.version ?? deployment.agentVersion,
        platform: result.platform ?? deployment.platform,
        lastSeenAt: new Date().toISOString(),
      };
      onChange(next);
      try {
        const status = await api.status(deployment.id);
        onChange(withStatus(next, status));
      } catch (cause) {
        const detail = cause instanceof Error ? ` ${cause.message}` : '';
        onError(`The agent answered, but its engine status could not be refreshed.${detail}`);
      }
    });

  const updateAgent = () =>
    act('update the agent', async () => {
      const controller = new AbortController();
      updateController.current = controller;
      const { signal } = controller;
      setAgentUpdate('updating');
      setProbe(null);
      // The old process can answer successfully while it is still staging the
      // binary. Only a vanished task followed by a live status proves restart.
      try {
        const started = await api.updateAgent(deployment.id);
        const deadline = Date.now() + 6 * 60_000;
        let current = started;
        let since = started.log.length;
        while (!signal.aborted && Date.now() < deadline) {
          if (current.status === 'failed') {
            throw new Error('Agent update failed. Please try again.');
          }
          if (current.status === 'done') setAgentUpdate('reconnecting');
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', finish);
              resolve();
            };
            const timer = setTimeout(finish, POLL_MS);
            signal.addEventListener('abort', finish, { once: true });
          });
          if (signal.aborted) return;
          let restarted = false;
          try {
            const next = await api.task(deployment.id, started.id, since);
            if (signal.aborted) return;
            since = next.logOffset;
            current = next.task;
          } catch (cause) {
            if (signal.aborted) return;
            if (cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403)) throw cause;
            restarted = cause instanceof ApiRequestError && cause.status === 404;
            setAgentUpdate('reconnecting');
          }
          if (!restarted) continue;
          try {
            const result = await api.probe(deployment.id);
            if (signal.aborted) return;
            if (!result.ok) continue;
            const status = await api.status(deployment.id);
            if (signal.aborted) return;
            onChange(withStatus({
              ...deployment,
              agentVersion: result.version ?? deployment.agentVersion,
              platform: result.platform ?? deployment.platform,
              lastSeenAt: new Date().toISOString(),
            }, status));
            setAgentUpdate('done');
            refreshBackends();
            return;
          } catch {
            // A fresh process may answer ping before its other routes settle.
          }
        }
        if (!signal.aborted) throw new Error('The agent has not reconnected yet. Check that the machine is awake.');
      } catch (cause) {
        if (signal.aborted) return;
        setAgentUpdate(null);
        throw cause;
      } finally {
        if (updateController.current === controller) updateController.current = null;
      }
    });

  const installSdcpp = () =>
    act('install stable-diffusion.cpp', async () => {
      await follow(await api.installSdcpp(deployment.id, 'auto'));
      const status = await api.status(deployment.id).catch(() => null);
      if (status) onChange(withStatus(deployment, status));
    });

  const powerSdcpp = (action: 'start' | 'stop' | 'restart') =>
    act(`${action} stable-diffusion.cpp`, async () => {
      await api.sdcppPower(deployment.id, action);
      // sd-server binds its port within a second or two; ComfyUI's wait is
      // longer because it imports torch first.
      await new Promise((resolve) => setTimeout(resolve, action === 'stop' ? 500 : 2500));
      const status = await api.status(deployment.id).catch(() => null);
      if (status) onChange(withStatus(deployment, status));
      refreshBackends();
    });

  const chooseEngine = (next: Engine) =>
    act('switch the engine', async () => {
      if (next === engine) return;
      onChange(await api.setEngine(deployment.id, next));
      refreshBackends();
    });

  const install = () =>
    act('install ComfyUI', async () => {
      await follow(await api.installComfy(deployment.id, 'auto'));
      const status = await api.status(deployment.id).catch(() => null);
      if (status) onChange(withStatus(deployment, status));
    });

  const applyMemory = () => act('apply memory settings', async () => {
    await follow(await api.setMemoryMode(deployment.id, memory));
    const status = await api.status(deployment.id);
    onChange(withStatus(deployment, status));
    refreshBackends();
  });

  const applyVAE = () => act('apply VAE settings', async () => {
    await follow(await api.setVaeOnGpu(deployment.id, vaeOnGpu));
    const status = await api.status(deployment.id);
    onChange(withStatus(deployment, status));
    refreshBackends();
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
      if (status) onChange(withStatus(deployment, status));
      refreshBackends();
    });

  const helper = () =>
    act('install the storage helper', async () => {
      await follow(await api.installHelper(deployment.id));
      const status = await api.status(deployment.id).catch(() => null);
      if (status) onChange(withStatus(deployment, status));
    });

  const repairGpu = () =>
    act('repair the GPU setup', async () => {
      await follow(await api.repairGpu(deployment.id));
      const status = await api.status(deployment.id).catch(() => null);
      if (status) onChange(withStatus(deployment, status));
      refreshBackends();
    });

  const register = () =>
    act('register the backend', async () => {
      const { deployment: next, adopted } = await api.registerBackend(deployment.id);
      onChange(next);
      refreshBackends();
      if (adopted) onError(`Linked to the existing backend "${next.backendName}".`);
    });

  // Not through act(): the confirm shows its own spinner and error.
  const remove = async () => {
    try {
      await api.remove(deployment.id);
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : 'Could not remove the backend.');
    }
    onRemoved();
    refreshBackends();
  };

  return (
    <li className={shared.card} style={{ '--i': index } as React.CSSProperties}>
      <div className={styles.backendLayout}>
      <div className={styles.backendDetails}>
      <div className={shared.cardMain}>
        <span className={shared.dot} data-status={backendStatus} aria-hidden />
        <div className={shared.cardText}>
          <div className={shared.cardName}>
            {deployment.name}
            <span className={shared.cardStatus} data-status={backendStatus}>
              {backendLabel}
            </span>
          </div>
          <div className={`mono ${shared.cardUrl}`}>
            {deployment.tunnelConnected ? 'Connected through agent tunnel' : deployment.agentUrl ?? `${deployment.host}:${deployment.agentPort}`}
          </div>
          <div className={shared.cardMeta}>
            <span>{online ? 'Agent online' : agentInstalled ? 'Agent offline' : 'Agent not connected'}</span>
            <span>{PLATFORM_LABEL[deployment.platform]}</span>
            {deployment.agentVersion ? <span className="mono">agent {deployment.agentVersion}</span> : null}
            <GpuPill health={comfy?.gpuHealth ?? null} />
          </div>
          <MachineResources backend={backend} diskFree={comfy?.diskFree ?? null} diskTotal={comfy?.diskTotal ?? null} />
        </div>
      </div>

      <NextAction deployment={deployment} />
      {supportsSdcpp ? (
        <div className={styles.engineRow}>
          <span className={styles.memoryLabel} id={`engine-${deployment.id}`}>Engine</span>
          <Dropdown
            value={engine}
            onChange={(value) => void chooseEngine(value as Engine)}
            disabled={!online || busy !== null}
            aria-labelledby={`engine-${deployment.id}`}
            menuWidth={300}
            options={[
              { value: 'comfyui', label: 'ComfyUI' },
              { value: 'sdcpp', label: 'stable-diffusion.cpp' },
            ]}
          />
          <p className={styles.memoryNote}>
            {engine === 'sdcpp'
              ? 'One small program, no Python. Loads one model at a time.'
              : 'The full node-graph server. Needs Python and several GB.'}
          </p>
        </div>
      ) : null}
      {engine === 'sdcpp' ? <SdcppSummary deployment={deployment} /> : <ComfySummary deployment={deployment} />}
      {engine === 'comfyui' && comfy?.installed ? (
        <div className={styles.memorySettings}>
          <div className={styles.computeSetting}>
            <label className={styles.memoryLabel} htmlFor={`memory-${deployment.id}`} title="Use more system RAM to help larger models fit; generation may be slower.">
              <input id={`memory-${deployment.id}`} type="checkbox" checked={memory === 'ram'}
                disabled={!comfy.memoryMode || !online || busy !== null}
                onChange={event => setMemory(event.target.checked ? 'ram' : 'auto')} /> Use system memory
            </label>
            <p className={styles.memoryNote}>{comfy.memoryMode ? 'Off by default · May be slower' : 'Update the agent to change memory usage.'}</p>
            <button className={shared.action} type="button" onClick={() => void applyMemory()}
              disabled={!comfy.memoryMode || !online || busy !== null || memory === comfy.memoryMode}>
              {busy === 'apply memory settings' ? 'Applying…' : comfy.running ? 'Apply memory and restart' : 'Apply memory'}
            </button>
          </div>
          <div className={styles.computeSetting}>
            <label className={styles.memoryLabel} htmlFor={`vae-${deployment.id}`} title="Run the image decoder (VAE) on the backend’s graphics card. Turn off to use its processor (CPU) instead.">
              <input id={`vae-${deployment.id}`} type="checkbox" checked={vaeOnGpu}
                disabled={typeof comfy.vaeOnGpu !== 'boolean' || !online || busy !== null}
                onChange={event => setVaeOnGpu(event.target.checked)} /> Decode images on the GPU (VAE)
            </label>
            <p className={styles.memoryNote}>{typeof comfy.vaeOnGpu === 'boolean' ? 'On by default · CPU when off' : 'Update the agent to choose where images are decoded.'}</p>
            <button className={shared.action} type="button" onClick={() => void applyVAE()}
              disabled={typeof comfy.vaeOnGpu !== 'boolean' || !online || busy !== null || vaeOnGpu === comfy.vaeOnGpu}>
              {busy === 'apply VAE settings' ? 'Applying…' : comfy.running ? 'Apply decoder setting and restart' : 'Apply decoder setting'}
            </button>
          </div>
          {busy === 'apply memory settings' || busy === 'apply VAE settings' ? <div className={shared.loading} role="status"><Mark size={16} ripple="loop" />Applying backend settings…</div> : null}
        </div>
      ) : null}
      {agentUpdate ? (
        <div className={shared.loading} role="status" aria-live="polite">
          {agentUpdate !== 'done' ? <Mark size={16} ripple="loop" /> : <CheckIcon size={16} />}
          {agentUpdate === 'updating' ? 'Updating agent…' : agentUpdate === 'reconnecting' ? 'Reconnecting…' : 'Agent updated.'}
        </div>
      ) : null}

      </div>
      <div className={styles.backendActions} aria-label={`Actions for ${deployment.name}`}>
        <ReasonedButton className={shared.action} reason={busyReason ?? offlineReason}
          onClick={() => void updateAgent()}>
          Update agent
        </ReasonedButton>
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

        {engine === 'sdcpp' ? (
          sdcpp?.installed ? (
            <>
              <ReasonedButton
                className={shared.action}
                reason={busyReason ?? offlineReason}
                onClick={() => void powerSdcpp(sdcpp.running ? 'restart' : 'start')}
              >
                {busy?.endsWith('stable-diffusion.cpp') && busy.startsWith(sdcpp.running ? 'restart' : 'start')
                  ? 'Working…'
                  : sdcpp.running
                    ? 'Restart engine'
                    : 'Start engine'}
              </ReasonedButton>
              {sdcpp.running ? (
                <ReasonedButton className={shared.action} reason={busyReason} onClick={() => void powerSdcpp('stop')}>
                  Stop
                </ReasonedButton>
              ) : null}
              <ReasonedButton
                className={shared.action}
                reason={busyReason ?? offlineReason ?? (sdcpp.running ? 'Stop the engine before updating it.' : null)}
                onClick={() => void installSdcpp()}
              >
                {busy === 'install stable-diffusion.cpp' ? 'Updating…' : 'Update engine'}
              </ReasonedButton>
            </>
          ) : (
            <ReasonedButton
              className={`${shared.action} ${shared.actionPrimary}`}
              reason={busyReason ?? offlineReason}
              onClick={() => void installSdcpp()}
            >
              {busy === 'install stable-diffusion.cpp' ? 'Installing…' : 'Install engine'}
            </ReasonedButton>
          )
        ) : comfy?.installed ? (
          <>
            <ReasonedButton
              className={shared.action}
              reason={busyReason ?? offlineReason}
              onClick={() => void power(comfy.running ? 'restart' : 'start')}
            >
              {busy?.endsWith('ComfyUI') && busy.startsWith(comfy.running ? 'restart' : 'start')
                ? 'Working…'
                : comfy.running
                  ? 'Restart engine'
                  : 'Start engine'}
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
              {busy === 'update ComfyUI' ? 'Updating…' : 'Update engine'}
            </ReasonedButton>
          </>
        ) : (
          <ReasonedButton
            className={`${shared.action} ${shared.actionPrimary}`}
            reason={busyReason ?? offlineReason}
            onClick={() => void install()}
          >
            {busy === 'install ComfyUI' ? 'Installing…' : 'Install engine'}
          </ReasonedButton>
        )}

        {engine === 'comfyui' && comfy?.installed && (comfy.gpuHealth?.state === 'unsupported' || comfy.gpuHealth?.state === 'cpu') ? (
          <ReasonedButton
            className={`${shared.action} ${shared.actionPrimary}`}
            reason={busyReason ?? offlineReason}
            onClick={() => void repairGpu()}
          >
            {busy === 'repair the GPU setup' ? 'Repairing…' : 'Repair GPU setup'}
          </ReasonedButton>
        ) : null}

        {engine === 'comfyui' && comfy?.installed && (!comfy.helperInstalled || (comfy.running && !comfy.helperReady)) ? (
          <ReasonedButton
            className={shared.action}
            reason={busyReason ?? offlineReason}
            onClick={() => void helper()}
          >
            {busy === 'install the storage helper' ? 'Installing…' : 'Enable file access'}
          </ReasonedButton>
        ) : null}

        {engineInstalled && !deployment.backendId ? (
          <ReasonedButton
            className={`${shared.action} ${shared.actionPrimary}`}
            reason={busyReason ?? offlineReason}
            onClick={() => void register()}
          >
            {busy === 'register the backend' ? 'Enabling…' : 'Enable generation'}
          </ReasonedButton>
        ) : null}

        {!agentInstalled ? (
          <button type="button" className={shared.action} onClick={() => setShowInstall((v) => !v)}>
            {showInstall ? 'Hide install options' : 'Install Agent'}
          </button>
        ) : (
          // For a reinstalled or moved agent: a new code hands it this same
          // machine, so its backend, models and history stay as they are.
          <button type="button" className={shared.action} onClick={() => setShowInstall((v) => !v)} aria-expanded={showInstall}>
            {showInstall ? 'Cancel re-pair' : 'Re-pair'}
          </button>
        )}

      </div>

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

      {showInstall ? (
        <InstallInstructionsPanel api={api} deployment={deployment} method={agentInstalled ? 'manual' : installMethod} repair={agentInstalled} />
      ) : null}
      {task ? <TaskLog task={task} onDismiss={() => setTask(null)} /> : null}
      <footer className={styles.cardFooter}>
        <DeleteButton
          size="md"
          disabled={busy !== null}
          aria-label={`Remove ${deployment.name}`}
          confirmTitle="Remove this backend?"
          confirmBody={
            <>
              <strong>{deployment.name}</strong> will be disconnected from rippel. Its files stay on the machine.
            </>
          }
          confirmLabel="Remove"
          busyLabel="Removing…"
          onConfirm={remove}
        />
      </footer>
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
  const comfy = deployment.engine === 'sdcpp' ? deployment.sdcpp : deployment.comfy;
  const neverSeen = !deployment.lastSeenAt && !deployment.agentVersion && deployment.status !== 'online';

  if (neverSeen) {
    return (
      <p className={`${styles.next} ${styles.nextWaiting}`}>
        <span className={styles.nextText}>
          <strong>Waiting for the agent to check in.</strong> Install the agent on this machine to continue.
        </span>
      </p>
    );
  }
  if (deployment.status !== 'online') {
    return (
      <p className={`${styles.next} ${styles.nextWaiting}`}>
        <span className={styles.nextText}>
          <strong>The agent has stopped answering.</strong> Wake the machine, then press <strong>Test</strong>.
        </span>
      </p>
    );
  }
  if (comfy && !comfy.installed) {
    return (
      <p className={`${styles.next} ${styles.nextReady}`}>
        <span className={styles.nextText}>
          <strong>The agent is running.</strong> Choose <strong>Install engine</strong> to set up generation.
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
      <p className={`${styles.summary} ${styles.summaryEmpty}`}>
        Machine details will appear when the agent connects.
      </p>
    );
  }
  return (
    <dl className={styles.summary}>
      <div>
        <dt>Generation engine</dt>
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
        <dt>File access</dt>
        <dd>
          {/* The helper lives inside ComfyUI, so it can only answer while the
              engine runs: installed and stopped is fine, not a fault. */}
          <span data-state={comfy.helperReady || (comfy.helperInstalled && !comfy.running) ? 'on' : comfy.helperInstalled ? 'warn' : 'off'} className={styles.pip} />
          {comfy.helperReady
            ? 'ready'
            : comfy.helperInstalled
              ? comfy.running ? 'restart engine to enable' : 'ready when the engine starts'
              : 'setting up…'}
        </dd>
      </div>
      <div>
        <dt>Generation</dt>
        <dd>
          {deployment.backendId ? (
            <>
              <span data-state="on" className={styles.pip} />
              Enabled
            </>
          ) : (
            'Not enabled'
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

/** The stable-diffusion.cpp on that machine, one line per fact worth knowing. */
function SdcppSummary({ deployment }: { deployment: Deployment }) {
  const sdcpp: SdcppState | null = deployment.sdcpp ?? null;
  if (!sdcpp) {
    return (
      <p className={`${styles.summary} ${styles.summaryEmpty}`}>
        Machine details will appear when the agent connects.
      </p>
    );
  }
  const model = sdcpp.model;
  const loaded = model && model.state !== 'empty'
    ? model.state === 'loading'
      ? 'loading…'
      : model.state === 'error'
        ? `failed to load${model.error ? `: ${model.error}` : ''}`
        : `${model.recipe ?? 'a model'}${model.models ? ` · ${Object.values(model.models).map((id) => id.split('/').pop()).join(', ')}` : ''}`
    : 'none loaded';
  return (
    <dl className={styles.summary}>
      <div>
        <dt>Generation engine</dt>
        <dd>
          {sdcpp.installed ? (
            <>
              <span data-state={sdcpp.running ? 'on' : 'off'} className={styles.pip} />
              {sdcpp.running ? 'running' : 'installed, stopped'}
              <span className="mono"> · stable-diffusion.cpp</span>
              {sdcpp.build ? <span className="mono"> · {sdcpp.build}</span> : null}
              {sdcpp.version ? <span className="mono"> · {sdcpp.version}</span> : null}
            </>
          ) : (
            'not installed'
          )}
        </dd>
      </div>
      {sdcpp.running ? (
        <div>
          <dt>Model</dt>
          <dd>
            <span data-state={model?.state === 'ready' ? 'on' : model?.state === 'error' ? 'warn' : 'off'} className={styles.pip} />
            {loaded}
          </dd>
        </div>
      ) : null}
      <div>
        <dt>Generation</dt>
        <dd>
          {deployment.backendId ? (
            <>
              <span data-state="on" className={styles.pip} />
              Enabled
            </>
          ) : (
            'Not enabled'
          )}
        </dd>
      </div>
      {sdcpp.path ? (
        <div>
          <dt>Path</dt>
          <dd className="mono">{sdcpp.path}</dd>
        </div>
      ) : null}
      {sdcpp.modelDirs?.length ? (
        <div>
          <dt>Models</dt>
          <dd className="mono">{sdcpp.modelDirs.join(' · ')}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Whether an agent version string is at least major.minor. Unknown is not. */
export function agentAtLeast(version: string | null | undefined, major: number, minor: number): boolean {
  if (!version) return false;
  const [a, b] = version.split('.').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a! > major || (a === major && b! >= minor);
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

function CopyField({
  label,
  value,
  big,
  meta,
}: {
  label: string;
  value: string;
  /** The pairing code is meant to be read off the screen and typed. */
  big?: boolean;
  /** A line under the field — an expiry, a way to get another one. */
  meta?: ReactNode;
}) {
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
        <code className={big ? `mono ${styles.code} ${styles.codeBig}` : `mono ${styles.code}`}>{value}</code>
        <button type="button" className={shared.action} onClick={() => void copy()} aria-label={`Copy ${label}`}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {meta ? <p className={styles.codeMeta}>{meta}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- pairing

/** Minutes and seconds, for a code that is only good for a few of them. */
function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The one-time code, with the lifecycle it actually has.
 *
 * A code is single-use and expires in minutes, so leaving one on screen
 * looking valid is the failure worth designing against: it runs down visibly,
 * says plainly when it is spent or stale, and getting another is one press.
 * Issuing a new one invalidates the old one, which is why "New code" is a
 * deliberate button rather than something that happens on every render.
 */
function PairingPanel({
  api,
  deployment,
  platform,
  issueNow = false,
}: {
  api: DeploymentsApi;
  deployment: Deployment;
  /** Chosen by the tabs above, so the command matches what they say. */
  platform: 'linux' | 'darwin' | 'win32';
  /** Issue a code straight away, even for a machine that has checked in. */
  issueNow?: boolean;
}) {
  type State =
    | { kind: 'loading' }
    | { kind: 'ready'; code: PairingCode }
    | { kind: 'unsupported' }
    | { kind: 'error'; message: string };

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  // A machine that has checked in has already redeemed a code; showing it
  // another by default would be offering a solution to a solved problem.
  const [paired, setPaired] = useState(() => !issueNow && Boolean(deployment.lastSeenAt));

  const issue = useCallback(
    async (signal?: AbortSignal) => {
      setState({ kind: 'loading' });
      try {
        const code = await api.pairingCode(deployment.id, signal);
        setNow(Date.now());
        setState({ kind: 'ready', code });
      } catch (cause) {
        if (signal?.aborted) return;
        // The route is still being built. A rippel without it should lose the
        // code and keep the download and the command line, not break.
        if (cause instanceof ApiRequestError && cause.status === 404) {
          setState({ kind: 'unsupported' });
          return;
        }
        setState({
          kind: 'error',
          message: cause instanceof Error ? cause.message : 'Could not get a pairing code.',
        });
      }
    },
    [api, deployment.id],
  );

  useEffect(() => {
    if (paired) return;
    const controller = new AbortController();
    void issue(controller.signal);
    return () => controller.abort();
  }, [issue, paired]);

  // Tick only while a live code is on screen — an expired one has nothing left
  // to count, and every other state is static.
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.kind]);

  const fresh = (
    <button type="button" className={styles.linkButton} onClick={() => void issue()}>
      New code
    </button>
  );

  if (paired) {
    return (
      <p className={styles.stepNote}>
        <strong>{deployment.name} is paired.</strong>{' '}
        {/* Dropping the paired flag is what asks for a code: the effect above
            issues one as soon as there is a reason to have it. */}
        <button type="button" className={styles.linkButton} onClick={() => setPaired(false)}>
          New code
        </button>{' '}
        to pair it again after a reinstall.
      </p>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className={shared.loading} role="status">
        <Mark size={16} ripple="loop" />
        Getting a code…
      </div>
    );
  }
  if (state.kind === 'unsupported') {
    return (
      <p className={styles.stepNote}>
        This rippel cannot issue pairing codes yet. Use the command line below.
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className={shared.notice} role="alert">
        {state.message} {fresh}
      </div>
    );
  }

  const left = new Date(state.code.expiresAt).getTime() - now;
  if (left <= 0) {
    return (
      <p className={`${styles.stepNote} ${styles.codeDead}`} role="status">
        That code expired. {fresh}
      </p>
    );
  }

  return (
    <>
      <CopyField
        label="Pairing code"
        value={state.code.code}
        big
        meta={
          <>
            Expires in <span className="mono">{countdown(left)}</span>, and works once. {fresh}
          </>
        }
      />
      {/* The one-liner carries this code, so it lives beside it and dies with
          it. Keeping it on the install payload would have meant a polled GET
          handing out a credential every few seconds. */}
      {platform === 'win32' ? (
        <>
          <CopyField label="Or run this in PowerShell" value={state.code.commands.win32} />
          <CopyField label="Or in Command Prompt" value={state.code.commands.win32Cmd} />
        </>
      ) : (
        <CopyField
          label="Or run this on that machine"
          value={state.code.commands[platform]}
        />
      )}
    </>
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

function InstallInstructionsPanel({
  api,
  deployment,
  method,
  repair = false,
}: {
  api: DeploymentsApi;
  deployment: Deployment;
  method: 'manual' | 'command';
  /** Pairing an agent again to a machine rippel already knows. */
  repair?: boolean;
}) {
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
  const chosen = data.binaries.find((d) => d.target === target) ?? data.binaries[0] ?? null;
  const others = data.binaries.filter((d) => d.target !== chosen?.target);

  return (
    <div className={styles.panel}>
      {/* ------------------------------------------------ download, then pair */}
      {method === 'manual' && <div className={`${styles.step} ${styles.stepLead}`}>
        <div className={styles.stepHead}>
          <h4 className={styles.stepTitle}>{repair ? `Pair ${deployment.name} again` : `Set up ${deployment.name}`}</h4>
        </div>
        <p className={styles.stepNote}>
          {repair
            ? 'Run one of the commands below on the machine, or give the agent these two. It becomes this same machine again, with its models and history; the code works once.'
            : 'Download the agent, run it, and give it these two.'}
        </p>
        {chosen ? (
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
        ) : null}
        <CopyField label="Server URL" value={data.serverUrl} />
        <PairingPanel
          api={api}
          deployment={deployment}
          platform={platform === 'unknown' ? 'linux' : platform}
          issueNow={repair}
        />
      </div>}

      {/* ------------------------------------------------ the command line */}
      {method === 'command' && <div className={styles.step}>
        <h4 className={styles.stepTitle}>Install on {deployment.name}</h4>
        <p className={styles.stepNote}>
          For a machine nobody is sitting at. Run it on <strong>{deployment.name}</strong> as the
          account that should own the ComfyUI install; re-running it upgrades in place.
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

        <PairingPanel api={api} deployment={deployment} platform={platform === 'unknown' ? 'linux' : platform} />

        {plaintextToPublicHost(data.serverUrl) ? (
          <p className={styles.warn}>
            That address is plain <code className="mono">http</code> on a public host, and this
            command carries a pairing code. Anything on the path between the two
            machines can read it. Reach rippel over https before running this, or install over SSH
            instead.
          </p>
        ) : null}
      </div>}

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
  method,
  api,
  onCancel,
  onCreated,
  onError,
}: {
  method: 'manual' | 'command';
  api: DeploymentsApi;
  onCancel: () => void;
  onCreated: (deployment: Deployment) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [created, setCreated] = useState<Deployment | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const deployment = await api.create({ name: name.trim(), host: 'pending' });
      onCreated(deployment);
      setCreated(deployment);
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        setError({ field: (cause as ApiRequestError & { field?: string }).field, message: cause.message });
      } else {
        onError(cause instanceof Error ? cause.message : 'Could not add the backend.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    // The machine now has a card of its own, and because it has never checked
    // in that card already has the download and a pairing code open on it.
    // Repeating the whole panel here would be the same thing twice on one
    // screen — so this just says where it went.
    return (
      <div className={shared.form}>
        <p className={shared.blurb}>
          <strong>{created.name}</strong> is registered. Its card above has {method === 'command' ? 'the install command' : 'the download and pairing code'}.
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
    <form className={shared.form} onSubmit={(event) => void submit(event)} aria-label={method === 'command' ? 'Install with one command' : 'Install the agent by hand'}>
      <p className={shared.blurb}>
        Register the machine first, then run the agent. It connects back to rippel; remote machines need no inbound ports.
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
          {busy ? 'Registering…' : method === 'command' ? 'Register and show the command' : 'Register and show downloads'}
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

/**
 * GPU memory, system RAM and disk, each with an icon saying which it is. GPU
 * and RAM matter most for what a machine can run, so they come first; GPU uses
 * `memoryReading`, which knows the reported figure is a budget, not the card.
 */
function MachineResources({
  backend,
  diskFree,
  diskTotal,
}: {
  backend: Backend | null;
  diskFree: number | null;
  diskTotal: number | null;
}) {
  const vram = backend ? memoryReading(backend) : null;
  const ram = backend?.ramTotal ? backend : null;
  if (!vram && !ram && !diskTotal) return null;
  return (
    <div className={styles.resources}>
      {vram ? (
        <span className={styles.resource} title={vram.title}>
          <ChipIcon size={13} />
          <span className="mono">{vram.text}</span>
          <span>GPU</span>
        </span>
      ) : null}
      {ram?.ramTotal ? (
        <span className={styles.resource} title="System memory in use, of the machine's total.">
          <RamIcon size={13} />
          <span className="mono">
            {ram.ramFree === null ? `${gb(ram.ramTotal)} GB` : `${gb(Math.max(0, ram.ramTotal - ram.ramFree))}/${gb(ram.ramTotal)} GB`}
          </span>
          <span>RAM</span>
        </span>
      ) : null}
      {diskTotal ? (
        <span className={styles.resource} title="Space in use on the drive ComfyUI is installed on, of the drive's total.">
          <DriveIcon size={13} />
          <span className="mono">
            {diskFree == null ? `${gb(diskTotal)} GB` : `${gb(Math.max(0, diskTotal - diskFree))}/${gb(diskTotal)} GB`}
          </span>
          <span>disk</span>
        </span>
      ) : null}
    </div>
  );
}

const GPU_PILL: Record<GpuState, string> = {
  ready: 'GPU ready',
  unsupported: 'GPU not supported by this build',
  cpu: 'Running on CPU',
  checking: 'Checking GPU…',
};

/** The agent's GPU test, in a word; the device and the raw error in the tooltip. */
export function GpuPill({ health }: { health: GpuHealth | null }) {
  if (!health) return null;
  const tip = [health.device && `${health.device}${health.arch ? ` (${health.arch})` : ''}`, health.torch && `torch ${health.torch}`, health.detail]
    .filter(Boolean).join('\n');
  return <span data-gpu={health.state} title={tip || undefined}>{GPU_PILL[health.state]}</span>;
}
