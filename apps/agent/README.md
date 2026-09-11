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

It is also the **same file for everybody**. There is no per-rippel or
per-machine build: `rippel-agent-windows-amd64.exe` is the same bytes wherever
it came from, which is what lets it be cached, mirrored, or copied onto a box on
a USB stick.

## Installing it

Download the agent and open it. It asks two questions:

```
  What is rippel's address? It looks like http://192.168.1.9:4000

  Address: http://192.168.1.9:4000

  What is the pairing code? It is 8 characters, like K7QM4XTB.
  A code works once and expires after a few minutes.

  Code: K7QM4XTB
```

Both come from rippel: **Settings → Deployment**, then the machine being set up.
Both prompts take a paste.

**It never asks for a deployment id.** The id comes back from redeeming the
code, and is written into the config — anything a person has to copy correctly
is a place the setup fails.

For a machine nobody is sitting at, the Deployment screen also gives:

- **Deploy over SSH** — rippel connects once, runs the installer, streams the
  output back. The credential is used for that connection and never stored.
- **A one-line command** to paste. It downloads the binary and runs
  `rippel-agent install --server <url> --code <code>`, which is exactly what
  answering the two questions does.

Both install the same thing the same way, because both end up inside the same
binary.

### The pairing code

Eight characters from an alphabet with **no `O` or `0`, and no `I`, `1` or `L`**
— the pairs people actually confuse are simply not in it, in either direction,
so there is nothing to get wrong when a code is read over a phone. Case does not
matter, and dashes or spaces someone added are ignored.

A code:

- works **once**. A second machine trying the same code is refused.
- lasts **minutes, not days**.
- is **replaced** when a new one is issued for that machine, so a code read
  aloud in a meeting cannot be used tomorrow.
- is spent whether or not the install that follows it succeeds. If an install
  fails, ask for a new code rather than retrying the old one.

It is a credential while it lives: whoever has it can enrol a machine and
receive that deployment's long-lived token. rippel stores only a hash of it, so
nobody can recover a code after the fact — including whoever issued it.

The agent, once run:

- redeems the code with rippel **before writing anything**, so a wrong address
  or a stale code is a sentence on screen rather than a service that installs
  perfectly and never appears
- undoes what it created if a later step fails, so a failed install leaves the
  machine as it found it rather than half-configured
- warns if `git` or `python3` are missing (ComfyUI needs those, the agent does
  not)
- copies itself to `~/.rippel-agent/`, so the Downloads folder can be deleted
- writes `~/.rippel-agent/config.json`, mode 0600, holding the token
- registers a **per-user** startup entry — systemd `--user` with lingering on
  Linux, a LaunchAgent on macOS, and on Windows the per-user `Run` key

Nothing needs root, and **nothing needs Administrator on Windows**. See below.

Re-running it upgrades in place: the binary is replaced, the config kept, the
startup entry re-registered. Re-running on a machine that is already set up does
not need a new pairing code — it already has its credentials.

## Starting automatically, without Administrator

This is the one part worth reading before changing.

The agent used to register a **Scheduled Task** (`schtasks /Create`). On a real
Windows machine that answered:

```
ERROR: Access is denied.
```

— *after* the agent had copied itself and written its config, so the install
half succeeded, which is worse than failing outright. Creating a scheduled task
can require elevation depending on how a machine is configured, and asking
somebody setting up their own GPU box to find an elevated prompt is exactly the
step this feature exists to remove.

So on Windows the agent now writes a value under:

```
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run
```

This is the per-user Run key. Microsoft documents both the `HKEY_CURRENT_USER`
and `HKEY_LOCAL_MACHINE` variants ([Run and RunOnce Registry
Keys](https://learn.microsoft.com/windows/win32/setupapi/run-and-runonce-registry-keys));
the `HKLM` ones are machine-wide and need administrator rights, while the `HKCU`
ones are the user's own registry hive and do not. `reg.exe` does the writing,
for the same reason the old code used `schtasks.exe`: it is on every Windows, it
needs no execution policy, and its failures are readable lines of text.

If that fails, the agent falls back to a `rippel-agent.cmd` in the per-user
**Startup folder** (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`),
which Explorer runs at logon — an ordinary file in the user's own roaming
profile. A `.cmd` rather than a shortcut, because writing a `.lnk` means COM and
`IShellLink`, and a text file needs neither.

If **both** fail, the agent does not pretend otherwise. It prints what worked
(paired, installed, configured — naming the paths), what did not, and the exact
`reg add` line to run by hand, plus the `shell:startup` route for anyone who
would rather drag a shortcut. The machine is left installed and usable, because
deleting a working agent over a startup entry would be the wrong trade.

Both mechanisms are removed by `rippel-agent uninstall`, along with a scheduled
task left behind by an older version.

Neither Windows branch can be executed on the Linux box this is built from. What
is tested is the command line built for `reg.exe` — that it names `HKCU` and not
`HKLM`, and that a path with a space in it stays quoted — and the text of the
`.cmd`.

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

**The API serves these from `apps/agent/dist`**, at
`/api/deployments/agent/<target>` — one URL per platform, no deployment in it
and no token on it. Build them before building the API image;
`docker/api.Dockerfile` copies that directory in. A rippel with no binaries on
disk says so on the Deployment screen rather than offering links that 404.

## Running it by hand

```
rippel-agent                     Set it up. This is what double-clicking does.
rippel-agent --server <url> --code <code>
                                 Set it up without being asked anything.
rippel-agent install --server <url> --code <code>
                                 The same thing, spelled out.
rippel-agent run                 Run in the foreground. This is what the service runs.
rippel-agent status              Say whether it is installed, and what it can see.
rippel-agent uninstall           Remove the startup entry and the program. Keeps ComfyUI.
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
| `deploymentId` | `RIPPEL_DEPLOYMENT_ID` | — | Written by pairing; rippel may correct it on check-in. |
| `port` | `RIPPEL_AGENT_PORT` | `8189` | Where the agent listens. |
| `host` | `RIPPEL_AGENT_HOST` | `0.0.0.0` | Interface to bind. |
| `comfyPath` | `RIPPEL_COMFY_PATH` | `~/.rippel-agent/ComfyUI` | Where ComfyUI is, or will be. |
| `comfyPort` | `RIPPEL_COMFY_PORT` | `8188` | Port the agent starts ComfyUI on. |
| `comfyArgs` | `RIPPEL_COMFY_ARGS` | — | Extra arguments for ComfyUI's command line. |
| `storageToken` | `RIPPEL_STORAGE_TOKEN` | — | Passed to ComfyUI's environment so the helper can read it. Set by rippel when it installs the helper. |
| `heartbeatSeconds` | `RIPPEL_HEARTBEAT_SECONDS` | `20` | Check-in interval. |

`RIPPEL_AGENT_HOME` moves the whole directory, which is how the tests keep off
a real machine's `~`. `RIPPEL_SKIP_SERVICE=1` installs everything except the
startup entry, for an image that supervises the agent itself — and for this
repository's own tests, which must not register a service on whatever machine
runs them.

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

Unchanged — the wire format is a contract with `apps/api/src/deploy`.

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

Not the pairing code — the long-lived one pairing hands over. It lets whoever
holds it install software on the machine and read its ComfyUI. Treat it like an
SSH key. It lives in `config.json` at mode 0600 and is never put in a URL. If one
leaks, remove the deployment in rippel: the agent's next check-in fails, and
re-pairing issues a new one.

Both the agent and the ComfyUI it manages are LAN software. ComfyUI has no
authentication of its own; keep both off the open internet.

## Tests

```bash
npm test -w @comfy/agent        # go test, wrapped so npm --workspaces finds it
```

There is a second suite on the API side, `apps/api/src/deploy/oneclick.test.ts`,
which runs the real binary against a real rippel and pairs it — then checks the
same code is refused a second time, and that an expired one is refused too. It
guards what two languages have to agree on: the code alphabet, its length, and
the shape of `POST /deployments/pair`. Nothing else in either suite would notice
if those drifted.
