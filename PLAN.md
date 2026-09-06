# Project Plan — ComfyUI Studio (working title)

A polished, subscription-site-quality web app for text-to-image, image-to-image, and
image-to-video generation, backed by one or more self-hosted ComfyUI servers.
Users never see a node graph.

## 1. Goals

- Prompt box + optional image upload + a handful of tasteful controls. That's the whole UI.
- Multiple ComfyUI backends, health-checked, auto-discovered models, load-balanced queue.
- Live generation status (queue position, step progress, live preview) over WebSocket.
- Personal, private library of every output with metadata and re-run.
- Model browser: what's installed, plus search/download from Civitai + HuggingFace.
- Multi-user with registration/sign-in; strict per-user isolation of images.

## 2. Architecture

    Browser (Next.js 15 App Router, React 19, Tailwind + shadcn/ui, Framer Motion)
        | HTTPS REST + WebSocket
    API server (Node/TypeScript, Fastify)
        - auth, jobs, library, models, backend registry
        - job orchestrator + queue (BullMQ on Redis)
        - workflow compiler: UI params -> ComfyUI API-format graph
        | ComfyUI HTTP + WS (/prompt, /history, /view, /upload/image, /object_info)
    ComfyUI backend(s) on desktop  ...  N more
        |
    Storage: Postgres (metadata) + S3-compatible object store (MinIO) or local disk

### Why a separate API server rather than browser->ComfyUI directly
- Backends live on a LAN, may be off, and must never be exposed to the internet.
- Per-user isolation, quotas, and auth cannot be enforced client-side.
- Job survives a page refresh or a closed laptop; results land in the library regardless.

### Key components

**Backend registry** (`backends` table): name, base URL, optional auth, tags
(e.g. `gpu:4090`, `video`), enabled flag. A poller hits `/system_stats` and
`/object_info` every 15s to record online/offline, VRAM, and the installed model
lists (checkpoints, LoRAs, VAEs, ControlNets, upscalers, video models).
Offline backends are shown greyed out in the UI, never dispatched to.

**Workflow templates**: hand-authored ComfyUI API-format JSON graphs, one per
*capability* — `txt2img-sdxl`, `txt2img-flux`, `img2img`, `inpaint`, `upscale`,
`img2vid-wan`, `img2vid-svd`, etc. Each template ships a manifest declaring which
node inputs are user-facing (prompt, negative, steps, cfg, seed, size, model,
LoRAs, strength, motion, frames, fps) and their ranges/defaults. The compiler
does JSON-path substitution — no graph editing in the UI, ever. Adding a new
model family = adding a template + manifest, no frontend change.

**Job lifecycle**: `queued -> dispatched -> running(step n/N, preview) -> uploading
-> complete | failed | cancelled`. Orchestrator picks the least-loaded online
backend whose installed models satisfy the request, POSTs `/prompt`, subscribes to
ComfyUI's WebSocket, relays `progress`/`executing`/`executed` frames to our own WS
channel scoped to the job's owner. On completion it pulls artifacts via `/view`,
writes them to object storage, thumbnails them (sharp / ffmpeg for video posters),
and records the row. Crash-safe: on restart we reconcile via `/history`.

**Deployment agent**: a dependency-free Node process (`apps/agent`) installed on
each GPU machine, over SSH from the admin UI or by a generated one-line command.
It installs and updates ComfyUI, starts and stops it, keeps the storage helper in
place, and checks in with what it finds. The agent's source is served by the
rippel that will drive it, so the pair always matches. See `apps/agent/README.md`.

**Model manager**: search Civitai + HuggingFace APIs, show cards with previews,
license, size, base model. Download runs as a queued job *on the chosen backend's
host* via a small companion agent, or via ComfyUI-Manager's model-install API if
present; progress streamed the same way as generation. Checksum verified, dropped
into the right `models/<type>/` folder, registry refreshed.

**Auth**: email + password (argon2id) with email verification, plus optional OAuth
later. Sessions as httpOnly cookies with rotating refresh tokens. Roles: `user`,
`admin` (admin manages backends and global model library). Every library query is
scoped by `user_id` at the repository layer, not the route layer.

## 2b. Deployment — Docker-first (hard requirement)

The whole product ships as a self-hostable Docker stack. A prospective user should
go from zero to a working studio with `git clone && cp .env.example .env && docker
compose up -d`, then point it at their ComfyUI box.

- `docker-compose.yml` at the repo root: `web`, `api`, `worker`, `postgres`,
  `redis`, `minio`, and a `caddy`/`nginx` front door doing TLS and routing.
- Multi-stage Dockerfiles, non-root users, published multi-arch images
  (`ghcr.io/<org>/comfy-studio-{web,api}`) so `docker compose up` needs no build.
- All config via env vars, documented in `.env.example`: `COMFY_BACKENDS`,
  `DATABASE_URL`, `STORAGE_*`, `AUTH_SECRET`, `PUBLIC_URL`, `ALLOW_REGISTRATION`,
  `CIVITAI_API_KEY`, `HUGGINGFACE_TOKEN`.
- Migrations run automatically on api container start; first boot seeds an admin
  account from env and prints a one-time setup link.
- Storage swappable by env: local volume (default, zero deps) or any S3-compatible
  endpoint. MinIO stays an optional profile so the base stack is small.
- `profiles:` for optional pieces (minio, observability) and a documented override
  file for GPU/host-network setups where ComfyUI runs on the same machine.
- Named volumes for db + assets, a documented backup/restore command, and health
  checks on every service so `depends_on: condition: service_healthy` works.
- Reaching ComfyUI on the host from inside the stack is a known footgun: document
  `host.docker.internal` (+ `extra_hosts` on Linux) and LAN IPs in the README.

## 3. Data model (Postgres)

users, sessions, backends, models (type, family, filename, hash, backend_ids[],
preview_url, source), workflow_templates, jobs (user_id, kind, params jsonb,
status, backend_id, comfy_prompt_id, timings, error), assets (job_id, user_id,
kind image|video, storage_key, thumb_key, width, height, duration, nsfw_flag),
collections + collection_assets, quotas/usage.

## 4. Build phases

1. **Skeleton** — DONE. monorepo (pnpm), Docker Compose (postgres, redis, minio, api, web),
   auth, empty shell UI with the final design language in place. Docker Compose is
   the *primary* dev environment from commit one, not an afterthought.
2. **One real generation** — NEXT. backend registry + txt2img template + job orchestrator
   + WS progress + asset storage. End-to-end on the real desktop ComfyUI.
3. **Library** — grid, detail drawer with full metadata, re-run/remix, download,
   delete, collections, search/filter.
4. **Creation surface** — img2img, upload/drag-drop, model picker as a tiled visual
   library, LoRA picker with weights, aspect-ratio and quality presets.
5. **Video** — img2vid + txt2vid templates, video player, poster frames, longer-job
   handling.
6. **Model manager** — installed view, Civitai/HF search, download with progress.
7. **Polish** — multi-backend balancing, quotas, admin panel, keyboard shortcuts,
   mobile layout, error states, empty states, onboarding.

## 5. Risks / decisions to nail early

- ComfyUI has no auth; keep backends LAN-only and reach them from the API server.
- Template maintenance is the real long-term cost — keep the manifest format tight.
- Video jobs are minutes long: everything must be resumable and notify on completion.
- NSFW/content policy and disk growth: needs retention + quota policy per user.

## 6. Locked UI decisions (from design session)

- **Controls**: presets by default — Quality (Fast/Balanced/High), aspect ratio
  chips, image count — with a collapsible **Advanced** drawer holding steps,
  guidance, sampler, seed (dice + lock), and LoRA add. Advanced state is
  remembered per user.
- **Reference images**: a first-class list on both image and video generation.
  Every input image comes from one of two equal sources — a file the user drops,
  or an existing generation picked out of their library — and the picker offers
  both side by side. Each reference carries a *role* (`init` for classic img2img,
  plus `style` / `composition` / `face` / `depth` / `pose` where the model family
  has templates for them) and its own influence slider. Video takes the same
  thing as `firstFrame`, with an optional `lastFrame` for models that can
  interpolate between keyframes.
- **Video**: both surfaces. A dedicated Image/Video mode toggle for from-scratch
  work, *and* an "Animate" action on every image that jumps into Video mode
  prefilled with that image and its prompt.
- **Aesthetic**: dark and cinematic. Near-black ground, generous spacing, subtle
  glass/blur panels, a single accent colour, images carry all the colour.
- **Layout**: split workspace. A fixed ~396px left panel holds every input
  (prompt, negative, source image + influence slider, model tiles, quality
  segmented control, the Advanced drawer) with Generate pinned to its bottom;
  the right side is the running job at full size with live preview, a variation
  strip, and per-result Save / Remix / Animate. Browsing lives in Library, not
  on the Create screen.
- **Chrome that appears on every screen**: the backend status pill
  (`desktop-4090 · 18.2/24 GB`) and the queue chip, top right. With self-hosted
  ComfyUI, "is my server even up?" must be answered before it is asked.
- **Palette**: ground #0b0b0d, panels #0d0d10 / rgba(255,255,255,0.02-0.05),
  hairlines rgba(255,255,255,0.06-0.11), text #ececef / #9a9aa4 / #5d5d67,
  single accent gold #e3b04b (hover #f0c877, deep #a8702a), status green
  #5fd08a. Type: Instrument Serif (headings/wordmark), Instrument Sans (UI),
  IBM Plex Mono (all numerics — steps, seeds, VRAM, timings).
- **Canvas**: https://claude.ai/code/artifact/ef2299fb-17e4-41ec-aaf2-753bb8b7892d

## 7. Verified against real hardware (2026-09-06)

Tested against a live ComfyUI 0.34.0 on ROCm at 192.168.1.10:8188.

- Migrations, seeding, registration, login, logout, session cookies: pass.
- Login timing for a known vs unknown address: 145.9ms vs 147.5ms — no enumeration.
- Backend poller: marks online, records device name, VRAM and host RAM.
- Model discovery: found both installed models automatically.

Two things this shook out that would have bitten later:

- **ComfyUI 0.34 has two input-spec shapes in one install.** `CheckpointLoaderSimple`
  uses the legacy `[[...files], {}]` form while `UpscaleModelLoader` uses the newer
  `["COMBO", {options: [...]}]`. Reading only the first silently discovers zero
  upscalers, LoRAs or ControlNets on newer nodes. `readOptions()` handles both.
- **Loaders list pseudo-entries that are not files.** `VAELoader` offers
  `pixel_space`. Discovery filters to real model extensions.

Also noted: the test box has only video models installed (Hunyuan Video, LTX-Video)
and no image checkpoint, so txt2img has nothing to run until one is added.
