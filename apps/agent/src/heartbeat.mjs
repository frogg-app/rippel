/**
 * The agent telling rippel it is there.
 *
 * The direction matters. rippel also calls the agent — that is how installs
 * are triggered — but it cannot *discover* one: the machine may be on a
 * different subnet, behind NAT, on a laptop that moved, or simply not up yet
 * when rippel was. So the agent checks in, and rippel learns the address it
 * checked in from. An install script that only had to be told the server URL
 * and a token is the whole reason the manual path is two lines.
 *
 * Failures here are logged and forgotten. A deployment whose agent cannot
 * reach rippel is exactly the "offline" the panel is meant to show, and an
 * agent that crashed because the server was restarting would be worse than the
 * problem it reported.
 */

import { AGENT_VERSION } from './config.mjs';
import { comfyStatus } from './comfy.mjs';

export function startHeartbeat(config, log = console.log) {
  if (!config.serverUrl) {
    log('no serverUrl configured, so this agent will not check in; rippel can still call it');
    return () => {};
  }

  let timer = null;
  let stopped = false;
  let lastError = null;

  async function beat() {
    if (stopped) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let res;
      try {
        res = await fetch(`${config.serverUrl}/api/deployments/checkin`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Rippel-Agent-Token': config.token,
          },
          body: JSON.stringify({
            deploymentId: config.deploymentId || null,
            version: AGENT_VERSION,
            platform: config.platform,
            agentPort: config.port,
            comfy: await comfyStatus(config),
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`rippel answered ${res.status} ${detail.slice(0, 200)}`);
      }
      const payload = await res.json().catch(() => ({}));
      // rippel is the authority on which deployment this is; an agent installed
      // from a bare token learns its id here and remembers it.
      if (payload.deploymentId && payload.deploymentId !== config.deploymentId) {
        config.deploymentId = payload.deploymentId;
        const { saveConfig } = await import('./config.mjs');
        saveConfig({ deploymentId: payload.deploymentId });
        log(`enrolled as deployment ${payload.deploymentId}`);
      }
      if (lastError) {
        log('check-in recovered');
        lastError = null;
      }
    } catch (cause) {
      const message = String(cause.message ?? cause);
      // Say it once, not every twenty seconds, until it changes.
      if (message !== lastError) {
        log(`check-in failed: ${message}`);
        lastError = message;
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(beat, Math.max(5, config.heartbeatSeconds) * 1000);
        timer.unref?.();
      }
    }
  }

  void beat();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    /** Check in now, because something just changed. */
    now() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      void beat();
    },
  };
}
