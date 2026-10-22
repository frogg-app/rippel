/**
 * "This PC's graphics card isn't set up correctly." — one line, for a job that
 * failed with a kernel/arch mismatch and for Generate when the machine's own
 * GPU test failed. Admins get Repair, which asks the agent to re-test and
 * swap torch builds; everybody else is told who can.
 */
import { useState } from 'react';
import type { Backend } from '@comfy/shared';
import { useAuth } from '../auth/context';
import { deploymentsApi } from '../lib/api-deployments';
import { refreshBackends } from '../shell/useBackends';

export const GPU_SETUP_LINE = 'This PC’s graphics card isn’t set up correctly.';

/** Whether Generate should stop before sending: the target machine failed its GPU test. */
export function gpuBlocked(backends: Backend[], targetId: string | null): Backend | null {
  const usable = backends.filter((b) => b.enabled && b.status === 'online');
  if (targetId) {
    const target = usable.find((b) => b.id === targetId);
    return target?.gpuState === 'unsupported' ? target : null;
  }
  // Routed automatically: only block when no machine could take it.
  return usable.length > 0 && usable.every((b) => b.gpuState === 'unsupported') ? usable[0]! : null;
}

export function GpuSetupLine({ deploymentId, repairGpu = deploymentsApi.repairGpu }: {
  deploymentId: string | null | undefined;
  repairGpu?: (id: string) => Promise<unknown>;
}) {
  const { user } = useAuth();
  const [state, setState] = useState<'idle' | 'busy' | 'started' | 'failed'>('idle');
  const admin = user?.role === 'admin';
  const repair = async () => {
    if (!deploymentId) return;
    setState('busy');
    try {
      await repairGpu(deploymentId);
      setState('started');
      refreshBackends();
    } catch {
      setState('failed');
    }
  };
  return (
    <span>
      {GPU_SETUP_LINE}{' '}
      {admin && deploymentId ? (
        state === 'started' ? <span role="status">Repairing…</span> : (
          <button type="button" className="linkButton" disabled={state === 'busy'} onClick={() => void repair()}
            title={state === 'failed' ? 'The machine didn’t answer. Try again, or use Settings › Deployments.' : 'Re-test the graphics card and reinstall the build that fits it.'}>
            {state === 'failed' ? 'Retry repair' : 'Repair'}
          </button>
        )
      ) : (
        <span>Ask an admin to repair this PC.</span>
      )}
    </span>
  );
}
