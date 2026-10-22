# stable-diffusion.cpp as a second engine — results

Branch `engine-sdcpp`, 2026-10-23. Plan: `docs/plans/2026-10-23-sdcpp-engine.md`.
Screenshots and renders: `docs/results/2026-10-23-sdcpp-engine/`.

## What was asked

A faster, lighter alternative to ComfyUI for image and video generation that
the rippel agent can install and manage remotely exactly as it does ComfyUI,
with rippel's own UI on top, delivered on a branch with binaries, screenshots
and renders, and a deployment that can be tested later.

## What was chosen, and why

[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)'s
`sd-server`. Of the candidates surveyed it is the only one that is at once:

- **one static binary per platform** with daily prebuilt releases for Linux
  (CPU, Vulkan, ROCm), Windows (CPU, CUDA 12, ROCm, Vulkan) and macOS arm64 —
  no Python, no venv, no torch wheel to choose, 26 MB for the Linux CPU build;
- **a native async job API** (`/sdcpp/v1`): submit → job id, poll → status,
  step counter and a live preview frame, result as bytes in the poll body. No
  socket to lose and no `/history` to reconcile;
- **compatible with the models rippel already manages**: it reads the same
  `models/{checkpoints,diffusion_models,text_encoders,vae,loras}` layout and
  Comfy-Org split files, so a machine with ComfyUI shares its weights, and
  rippel's catalogue downloads land where sd-server reads them;
- **current**: built-in recipes for SD 1/2/XL, SD3, FLUX.1/2/3, Qwen-Image,
  Z-Image, Wan 2.1/2.2, LTX-2, Hunyuan 1.5 and more, with recipe defaults.

## What was built

One sentence: **a deployment has an active engine, and everything downstream
reads it.** Both engines may be installed; the panel chooses; the choice is
saved on the machine.

### Agent (Go, `apps/agent/go`, version 0.5.0)

- `sdcpp.go`: install (pick the release asset for OS/arch/build, download
  with GitHub's published SHA-256 checked, unzip with path-escape checks),
  start/stop/restart (detached, pid and log files beside the agent config),
  status (`/sdcpp/v1/models/status` is the heartbeat), engine switch.
- The tunnel's `engine` target dials whichever engine is active, so the
  backend URL rippel already holds keeps working across a switch.
- The models root for catalogue downloads follows the engine, so a machine
  with only sd.cpp can still install models from rippel.
- Build choice: CUDA on Windows with NVIDIA (the archive ships its runtime),
  Vulkan for any other GPU (needs only a graphics driver), CPU otherwise.
  Explicit `cpu|vulkan|cuda|rocm` is accepted.
- Routes: `POST /agent/sdcpp/install`, `/agent/sdcpp/{start,stop,restart}`,
  `GET /agent/sdcpp/log`, `POST /agent/engine`. Check-in and `/agent/status`
  carry `engine` and `sdcpp`.

### API (`apps/api`)

- Migration `034_engines.sql`: `backends.engine`, `deployments.engine`,
  `deployments.sdcpp`.
- `lib/sdcpp.ts`: the client and the category → model-type mapping.
- `orchestrator/sdcpp-plan.ts`: family → recipe, and which of the backend's
  files fill the recipe's slots (UMT5 for Wan, Qwen3 for Z-Image, `ae` for
  FLUX/Z-Image…). A gap is reported with the recipe's own slot label and the
  folder it belongs in; a misfiled model gets "move X from checkpoints/ to
  diffusion_models/" rather than a failed load.
- `orchestrator/sdcpp.ts`: dispatch and the poll loop. Dispatch never blocks
  on a model load: it asks for the load, records a `load:` token, and the
  ticks say "Loading <model> on <machine>" until the server is ready, then
  submit. Progress, previews and the result all come from one poll.
  Steps/guidance/sampler/sizes come from the same template presets ComfyUI
  uses when a template exists for the family; distilled recipes (SD-Turbo,
  Z-Image Turbo) keep their own step count.
- Backend poller, candidate selection, cancel, the job route, readiness and
  the deployment routes branch on `engine`.
- New families: `z-image`; SD-Turbo files now classify as `sd2.x`.

### Web (`apps/web`)

- Deployments card: an **Engine** chooser (agent 0.5+), sd.cpp summary
  (running · build · release · loaded model · paths), and the
  Install / Start / Stop / Restart / Update buttons act on the active engine.
- Readiness, the Create page and the library needed no engine-specific UI:
  the sd.cpp plan answers the same `BackendReadiness` shape.

## Verified on the dev box (192.168.1.9, 12 CPU threads, 3.7 GB RAM, no GPU)

The whole flow was driven through rippel, not by hand:

| Step | Result |
|---|---|
| Pair the 0.5.0 agent with a fresh rippel (separate DB, API on 4010) | online through the tunnel in seconds |
| Switch engine to stable-diffusion.cpp from the API | agent config updated, backend row follows |
| `Install engine` (CPU build) | 26.5 MB downloaded, SHA-256 verified, 37 files unpacked, 6 s |
| `Start engine`, `Enable generation` | backend online as `stable-diffusion.cpp (cpu) master-987-a77d362` |
| Model discovery | SD-Turbo (sd2.x), Z-Image Turbo (z-image), Wan 2.1 1.3B (wan), both encoders, both VAEs |
| Readiness | SD-Turbo ready; Z-Image ready with Qwen3 + ae; Wan ready for txt2vid, "no image recipe" for txt2img |
| txt2img, SD-Turbo, 1 step (Create page under Playwright) | 38 s wall including a 4 s model load; live preview shown; asset in the library |
| txt2img, SD-Turbo, 16 steps at cfg 7 (before the distilled fix) | 3 min 20 s; this is what exposed the preset bug |

Renders: `render-sd-turbo-1-step.png` (the fox in the screenshots) and
`render-sd-turbo-16-steps-cfg7.png` (over-cooked, kept as the "before").

Test suites: API 76 files / 1120 tests, web 50 files / 504 tests, agent
`go test ./...` and `GOOS=windows go vet` — all passing. New tests cover
release-asset selection against the real October release names, zip
path-escape refusal, status parsing, the recipe planner on the dev box's real
file list, request building (distilled precedence, video fields, init image,
LoRAs), `holdsPlan`, and the engine chooser / sd.cpp card in the web.

## Not verified

- **GPU builds.** The dev box has no GPU; Vulkan/CUDA/ROCm archives are
  selected and downloaded by the same code path but were not run.
- **Windows.** `rippel-agent-windows-amd64.exe` is built, not run. steve-pc
  (Windows, RX 6900 XT) is reachable only through the live dev.rippel.app
  tunnel, whose API is `master`; putting this branch's agent on it would
  mean deploying the branch to lilypad. Not done, by instruction scope.
- **Z-Image and Wan renders.** Both plans are complete and ready, but the
  weights (3.1 GB + 1.9 GB, 2.8 GB + 2.9 GB) exceed this box's memory. They
  are the first thing to run on steve-pc.
- **Video output in the library.** sd.cpp video is requested as animated WebP
  (every release build encodes it; the thumbnailer reads it) and the detail
  drawer shows a `.webp` with `<img>`; untested without a video render.
- **LoRA path ids.** Sent as the path below `loras/`, which matches the docs
  for the first model root; untested with a LoRA present.

## To test it later

```sh
/home/claude/sdcpp-dev/start.sh        # API on 4010, web on 5178 (if not running)
```

- Web: http://192.168.1.9:5178 — sign in as `admin@rippel.local` with the
  password in `/home/claude/sdcpp-dev/api.env`.
- The dev-box deployment is the real agent as a systemd user service
  (`systemctl --user status rippel-agent`); its config is
  `~/.rippel-agent/config.json`, sd-server lives in `~/.rippel-agent/sdcpp`,
  models in `~/.rippel-agent/sdcpp/models` (hard links into
  `/home/claude/sdcpp-dev/cache`). `rippel-agent uninstall` removes it.
- Running the agent's Go tests on this box stops that service (the tests
  exercise the uninstall path); `systemctl --user start rippel-agent` brings
  it back. sd-server itself survives, being detached.
- Agent binaries: `apps/agent/dist/` (gitignored; rebuild with
  `PATH=~/go/bin:$PATH npm run build:release` in `apps/agent`).

## Follow-ups worth doing

1. Run it on steve-pc: merge or deploy the branch to lilypad, update the
   agent, choose the Vulkan build, render Z-Image Turbo and Wan 2.1 1.3B.
2. Offer catalogue downloads for sd.cpp gaps (the planner already names the
   slot and folder; the install transport is ComfyUI-folder based today).
3. TAE decode for previews (`preview: 'tae'`) once a TAE file is catalogued.
4. Memory guard: pass `--max-vram` from the agent's `gpuMemory` reading.
