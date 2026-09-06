#!/usr/bin/env node
/**
 * The rippel agent.
 *
 * One process per managed machine. It listens for rippel on a port and checks
 * in to rippel on a timer, and between those two it can install, update, start
 * and stop the ComfyUI on this box and keep the storage helper in place.
 *
 * Run it with `node src/main.mjs`, or through the service unit the install
 * script writes. It has no dependencies beyond Node 20, which is the point: a
 * release is a tarball, and installing it is unpacking it.
 */

import { hostname } from 'node:os';
import { AGENT_VERSION, loadConfig } from './config.mjs';
import { createAgentServer } from './server.mjs';
import { startHeartbeat } from './heartbeat.mjs';

function log(message) {
  process.stdout.write(`${new Date().toISOString()} rippel-agent ${message}\n`);
}

const config = loadConfig();

if (!config.token) {
  log(
    'refusing to start without a token. Put one in config.json (or RIPPEL_AGENT_TOKEN) — ' +
      'rippel shows it on the deployment you are installing.',
  );
  process.exit(1);
}

const heartbeat = startHeartbeat(config, log);
const server = createAgentServer(config, { onChange: () => heartbeat.now?.() });

server.listen(config.port, config.host, () => {
  log(`v${AGENT_VERSION} on ${hostname()} listening on ${config.host}:${config.port}`);
  log(`managing ComfyUI at ${config.comfyPath} (port ${config.comfyPort})`);
  if (config.serverUrl) log(`checking in to ${config.serverUrl} every ${config.heartbeatSeconds}s`);
});

server.on('error', (cause) => {
  log(`could not listen on ${config.host}:${config.port}: ${cause.message}`);
  process.exit(1);
});

const shutdown = (signal) => {
  log(`${signal} received, stopping`);
  heartbeat.stop?.();
  // ComfyUI is deliberately left running: it is a separate detached process and
  // an agent restart should never take the GPU down with it.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
