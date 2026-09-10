# rippel agent

One process per machine you want rippel to manage. It installs and updates
ComfyUI, starts and stops it, keeps the `comfyui-rippel-storage` helper in
place, and tells rippel what it finds.

A *backend* is an address rippel sends prompts to. A *deployment* is a machine
rippel can act on. This is the second one. They are separate: a ComfyUI you
started by hand is a backend with no agent, and a freshly installed agent is a
deployment with no ComfyUI yet.

**It is one file.** Not a folder, not an archive, not source alongside a
runtime — a single static executable, about 7 MB, with nothing beside it.
Downloading it is the download; opening it is the install.

## Installing it

Almost always: rippel → Settings → **Deployment**, then send whoever is at the
machine its **setup link**. It looks like this:

```
http://192.168.1.9:4000/api/deployments/setup/vT7kQ2...
```

They open it, click the button for their computer, and open the file that
downloads. That is the whole install — no terminal, no unzipping, nothing to
paste.

The trick that makes it one click is the **filename**. rippel already knows the
deployment's address and token when someone clicks Download, so it serves the
file as `rippel-agent-setup-<code>.exe`, where the code carries both. The agent
reads its own name on startup and needs nothing else. If a browser or a tidy
user renames the file, nothing breaks — it falls back to asking, which always
works. See `setup.go` for the three ways in, in the order they are tried.

For a machine nobody is sitting at, the Deployment screen also gives:

- **Deploy over SSH** — rippel connects once, runs the installer, streams the
  output back. The credential is used for that connection and never stored.
- **A one-line command** to paste. It downloads the binary and runs
  `rippel-agent install <setup link>`, which is exactly what a double-click
  does.

Both install the same thing the same way, because both end up inside the same
binary.

The agent, once run:

- checks with rippel that the token is real **before writing anything**, so a
  wrong or expired link is a sentence on screen rather than a service that
  installs perfectly and never appears
- warns if `git` or `python3` are missing (ComfyUI needs those, the agent does
  not)
- copies itself to `~/.rippel-agent/`, so the Downloads folder can be deleted
- writes `~/.rippel-agent/config.json`, mode 0600, holding the token
- registers a user service — systemd `--user` with lingering on Linux, a
  LaunchAgent on macOS, a Scheduled Task on Windows

Nothing needs root. The agent installs into its own home directory and runs as
whoever owns the ComfyUI checkout, which is what you want — a ComfyUI installed
by root is one you cannot maintain as yourself later.

Re-running it upgrades in place: the binary is replaced, the config kept, the
service restarted.

## Why Go

The previous agent was `.mjs` source shipped next to an 89 MB `node.exe`, with
250 lines of bash and PowerShell whose only job was to locate a runtime, fetch
six files one at a time and register a service. It failed twice on a Windows
machine, which is the machine this feature exists for.

Go cross-compiles to all four targets from any one of them with `GOOS` and
`GOARCH` alone — no C toolchain, no cgo, nothing installed with root — and
produces one static binary per target with no runtime beside it. That removes
the runtime, the archive, the unpacking step and most of the installer, which
between them were every step a non-technical person could fail.

## Building it

```bash
npm run build:release -w @comfy/agent      # all four, into apps/agent/dist
node scripts/build-release.mjs --only windows
GO=/opt/go/bin/go npm run build:release -w @comfy/agent
```

| Asset | For | Roughly |
| --- | --- | --- |
| `rippel-agent-windows-amd64.exe` | Windows x86-64 | 7.2 MB |
| `rippel-agent-macos-arm64` | Macs since 2020 | 6.6 MB |
| `rippel-agent-macos-amd64` | Intel Macs | 7.2 MB |
| `rippel-agent-linux-amd64` | Linux x86-64 | 7.0 MB |

macOS gets both architectures because Macs are genuinely still split, and the
install script picks by `uname -m`. Windows and Linux are x86-64 only: a ComfyUI
machine is an x86-64 box with a discrete GPU essentially without exception.

**The API serves these from `apps/agent/dist`**, so build them before building
the API image — `docker/api.Dockerfile` copies that directory in. A rippel with
no binaries on disk says so on the Deployment screen rather than offering links
that 404.

## Running it by hand

```
rippel-agent                     Set it up. This is what double-clicking does.
rippel-agent install <link>      Set it up with the link from rippel, no questions.
rippel-agent run                 Run in the foreground. This is what the service runs.
rippel-agent status              Say whether it is installed, and what it can see.
rippel-agent uninstall           Remove the service and the program. Keeps ComfyUI.
```

`status` is the one to reach for when somebody says "is it working?" — it
answers in sentences.

Settings come from `~/.rippel-agent/config.json`, and every one of them can be
overridden by an environment variable, which wins. That split is not decoration:
the installer writes the file (so a service unit needs no env block and the
token never lands in a shell history), while someone debugging overrides one
value on the command line.

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

`RIPPEL_AGENT_HOME` moves the whole directory, which is how the tests keep off
a real machine's `~`.

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

Unchanged from the previous agent — the wire format is a contract with
`apps/api/src/deploy` and was not part of this rewrite.

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
Treat it like an SSH key. The setup link contains it, so the link is a
credential too — that is why the setup page says so in as many words. If one
leaks, remove the deployment in rippel: the agent's next check-in fails, and
re-installing issues a new one.

Both the agent and the ComfyUI it manages are LAN software. ComfyUI has no
authentication of its own; keep both off the open internet.

## Tests

```bash
npm test -w @comfy/agent        # go test, wrapped so npm --workspaces finds it
```

There is a second suite on the API side, `apps/api/src/deploy/oneclick.test.ts`,
which downloads a binary through the real route and *executes it*. It guards the
one thing two languages have to agree on: the setup code rippel writes into a
filename and the agent reads back out. Nothing else in either suite would notice
if that drifted.
