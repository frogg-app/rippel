# Handover — 2026-09-06

Written before a VM reboot. Nothing here is lost by rebooting; the two things
that were running (a dev Postgres container and the API under `tsx`) are both
disposable and recreated by the commands below.

## Where things stand

Phase 1 of 7 is complete and verified against the real ComfyUI server at
`192.168.1.10:8188`. See `PLAN.md` for the full architecture and phase list,
`PLAN.md §7` for what the live test shook out.

Working: registration, login, logout, session cookies, per-user scoping,
migrations, first-boot seeding, the backend poller, and automatic model
discovery. Auth negatives and a login-timing check all pass.

**Nothing is committed to git yet.** The repo is `git init`-ed but has no
commits. All work is in the working tree.

## Getting back up after the reboot

```bash
cd /home/claude/image-gen

# 1. dev database (the old container is gone after a reboot unless it restarts)
docker start comfy-dev-pg 2>/dev/null || docker run -d --name comfy-dev-pg \
  -e POSTGRES_USER=comfy -e POSTGRES_PASSWORD=comfy -e POSTGRES_DB=comfy_studio \
  -p 5433:5432 postgres:17.5-alpine

# 2. shared types must be built before the api will typecheck or run
npm install
npm run build -w @comfy/shared

# 3. run the api
cd apps/api && set -a && . ../../.env && set +a && npx tsx src/index.ts
```

The API comes up on port 4000. Health check: `curl localhost:4000/api/health`.

If the `comfy-dev-pg` volume survived, the account below still exists. If you
recreated the container from scratch, migrations re-run on boot and you register
again — the first account is always the admin.

Test account created during phase 1: `steve@st3v3.com` / `a-long-enough-password`.
Dev-only, on a throwaway database.

## Things to know before picking this up

- **Docker Hub auth on this VM is stale.** `docker pull` from Docker Hub fails
  with "authentication required". Cached images work, which is why
  `docker-compose.yml` pins `postgres:17.5-alpine` and `caddy:2.10.0-alpine` —
  those are local. Pulling `redis:7-alpine` and `node:22-alpine` will need this
  fixed before `docker compose up` works end to end.
- **`.env` is dev-only** and points at host-published ports (`127.0.0.1:5433`,
  `6380`). Docker Compose reads the service names from `.env.example` instead
  (`postgres:5432`, `redis:6379`). Don't cross the two.
- **The test box has no image checkpoint.** Both installed models are video
  models (Hunyuan Video, LTX-Video), so txt2img has nothing to run against.
  Dropping an SDXL or FLUX checkpoint on the ComfyUI box before phase 2 would
  make the first end-to-end generation test meaningful.
- **The reported VRAM figure is not the card's size** (36.5 GB reported for a
  16 GB 6900XT — ROCm pools GTT into the total). This is understood and handled
  deliberately; see the README section on it before "fixing" it.
- Migrations are append-only. Never edit `001_init.sql` or `002_*.sql`; add
  `003_*.sql`.

## Next task: phase 2 — one real generation

In dependency order:

1. **Workflow templates.** Hand-author ComfyUI API-format graphs, one per
   capability, starting with a txt2img template. Each gets a manifest declaring
   which node inputs are user-facing and their ranges.
2. **The compiler.** `GenerationParams` + template -> a concrete graph via
   JSON-path substitution. This is the piece that keeps node graphs out of the UI.
3. **The orchestrator.** Pick an online backend that has the requested model,
   POST `/prompt`, subscribe to its WebSocket, relay progress on our own
   per-user channel. Reconcile via `/history` after a restart.
4. **Asset storage.** Pull finished images via `/view`, write to the storage
   driver, thumbnail, record the row.

Confirmed working already: the WS endpoint at
`ws://192.168.1.10:8188/ws?clientId=<uuid>` accepts connections and delivers
`status` frames, so the live-progress plumbing is sound.

## The design

Published canvas (the agreed UI, direction C — split workspace):
https://claude.ai/code/artifact/ef2299fb-17e4-41ec-aaf2-753bb8b7892d

Source artboards are in `design/`. To change one: edit `design/parts/<Name>.body.html`,
then from inside `design/` run `python3 assemble.py parts/<Name>.body.html`,
re-seed, and republish **passing the artifact URL above** — the file moved into
`design/` after it was first published, so a plain republish would create a
second artifact instead of updating that one.
