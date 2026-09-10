# rippel

<!-- Lowercase everywhere, including at the start of a sentence — that is the
     name, not a typo to be helpfully corrected in a commit. -->

A self-hosted web app for image and image-to-video generation, backed by your own
ComfyUI servers. Prompt, optional reference images, a few sliders — no node graphs.
Multi-user, with a private library per account.

Status: **phase 1 of 7.** The API, database, auth and backend/model discovery work
against a real ComfyUI server. Generation itself is next.

## Quick start

```bash
git clone <this repo> && cd rippel
cp .env.example .env
# Edit .env: set AUTH_SECRET and point COMFY_BACKENDS at your ComfyUI server.
docker compose up -d
```

Then open the app and register — **the first account created becomes the
administrator**, so a fresh install is never locked out of itself.

### Pointing it at ComfyUI

ComfyUI runs outside this stack, so `localhost` inside a container is not your
ComfyUI. Use the machine's LAN address:

```
COMFY_BACKENDS=desktop-4090=http://192.168.1.50:8188
```

If ComfyUI runs on the *same* host as this stack, uncomment the `extra_hosts`
block in `docker-compose.yml` and use `http://host.docker.internal:8188`.

Start ComfyUI with `--listen 0.0.0.0` so it accepts connections from off the box.
ComfyUI has no authentication of its own — keep it on your LAN. This app never
connects the browser to it directly; every call goes through the API server.

## Deploying a machine

Pointing rippel at a ComfyUI someone already installed is the section above.
Getting a ComfyUI onto a bare machine in the first place is **Settings →
Deployment**, which installs the *rippel agent* — a dependency-free Node process
that installs and updates ComfyUI, starts and stops it, and keeps the storage
helper in place.

Two ways in, installing exactly the same thing:

- **Deploy over SSH.** rippel connects once, runs the installer, and streams the
  output back. The credential is used for that connection and never stored.
- **Install by hand.** rippel gives you a one-line command with the machine's
  address and token already in it, to paste on the target — for Windows, for a
  box rippel cannot SSH to, or when you would rather read the script first.
  Download links for the agent's GitHub releases are on the same panel.

Neither needs root: the agent installs into its own home directory and runs as a
user service. The target needs Node.js 20 or newer, plus git and Python for
ComfyUI itself.

Once ComfyUI is installed there, **Add as backend** registers it — the address is
built from what the agent reported rather than typed, so there is no fourth
place to make a typo.

Set `AGENT_SERVER_URL` to the address the *agent* can reach rippel on. That is
not always `PUBLIC_URL`: behind a reverse proxy, the name a browser resolves and
the one a GPU box on the LAN resolves are routinely different.

See `apps/agent/README.md` for what the agent does to a machine and its API.

## How it avoids exposing node graphs

The UI never sends a workflow. It sends a *capability* (what the user wants) and
the API compiles that into a real ComfyUI graph from a hand-authored template.
Each template ships a manifest declaring which node inputs are user-facing and
their ranges, and the UI renders its controls from that. Supporting a new model
family is a new template plus manifest on the server — the frontend does not change.

## About the reported VRAM figure

`/system_stats` reports whatever the driver claims about the device ComfyUI selected,
and that is **not** necessarily the card you meant. Two distinct things inflate it:

- **The wrong device.** A machine with both integrated and discrete graphics enumerates
  both, and ComfyUI takes device 0 — which on a Ryzen desktop is the iGPU, reporting a
  large slice of system RAM as its memory. This is not hypothetical: our own test box
  reported "36.5 GB" for what we assumed was a 16 GB RX 6900 XT, and it turned out to be
  a `gfx1036` iGPU with one compute unit. It could load a checkpoint but faulted on the
  first real kernel. Pin the card with `HIP_VISIBLE_DEVICES` (or `--cuda-device`) and
  check `gcnArchName` before believing any of these numbers.
- **Pooled host memory.** Even on the right card, ROCm with DynamicVRAM and
  unified-memory systems pool host RAM into the total, so the figure is a budget rather
  than a physical size.

No field in ComfyUI's API distinguishes any of these cases. So the app shows the figure
as *reported* rather than claiming to know your card, records host RAM beside it for
context, and lets an admin set a per-backend `vram_limit_mb` override. The durable fix is
empirical: learning each backend's real ceiling from observed job outcomes, which is the
only approach correct on every vendor.

## Layout

```
apps/api          Fastify + TypeScript. Auth, jobs, backend registry, model catalogue.
apps/web          Vite + React front end.
apps/agent        The rippel agent: installs and manages ComfyUI on one machine.
packages/shared   Types shared by both. No runtime code.
docker/           Dockerfiles and the Caddy front door.
design/           The UI design canvas and its source artboards.
PLAN.md           Architecture and the seven build phases.
```

## Development

```bash
npm install
npm run build -w @comfy/shared          # shared types must be built first
docker run -d --name comfy-dev-pg \
  -e POSTGRES_USER=comfy -e POSTGRES_PASSWORD=comfy -e POSTGRES_DB=comfy_studio \
  -p 5433:5432 postgres:17.5-alpine
npm run dev -w @comfy/api
```

Migrations in `apps/api/src/migrations/` run automatically at boot and are
append-only — never edit one that has shipped, add another.
