# A second engine: stable-diffusion.cpp

## The problem

ComfyUI is the only engine rippel can run. It is a Python application with a
torch install beside it: a multi-gigabyte setup that takes minutes to install,
tens of seconds to start, holds several gigabytes of RAM idle, and fails in the
ways every ComfyUI thread on the internet is about (wrong torch wheel, a custom
node that broke on update, a venv that no longer imports). The agent, the GPU
self-test and the storage helper exist to paper over those failure modes.

Someone who just wants pictures and short clips from a laptop or a small box
pays all of that for a node graph they never see.

## What is true today

- `apps/agent/go` installs, starts and stops ComfyUI and reports a `ComfyState`
  on every check-in. The agent's tunnel has one `engine` target, which dials
  `cfg.ComfyPort`; the backend row's `base_url` is the tunnel's engine URL.
- `apps/api/src/orchestrator` compiles a job to a ComfyUI graph, `POST /prompt`s
  it, follows progress on ComfyUI's socket and settles from `/history`.
- `apps/api/src/lib/backend-poller.ts` discovers models from `/object_info`.
- `GenerationParams` and the `Job` shape are engine-neutral already.

## The engine

[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) and its
`sd-server`: one static binary per platform (Linux CPU/Vulkan/ROCm, Windows
CPU/CUDA/ROCm/Vulkan, macOS arm64), no runtime beside it, daily prebuilt
releases. It reads the same `models/` layout ComfyUI does (`checkpoints/`,
`diffusion_models/`, `text_encoders/`, `vae/`, `loras/`), so an existing
ComfyUI install's model folder is shared rather than duplicated, and it covers
SD 1.x/2.x/XL, FLUX.1/2, Qwen-Image, Z-Image, Wan 2.1/2.2, LTX and Hunyuan.

Its native API (`/sdcpp/v1`) is async and poll-based, which is exactly the
shape the orchestrator already assumes: submit returns a job id, `GET /jobs/:id`
carries status, `preview.step/total_steps` and a preview PNG, and the result
is base64 bytes. There is no socket to lose.

Measured on the dev box (12 CPU threads, 3.7 GB RAM): SD-Turbo q8 loads in
4.3 s; a 512×512 two-step image renders in 10 s of sampling. The release
archive is 60 MB.

## Design

One sentence: **a deployment has an active engine, and everything downstream
reads it.**

- `deployments.engine` is `comfyui` or `sdcpp`; `deployments.sdcpp` holds the
  agent's last `SdcppState` the way `comfy` holds `ComfyState`.
  `backends.engine` mirrors the deployment's choice so the poller, the
  dispatcher and the UI can branch without a join.
- The agent keeps `cfg.Engine`; the tunnel's `engine` target dials whichever
  engine is active. The backend URL therefore does not change when the engine
  does, and `/deployments/:id/backend` keeps working unchanged for tunnelled
  machines.
- Both engines may be installed at once. The panel chooses; the choice is
  saved on the machine, not only in rippel.

### Agent (Go)

New `sdcpp.go`, mirroring `comfy.go`:

- `InstallSdcpp(cfg, task, build)`: pick the release asset for `GOOS`/`GOARCH`
  and the requested build (`auto|cpu|vulkan|cuda|rocm`; auto = CUDA on Windows
  with NVIDIA, Vulkan on any other GPU, CPU otherwise), download it from the
  GitHub release (HTTPS, size-capped, SHA-256 from the release `digest` when
  present), unzip into `cfg.SdcppPath`, write `build.txt`. Idempotent: a
  re-run replaces the binaries and keeps `models/`.
- `StartSdcpp`/`StopSdcpp`: `sd-server --listen-ip 0.0.0.0 --listen-port
  <port> --model-dir <ComfyUI/models if present> --model-dir <sdcpp/models>`,
  detached, pid and log files beside the agent config.
- `SdcppStatus`: installed, running (answered `/sdcpp/v1/models/status`),
  build, loaded recipe and files, disk and GPU memory.
- Routes: `POST /agent/sdcpp/install`, `/agent/sdcpp/{start,stop,restart}`,
  `GET /agent/sdcpp/log`, `POST /agent/engine {engine}`. `/agent/status` and
  the check-in carry `engine` and `sdcpp`.
- The model root for downloads, moves and deletes becomes the active engine's
  models directory, so the existing catalogue install path works for a
  machine that only has sd.cpp.
- `AgentVersion` → 0.5.0.

### API

- Migration `035_engines.sql`.
- `lib/sdcpp.ts`: a small client (status, model files, load, unload, submit,
  job, cancel) and the category → `ModelType` mapping for discovery.
- `orchestrator/sdcpp-plan.ts`: family → recipe, and which of the backend's
  files fill the recipe's required slots (the text encoder for Z-Image is a
  Qwen3 GGUF, Wan's is UMT5, FLUX's VAE is `ae.safetensors`). A plan is also
  the readiness answer for an sd.cpp backend. Steps, guidance, sampler and
  resolutions come from the same `WorkflowManifest` presets ComfyUI uses when a
  template exists for the family; otherwise the recipe's own defaults apply.
- `orchestrator/sdcpp.ts`: dispatch and settle. Dispatch never blocks on a
  model load: when the server holds a different model it asks for the load
  and records `load:<token>` as the prompt id; the next ticks poll
  `models/status`, publish "Loading <model>", submit the real job once the
  server is ready, and fail the job if the load fails. Settle polls the job,
  turns `preview` into `JobProgress`, and persists the base64 result through
  `persistOutput` (images and the one video container).
- `backend-poller.ts`, `select.ts`, `cancel.ts`, `routes.ts` (jobs) and
  `deploy/routes.ts` branch on `engine`.

### Web

- Deployments card: an Engine chooser; the Install/Start/Stop/Restart/Update
  buttons act on the active engine; a summary line for sd.cpp (build, loaded
  model). Short copy, one click per action.
- Backends and the pill show the engine name quietly.

## Phases

1. Shared types and migration.
2. Agent: install, run control, status, engine switch, model root. Tests for
   asset selection, zip extraction safety and status parsing.
3. API: client, plan, dispatch/settle, poller, cancel, deploy routes,
   readiness. Tests for the plan, request building and settle parsing.
4. Web: engine chooser and sd.cpp controls.
5. Build agent binaries; run the stack on the dev box with a local agent and
   sd-server; render SD-Turbo and Z-Image; screenshots; results document.

## Testing

- `npm run build -w @comfy/shared`; API `tsc --noEmit` + `vitest run`; web
  `tsc -b` + `vitest run`; agent `go test ./...` + `GOOS=windows go vet .`.
- A live run on 192.168.1.9: agent + sd-server (CPU) registered as a backend,
  a txt2img job through the Create page, outputs in the library.
- Not verified here: GPU builds on a real card (the dev box has none), and
  Windows (binaries are built, not run).
