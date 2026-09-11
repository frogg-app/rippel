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
# Edit .env: set AUTH_SECRET and your database/storage settings.
docker compose up -d
```

Then open the app and register — **the first account created becomes the
administrator**, so a fresh install is never locked out of itself.

## Connecting a backend

Open **Settings → Backends** to connect a machine through the rippel agent.
A backend is an agent-managed machine; its generation engine is ComfyUI.
The agent installs and updates the engine, starts and stops it, and enables
file access for Rippel's storage tools.

Choose **Deploy over SSH** or **Install by hand** to connect a machine.
Once the agent is online, install the generation engine and choose
**Enable generation**. Rippel gets the engine address from the agent.
Standalone ComfyUI addresses and `COMFY_BACKENDS` startup seeding are no
longer used to add machines. Existing records are preserved.

The agent is a standalone binary. ComfyUI itself needs Python and git;
the agent manages setup on supported platforms.

Removing a backend disconnects it from Rippel and its generation list.
It does not uninstall the agent or delete files on that machine. Removal is
blocked while generation or model downloads are active.

The install command carries the address the agent will check in to, and that
address is the one you are reaching rippel on when you copy the command — open
rippel on the LAN and it is the LAN address, open it at a public name and it is
that name. The panel says which address it used before you run anything. Set
`AGENT_SERVER_URL` only if agents must use some third address that no browser
does.

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
