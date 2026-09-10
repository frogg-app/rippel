# rippel agent

One process per machine you want rippel to manage. It installs and updates
ComfyUI, starts and stops it, keeps the `comfyui-rippel-storage` helper in
place, and tells rippel what it finds.

A *backend* is an address rippel sends prompts to. A *deployment* is a machine
rippel can act on. This is the second one. They are separate: a ComfyUI you
started by hand is a backend with no agent, and a freshly installed agent is a
deployment with no ComfyUI yet.

It has **no dependencies**. Node.js 20 or newer, and the files in `src/`. That
is deliberate — a release is a folder, and installing it is copying it.

The published releases go one step further and carry the Node runtime itself, so
a machine with nothing but the Python ComfyUI brought along can still install.
See [The bundled runtime](#the-bundled-runtime), which is also where the
obligation that comes with shipping someone a runtime is written down.

## Installing it

Almost always: rippel → Settings → **Deployment**, then either

- **Deploy over SSH** — rippel connects once, runs the installer, streams the
  output back. The credential is used for that connection and never stored.
- **Install by hand** — rippel gives you a one-line command carrying this
  machine's address and token, to paste on the target. Use this for Windows, for
  a box rippel cannot SSH to, or when you would rather read the script first
  (fetch the URL without `| bash` and it prints).

Both install exactly the same thing. The installer:

- finds a runtime: the `node/` folder in the unpacked release first, a system
  Node 20+ second, and copies whichever it used into `~/.rippel-agent/node/` so
  the service does not depend on a Downloads folder surviving
- warns if `git` or `python3` are missing (ComfyUI needs those, the agent does
  not)
- downloads `src/` from the rippel that will drive it — so the agent and the
  helper always match the server, which is the one version skew this whole
  panel exists to prevent
- writes `~/.rippel-agent/config.json`, mode 0600, holding the token
- registers a user service — systemd `--user` with lingering on Linux, a
  LaunchAgent on macOS, a Scheduled Task on Windows

Nothing needs root. The agent installs into its own home directory and runs as
whoever owns the ComfyUI checkout, which is what you want — a ComfyUI installed
by root is one you cannot maintain as yourself later.

Re-running the installer upgrades in place: files replaced, config kept, service
restarted.

## The bundled runtime

Each release asset contains an official Node.js build, taken unmodified from
`https://nodejs.org/dist/` and verified against that release's
`SHASUMS256.txt` at package time. Only the `node` binary ships — npm, the
headers and the docs are not part of what the agent runs.

| Asset | Runtime inside | Built for | Roughly |
| --- | --- | --- | --- |
| `rippel-agent-windows.zip` | `node\node.exe` | win-x64 | 34 MB |
| `rippel-agent-macos.tar.gz` | `node/bin/node-arm64`, `node/bin/node-x64` | osx-arm64 and osx-x64 | 76 MB |
| `rippel-agent-linux.tar.gz` | `node/bin/node` | linux-x64 | 43 MB |

macOS carries both architectures because Macs are genuinely still split and the
installer cannot know which one it will be unpacked on; it picks by `uname -m`
and copies only that one into `~/.rippel-agent`. Windows and Linux are x64 only:
a ComfyUI machine is an x64 box with a discrete GPU essentially without
exception, and on anything else the installer falls back to a system Node rather
than the release carrying runtimes nobody runs.

Build them from any machine — this is packaging, not compiling:

```bash
npm run build:release -w @comfy/agent          # all three, into apps/agent/dist
node apps/agent/scripts/build-release.mjs --only linux --node v24.21.0
```

### Keeping it patched

**Releases currently bundle Node v24.21.0** (the LTS line, Krypton).

Shipping a runtime means we are the ones responsible for the version on those
machines: nothing on a deployed box updates it, and the agent has no
auto-update. A Node security release is therefore a trigger to act here.

To act on one: bump `DEFAULT_NODE_VERSION` in
`apps/agent/scripts/build-release.mjs`, update the version in this section,
rebuild the assets, and cut a release. Existing deployments pick it up when the
operator re-runs the installer from the newly unpacked release — re-running is
already the documented upgrade path, and it overwrites
`~/.rippel-agent/node/bin/node` along with `src/`. An operator who installed
using a system Node is unaffected, because there is no bundled runtime on that
machine to patch.

Watch <https://nodejs.org/en/blog/vulnerability> for the announcements, and stay
on an LTS line — a runtime we ship should still be getting fixes for longer than
a deployment lives.

## Running it by hand

```bash
node src/main.mjs
```

Settings come from `~/.rippel-agent/config.json`, and every one of them can be
overridden by an environment variable, which wins. That split is not decoration:
the installer writes the file (so a service unit needs no env block and the token
never lands in a shell history), while someone debugging overrides one value on
the command line.

| config.json | Environment | Default | What it is |
| --- | --- | --- | --- |
| `token` | `RIPPEL_AGENT_TOKEN` | — | Shared secret. **Required**; the agent refuses to start without one. |
| `serverUrl` | `RIPPEL_SERVER_URL` | — | The rippel API. Blank disables check-in; rippel can still call in. |
| `deploymentId` | `RIPPEL_DEPLOYMENT_ID` | — | Learned from the first check-in if absent. |
| `port` | `RIPPEL_AGENT_PORT` | `8189` | Where the agent listens. |
| `host` | `RIPPEL_AGENT_HOST` | `0.0.0.0` | Interface to bind. |
| `comfyPath` | `RIPPEL_COMFY_PATH` | `~/.rippel-agent/ComfyUI` | Where ComfyUI is, or will be. |
| `comfyPort` | `RIPPEL_COMFY_PORT` | `8188` | Port the agent starts ComfyUI on. |
| `comfyArgs` | `RIPPEL_COMFY_ARGS` | — | Extra arguments for ComfyUI's command line. |
| `storageToken` | `RIPPEL_STORAGE_TOKEN` | — | Passed to ComfyUI's environment so the helper can read it. Set by rippel when it installs the helper. |
| `heartbeatSeconds` | `RIPPEL_HEARTBEAT_SECONDS` | `20` | Check-in interval. |

## What it does to a machine

**Installing ComfyUI** is the boring sequence everybody does by hand — `git
clone`, a venv beside it, `pip install torch`, `pip install -r
requirements.txt` — because the failure modes of that sequence are the ones
every ComfyUI answer on the internet is about. It is idempotent: an existing
checkout is updated and an existing venv reused, so re-running after a failure
picks up where it stopped.

The one part that is not boring is **which torch**. There is no single wheel
index that works everywhere, and the wrong one gets you a ComfyUI that starts,
loads a checkpoint, and faults on the first real kernel. The agent detects the
vendor (`nvidia-smi`, then `rocminfo`) and falls back to CPU wheels rather than
guessing CUDA, which is the common case and therefore the tempting wrong answer.

**Starting ComfyUI** spawns it detached, with `--listen 0.0.0.0` — the whole
point of a deployment is that rippel is on another machine — writing its output
to `~/.rippel-agent/comfyui.log` and its pid beside it. It outlives the agent, so
restarting the agent never takes the GPU down with it.

**Stopping** it is SIGTERM, then SIGKILL after ten seconds (`taskkill /T` on
Windows). If ComfyUI is answering on its port but the agent did not start it,
the agent refuses to stop it and says so.

## The HTTP API

Every route needs `X-Rippel-Agent-Token`, including the ping. There is no
harmless route here — knowing an agent is listening is already worth something
to a scanner — and the comparison is constant-time.

| Route | Purpose |
| --- | --- |
| `GET /agent/ping` | `{ ok, version, platform, hostname }` |
| `GET /agent/status` | The ping, plus the full ComfyUI state, the detected accelerator, and recent tasks |
| `GET /agent/tasks/:id?since=n` | A task's status and the log lines after `n` |
| `GET /agent/comfyui/log` | The tail of ComfyUI's own output |
| `POST /agent/comfyui/install` | Body `{ accelerator }` — `auto`, `cuda`, `rocm`, `cpu`. Returns 202 and a task |
| `POST /agent/comfyui/update` | `git pull` plus a dependency refresh. Returns 202 and a task |
| `POST /agent/comfyui/start\|stop\|restart` | Run control |
| `POST /agent/helper/install` | Body `{ files, storageToken }` — writes the helper into `custom_nodes` and restarts ComfyUI |
| `POST /agent/config` | Change `serverUrl`, `deploymentId`, `comfyPath`, `comfyArgs`, `comfyPort`, `heartbeatSeconds` |

The listening port and the token are deliberately **not** changeable over the
wire: one needs a restart to mean anything, and the other would let a stolen
token rotate itself and lock the operator out.

Long work returns `202` and a task id rather than holding the request open. An
install is minutes of pip output, and an HTTP client, a reverse proxy and a
laptop lid all disagree about how long is too long.

## The token

It lets whoever holds it install software on the machine and read its ComfyUI.
Treat it like an SSH key. If one leaks, remove the deployment in rippel — the
agent's next check-in fails, and re-running the installer issues a new one.

Both the agent and the ComfyUI it manages are LAN software. ComfyUI has no
authentication of its own; keep both off the open internet.

## Tests

```bash
npm test -w @comfy/agent
```

Plain `node --test`, because the agent's whole claim is that it runs on a bare
Node install — a suite that needed a runner from npm would quietly undermine it.
