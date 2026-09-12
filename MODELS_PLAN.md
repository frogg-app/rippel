# Model integration: task plan for an autonomous agent

Written 2026-09-11 for GPT-6 Astra, to be run as long agentic sessions. Every
task is self-contained: where to start, what to build, how you know it is done,
and how to verify it. Read this whole file and the "Ground rules" before
starting any task.

## The goal

rippel is a web app that turns a prompt and a few controls into a ComfyUI job.
Three things are broken or missing:

1. Image-to-video mostly does not work.
2. **Every workflow has to be written by hand.** ComfyUI ships a library of
   538 ready-made workflows, and users can reach none of them. This is the
   biggest problem after image-to-video. See "Workflows" below.
3. **Broken models can be diagnosed but not fixed.** The model cards say
   "Wrong folder" or "Needs another model" with a correct explanation, and
   then offer nothing but Remove. Every such card needs a **Fix** button that
   has the agent on that machine do the work. See "Fix buttons" below.
4. Large models cannot run on a 16 GB card, even slowly, because nothing lets
   ComfyUI offload to system memory.

## The backend you will test against

`desktop-6900xt` at `http://192.168.1.10:8188`. ComfyUI **0.35.0** on Windows
with ROCm (torch 2.13.0+rocm10.0.0), an RX 6900 XT with 16 GB VRAM, and 64 GB of
system RAM. Check the current state yourself with:

```bash
curl -s http://192.168.1.10:8188/system_stats
curl -s http://192.168.1.10:8188/models/checkpoints    # or any folder name
curl -s http://192.168.1.10:8188/object_info/WanImageToVideo
curl -s http://192.168.1.10:8188/templates/index.json  # the workflow library
```

**State on 2026-09-12, re-queried. It had gone very stale, and two of the
changes invalidate parts of the plan below — read this before starting a task.**

Most of the video models the plan was written around are **gone**.
`diffusion_models/`, `text_encoders/` and `clip_vision/` are all empty. The
launch arguments no longer include `--cpu-vae`; they are now
`--listen 0.0.0.0 --port 8188 --cuda-device 1`.

| Model | Folder | Status |
| --- | --- | --- |
| `SVD/svd.safetensors` | `checkpoints/` | **Runs.** Through `img2vid-svd`. 512x288, **25 frames**, 12 steps took 93 s on 2026-09-12. |
| `SDXL/sd_xl_base_1.0_0.9vae` | `checkpoints/` | Runs. Note the filename changed and the refiner is gone. |
| `seedvr2_ema_vae_fp16` | `vae/` | Unrelated to any template here. |
| `lightx2v_I2V_14B_...`, `krea2_style_reference`, 2 SDXL LoRAs | `loras/` | Orphans. No base model installed. |
| *everything else the old table listed* | — | **Removed from the box.** No LTX-Video, no Hunyuan Video, no Hunyuan DiT, no LTX LoRAs. |

Two consequences:

1. **Nothing with a video template can be verified end to end except SVD.**
   Tasks 2, 3 and 4 can be built and structurally validated — post the compiled
   graph to `/prompt` and read `node_errors`, which reports missing *files* only
   after every class name, link and input range has passed — but "a real job
   succeeded" is not available until someone installs weights.
2. **ComfyUI-Manager is no longer installed.** `/customnode/getmappings` and
   `/externalmodel/getlist` both 404, so this backend has **no install
   transport**: `models/installs.ts` cannot queue a download to it and no Fix
   button in Run 3 can close a gap on this machine. Run 3 still has a job to do
   in the app, but its verification story needs a person or a new transport.
   This is the biggest unplanned blocker in this file.

The backend has ComfyUI's native Wan, LTX and Hunyuan nodes, including
`Wan22ImageToVideoLatent`, `CreateVideo` and `SaveVideo`. Custom nodes such as
ComfyUI-GGUF are not installed. The workflow library is present at version
**0.11.59** and serves **547** templates.

### Files a person needs to install

Nothing below can be fetched by the app; all of it has to be dropped on the box
by hand. Each group unblocks the task named.

Task 2, LTX-Video image-to-video — 10.9 GB:

```
models/checkpoints/ltx-video-2b-v0.9.5.safetensors              5.72 GB
  https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors
models/text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors        5.16 GB
  https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors
```

Task 3, Wan 2.2 TI2V 5B image-to-video — 16.9 GB:

```
models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors         9.31 GB
  https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors     6.27 GB
  https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
models/vae/wan2.2_vae.safetensors                               1.31 GB
  https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors
```

Do not substitute `wan_2.1_vae.safetensors`, which sits in the same directory of
the same repo: it decodes 2.2 latents as noise rather than failing. Only fp16 is
published for the 5B transformer.

## Workflows

This is the most important section after image-to-video. Read it fully.

### What a workflow is

A ComfyUI workflow is a graph of nodes: load a model, encode the prompt, make
an empty video, sample, decode, save. Users of ComfyUI build these by hand in
a node editor. rippel users never see one. They pick a model, type a prompt,
set a few sliders, and rippel fills in a graph for them.

To do that, rippel needs two things per workflow:

1. **The graph** in ComfyUI's *API format*: a flat map of node id to
   `{class_type, inputs}`. This is what `POST /prompt` accepts.
2. **A manifest** saying which node inputs are user controls and their ranges.
   For example, `6.inputs.text` is the prompt and `3.inputs.steps` is steps,
   from 4 to 60. The form draws its controls from the manifest, and the API
   rejects values outside it.

### How it works today

- Every workflow is hand-written in `apps/api/src/workflows/`: one graph file,
  one manifest file, tests. There are nine, plus a generic Stable Diffusion
  fallback.
- The registry picks one by what the user wants to do and the model's family.
  An admin can pin a different one per model, stored in `model_workflows`.
- Adding a model family means writing a new workflow by hand. That is why so
  few families work.

### The library we are not using

Every ComfyUI install ships the official workflow library, the
`comfyui-workflow-templates` package. Our backend serves it:

```bash
curl -s http://192.168.1.10:8188/templates/index.json        # the catalogue
curl -s http://192.168.1.10:8188/templates/<name>.json       # one workflow
```

Measured on `desktop-6900xt`, library version 0.11.55:

| Category | Workflows |
| --- | --- |
| Video | 172 |
| Image | 163 |
| Use Cases | 48 |
| Image Tools | 41 |
| 3D Model | 37 |
| Audio | 29 |
| Video Tools | 25 |
| LLM | 18 |
| Node Basics | 5 |

Of 66 image-to-video workflows, 14 are marked open source. The rest call paid
cloud APIs through ComfyUI's API nodes, and rippel will skip them.

**What the catalogue gives us per workflow:** name, title, description,
thumbnail, tags such as "Image to Video", model names, total download size,
whether it is open source, the minimum ComfyUI version, and `io`, which lists
the input and output nodes.

**What each workflow file gives us:** every loader node carries its model
files under `properties.models`, with the filename, a download URL and the
target folder. From `video_wan2_2_5B_ti2v`:

```json
{ "name": "wan2.2_ti2v_5B_fp16.safetensors",
  "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
  "directory": "diffusion_models" }
```

That is everything needed to install a workflow's models in one click.

**The two catches:**

- **The files are in the editor's format, not the API format.** They hold
  nodes, links and widget values as positional arrays. Turning them into API
  format means matching each widget value to its input name, using the node
  specs from `/object_info`. ComfyUI's browser frontend does this conversion;
  rippel must do it on the server.
- **Newer workflows use subgraphs.** `video_wan2_2_14B_i2v` has 5 top-level
  nodes, and the real work sits inside one subgraph. The converter must flatten
  subgraphs before converting.

### Where we are going

Two tiers of workflow, shown to users the same way:

- **Built-in:** the hand-written ones in the repo. Fully tested, verified on
  real hardware. Kept for the most-used families.
- **Library:** imported from ComfyUI's library by an admin. rippel converts
  the graph, works out the controls, lists the models and installs them, runs
  a test job, and only then offers it to users. The UI labels these as
  library workflows.

What the admin sees, per library workflow, before importing:

| Status | Meaning |
| --- | --- |
| Ready | Converted, controls found, models installed, test job passed. |
| Needs files | Converted, but models are missing. Shows total size and an Install button. |
| Too big | The models do not fit this backend's VRAM plus RAM, even offloaded. |
| Needs custom node | Uses a node this backend does not have. Names it. |
| Cloud only | Uses paid API nodes. Hidden by default. |
| Not supported | Converted, but rippel could not find a prompt, an output, or a required control. Says which. |

What a user sees: workflow cards with the library's thumbnail and
description, filtered to what their backends can run. They pick one, and they
get the same simple form as today.

### Workflow ground rules

- **The test for a converted graph is ComfyUI itself.** Submit it to
  `/prompt`. An empty `node_errors` means the conversion is valid. A finished
  job with an output file means it works.
- **Never guess a control.** If the mapper is not sure an input is the prompt,
  the seed or the first frame, it leaves it fixed and reports that. A missing
  control is visible; a wrong one ruins every job quietly.
- **Pin the library version.** Record the `comfyui-workflow-templates` version
  and the workflow's `date` on every import. Re-importing is an explicit
  action, never automatic.
- **Imported workflows are data, not code.** Store them in the database, not
  in `apps/api/src/workflows/`. The registry reads both.

## Fix buttons

The second most important section after image-to-video, alongside Workflows.

### What users see today

On the Installed models screen, on `desktop-6900xt`:

- **Hunyuan Video 720p FP8 E4m3fn**, badge **Wrong folder**: "It is in
  "checkpoints", but the workflow loads it from "diffusion_models" — it needs
  moving there, not downloading again."
- **LTX Video 2b V0.9.1**, badge **Needs another model**: "Also needs a T5
  text encoder, t5xxl_fp16.safetensors and 1 other file, which desktop-6900xt
  does not have."

Both diagnoses are right. Both cards offer only Workflows and Remove, so the
user has to go to the Windows machine and move or download files by hand.

### What they should see

A **Fix** button on every card whose problem the agent can solve, with a
confirmation that says exactly what will happen before anything does.

| Verdict | What Fix does | Confirmation shows |
| --- | --- | --- |
| Wrong folder | Moves the file into the folder its workflow reads, on the same disk. | From and to paths. "No download." |
| Needs another model | Downloads each missing companion into its folder, verified by checksum. | Each file, its size, its source, and the total. |
| Needs custom node | Installs the node pack through the agent, then restarts ComfyUI. | The pack, its repository, and that ComfyUI will restart. Needs a person's approval; see Task 17. |
| Not visible to its loader | Same as Wrong folder, when the right folder is known. | As Wrong folder. |
| No workflow | No Fix. Links to the workflow library filtered to this model's family. | — |

After clicking:

1. The card shows the agent's progress inline: bytes downloaded, or "Moving".
   It survives a page refresh, because it is an agent task with an id.
2. When the task ends, rippel clears its cached `/object_info` for that backend
   and re-checks the card. The badge changes to Will run, or to the next
   problem if there is one.
3. On failure, the card says what failed in a sentence, keeps the old badge,
   and offers Retry. A half-downloaded file is deleted, never left in place.

A card can need several fixes, such as a move and then a download. Fix does
them in order in one task and shows each step.

### Who can press it

Admins get Fix. Other users see the same diagnosis with "Ask an admin to fix
this". Fixes change a shared machine, so they are logged with who pressed Fix,
what ran, and the result.

### Where companion files come from

A needs-another-model card only knows a filename such as
`t5xxl_fp16.safetensors`. Fix needs a URL and a checksum. Sources, in order:

1. The workflow library: library files list each model's URL and folder under
   `properties.models`. See "Workflows".
2. The backend's install catalogue, which the models screen already reads.
3. A small table in the repo for companions neither source covers.

If no source has the file, there is no Fix button. The card says where to get
it instead.

### Fix ground rules

- **Fix never deletes a user's file.** Moves refuse to overwrite. Downloads
  refuse to replace an existing file.
- **Fix never leaves ComfyUI's `models/` folder.** Paths are resolved fully,
  symlinks included, by the agent, not by the API.
- **Every download is checked.** HTTPS from Hugging Face or Civitai only, with
  a sha256 verified before the file lands in its folder.
- **The card is re-checked after every fix.** Never assume a fix worked
  because the task ended.

## How the code fits together

- **Workflows** live in `apps/api/src/workflows/`. Each is a hand-written
  ComfyUI graph in `graphs/*.api.json` plus a manifest in a `.ts` file. The
  manifest binds user-facing values to `<nodeId>.inputs.<name>` paths, with
  ranges. `img2vid-svd.ts` is the newest and simplest example.
- **Registry**: `workflows/registry.ts` picks a workflow by capability and
  model family. Families are inferred from filenames in `models/family.ts`.
- **Companion models** such as text encoders are declared as `requires` on a
  manifest and resolved against the backend in `workflows/requirements.ts`.
- **Folder rules**: `workflows/folders.ts` maps each loader node to the model
  folder it reads.
- **Workflow routes**: `models/workflow-routes.ts` lists templates and pins one
  per model. `models/workflow-choice.ts` decides which workflow a job gets:
  admin pin first, then folder-aware lookup, then plain lookup.
- **Verdicts on model cards** ("Wrong folder", "Needs another model") come
  from `models/runnability.ts`. The cards only display them.
- **Checks before running**: `orchestrator/preflight.ts` refuses a job whose
  files are missing. `models/runnability.ts` produces the verdicts the models
  screen shows: ready, wrong-folder, needs-companion, no-workflow.
- **The agent** is a Go binary in `apps/agent/go/` that runs on the GPU
  machine. It installs, starts and stops ComfyUI and accepts extra launch
  arguments as `comfyArgs`. The API talks to it through
  `apps/api/src/deploy/agent-client.ts`.
- **The web form** is `apps/web/src/create/form.ts`. It keeps its own copy of
  video limits rather than reading them from the API.

## Ground rules

- **Verify with commands, not by reading.** In both `apps/api` and `apps/web`:
  ```bash
  npm test
  npx tsc --noEmit -p .          # apps/web: -p tsconfig.app.json
  ```
  After changing `packages/shared`, run `npm run build` there first. The apps
  read its built copy, so a stale build gives false typecheck results.
  For the agent: `cd apps/agent/go && go test ./...`.
- **Read node specs from the backend.** Before writing a graph, fetch each
  node's inputs from `/object_info/<Node>`. Do not write graphs from memory;
  ComfyUI's inputs change between versions.
- **A workflow counts as working only after a real job succeeds.** Submit the
  compiled graph to `/prompt`, poll `/history/<id>` until it completes, and
  confirm it produced a file. Use small settings to keep GPU time short.
- **Out-of-range values are rejected, not clamped.** Existing tests assert
  this. Do not change it.
- **Follow the house style.** Each workflow file opens with a comment
  explaining its non-obvious choices. Every manifest path is checked by the
  path tests in `workflows/workflows.test.ts`.
- **Do not stop or restart processes you did not start.** That includes the API
  dev server and ComfyUI. Ask a person instead.
- **No LAN access means unit tests only.** If you cannot reach
  192.168.1.10, say so in your report and do not claim real-job verification.
- **One commit per task**, with a message saying why. Update the status table
  above when a model's state changes.
- **Stop and report** if a task needs a model download over 20 GB, a new
  custom node, or a change to the agent's security model. Those need a person.

## Tasks

Ordered by value. Tasks in the same run group can be done in one session.

### Run 1: finish image-to-video

#### Task 1. Per-model video limits in the form

- **Why:** the form offers 1 to 6 seconds at up to 25 fps. SVD samples at most
  25 frames, so only a 1-second SVD clip passes validation.
- **Start:** `apps/web/src/create/form.ts` (length and fps constants),
  `apps/api/src/workflows/img2vid-svd.ts` (the limits).
- **Build:** an API route that returns, per template, the frame range,
  fps range, frame quantum and motion range from its manifest. The form bounds
  its length and fps controls from that route for the selected model.
- **Done when:** selecting SVD at default settings produces a request the API
  accepts. LTX and SVD show different maximum lengths. Both have tests.

#### Task 2. LTX-Video companions

- **Why:** LTX is the second installed video family and is blocked only on
  missing files.
- **Start:** `workflows/txt2vid-ltxv-dm.ts` for `LTXV_DM_REQUIREMENTS`.
- **Build:** confirm which T5 encoder and VAE files the requirements accept.
  Prefer `t5xxl_fp8_e4m3fn` to save memory. Check whether the requirement
  patterns and `preferred` lists match the real filenames that ComfyUI-Manager
  installs, and fix them if not. Installing the files is Task 13's job. If Task
  13 is not done, list the exact files and folders for a person to install.
- **Done when:** with the files present, a real LTX image-to-video job
  succeeds.

#### Task 3. Wan 2.2 TI2V 5B image-to-video

- **Why:** the best image-to-video quality that fits in 16 GB.
- **Start:** copy the shape of `img2vid-svd.ts` and its graph. Use the
  library's `video_wan2_2_5B_ti2v` as the reference graph and for the exact
  model files and URLs. It uses `Wan22ImageToVideoLatent`, `SaveVideo` and
  `CreateVideo`, not `WanImageToVideo`. Read `/object_info` for each node.
  This task doubles as the hand-made answer the library converter in Run 2
  must reproduce.
- **Build:** graph, manifest with `requires` for the UMT5 encoder and the
  Wan 2.2 VAE, presets, a `frameQuantum` of 4, registry entry, tests. Make sure
  `models/family.ts` recognises the 5B filenames.
- **Done when:** tests pass and a real job returns a video. Record resolution,
  frame count and time in the status table.

#### Task 4. Hunyuan Video from `diffusion_models/`

- **Why:** the file is installed but misfiled and has no working graph.
- **Build:** a `-dm` variant of `txt2vid-hunyuan` using `UNETLoader`, with its
  three companions as `requires`. Moving the file is Task 13's job.
- **Done when:** tests pass, and with the file moved and companions installed a
  real job succeeds. It may need Run 3's memory settings to fit.

### Run 2: the workflow library

The biggest change in this plan. Tasks run in order; each builds on the last.
Read "Workflows" above first.

#### Task 5. Read the library

- **Build:** a module in `apps/api/src/library/` that fetches `index.json`
  from a backend, caches it per backend and library version, and fetches
  single workflow files on demand. Store the library version with the cache.
- **Done when:** a test using a saved copy of `index.json` lists 538
  workflows, and a filter for open-source image-to-video returns 14.

#### Task 6. Convert editor format to API format

- **Build:** a pure function taking a workflow file and the backend's
  `/object_info`, returning an API-format graph. It must:
  - flatten subgraphs, rewiring their inputs and outputs;
  - drop display-only nodes such as `MarkdownNote` and `Note`, and resolve
    `Reroute` and bypassed or muted nodes the way ComfyUI does;
  - map positional widget values to input names using `/object_info` order,
    skipping the extra `control_after_generate` value that seed widgets carry;
  - keep link inputs as `[nodeId, slot]`.
- **Test fixtures:** save 5 or more real library files, including
  `video_wan2_2_5B_ti2v` (flat) and `video_wan2_2_14B_i2v` (subgraph), plus
  the backend's `/object_info`, under the test folder.
- **Done when:** unit tests pass on every fixture. Then, against the live
  backend, each fixture's converted graph is accepted by `/prompt` with empty
  `node_errors`. Report the ones that fail and why.

#### Task 7. Find the controls automatically

- **Build:** a mapper that takes a converted graph and writes a manifest. Rules
  for common node types:
  - prompt and negative: the `CLIPTextEncode` feeding a sampler's positive and
    negative inputs, traced through the links, not guessed by title;
  - first frame: the `LoadImage` named in the catalogue's `io.inputs`;
  - seed, steps, cfg, sampler, scheduler: the sampler node's inputs;
  - width, height, length, batch: the latent or image-to-video node's inputs;
  - output: the save node in `io.outputs`, or the only save node;
  - model files: every loader's `properties.models`, becoming `requires`.
  Ranges come from `/object_info`, narrowed to sensible defaults for the family.
- **Done when:** on the Wan 5B fixture, the generated manifest binds the same
  controls as Task 3's hand-written one. Any control the mapper cannot place
  is listed in its output, never guessed.

#### Task 8. Store imported workflows and serve them

- **Build:** a database table for imported workflows: library name, library
  version, converted graph, manifest, status, test result. Make the registry
  and `workflow-choice.ts` read from it alongside the built-in list. Built-in
  workflows win when both cover the same model.
- **Done when:** an imported workflow can run a job end to end through the
  normal job path, and tests cover the precedence rule.

#### Task 9. Check and install per backend

- **Build:** for each imported workflow and backend, work out its status from
  the table in "Workflows": ready, needs files, too big, needs custom node,
  cloud only, not supported. Needs-files gets an Install button that downloads
  each `properties.models` file into its `directory` through the agent download
  endpoint from Task 13. Until Task 13 exists, show the file list with links.
- **Done when:** the statuses on `desktop-6900xt` are correct for the 14
  open-source image-to-video workflows. Report them.

#### Task 10. Admin library screen

- **Build:** a Settings screen listing library workflows with thumbnail,
  title, description, size and status. Filters by category, tag and status.
  Import, install and test buttons. The test runs one job at the cheapest
  settings and records the result.
- **Done when:** an admin can go from the list to a Ready Wan 5B workflow
  without leaving the screen. Verify by driving the web app in a browser.

#### Task 11. User workflow picker

- **Build:** on the Create screen, users pick from Ready workflows as cards
  with the library thumbnail and a one-line description, filtered by what they
  are doing: image, video, or animate. Library workflows carry a small label.
- **Done when:** a non-admin user can pick the imported Wan 5B workflow and
  make a video. Verify in a browser.

### Run 3: fix models from the app

Tasks 13 and 14 give every broken card a working Fix button. They do not
depend on Runs 1 or 2, so they can run in parallel with Run 1. They must be
done before Task 9, whose Install button uses the same download path.

Have a person review this run before merging. It writes files on another
machine. Task 13's download endpoint is what the library's Install button uses.

#### Task 12. One folder table

- **Build:** extend `FOLDER_READ_BY` in `workflows/folders.ts` with every
  loader the templates and installer use, including the GGUF loaders and the
  Wan and Hunyuan encoder types. Make the model installer choose destination
  folders from the same table.
- **Done when:** no other file hardcodes a loader-to-folder mapping. A test
  checks every template's loaders are in the table.

#### Task 13. Agent endpoints to move and download model files

- **Start:** `apps/agent/go/server.go` for routes and `tasks.go` for
  long-running tasks. On the API side, `apps/api/src/deploy/agent-client.ts`.
- **Build:** `POST /agent/models/move` and `POST /agent/models/download`. Both
  return 202 and a task, like the existing install route.
- **Security rules. Each one needs a test.**
  - Resolve both paths fully, symlinks included, and refuse anything outside
    ComfyUI's `models/` folder.
  - Download only from `huggingface.co` and `civitai.com`, over HTTPS.
  - Require a sha256. Download to a temporary file, verify it, then move it
    into place.
  - Never overwrite an existing file unless the request sets an explicit flag.
- **Done when:** Go tests cover every refusal. The API client has matching
  methods with tests.

#### Task 14. The Fix button

- **Read first:** "Fix buttons" above. It defines the behaviour.
- **Start:** `models/runnability.ts` produces the verdicts and already knows
  the target folder and the missing filenames. The Installed cards are in
  `apps/web/src/`; find them by the text "needs moving there".
- **Build:**
  - Add a `fix` plan to each verdict: the steps, sizes and sources, or the
    reason there is no fix. Compute it in the API, not the browser.
  - A route that starts a fix as an agent task, admin only, and logs it.
  - The Fix button, its confirmation, inline progress, and the re-check.
- **Done when:** on `desktop-6900xt`, Fix on the Hunyuan card moves the file
  and the badge leaves Wrong folder. Fix on the LTX card downloads the T5 and
  the VAE, and the badge becomes Will run. A real LTX job then succeeds.
  Verify both in a browser.

#### Task 15. Install companions with the model

- **Build:** installing a model from the catalogue also installs the files its
  workflow's `requires` names, in the same job.
- **Done when:** a test shows installing LTX queues the T5 and VAE too.

#### Task 16. Orphan report

- **Build:** a list of installed files that no workflow can use, such as the
  LTX-2 LoRAs, on the models screen.
- **Done when:** the two LTX LoRAs appear in it on the live backend.

#### Task 17. Fix for missing custom nodes

- **Stop point:** installing third-party code on a machine needs a person's
  approval of the design before you build it.
- **Build:** an agent endpoint that installs a named node pack from an
  allowlist of repositories into `custom_nodes/`, installs its requirements in
  ComfyUI's venv, and restarts ComfyUI. A Fix step for the needs-custom-node
  verdict that uses it.
- **Done when:** installing ComfyUI-GGUF through Fix makes its loaders appear in
  `/object_info`.

### Run 4: run on system memory

#### Task 18. Memory profile per backend

- **Start:** nothing calls the agent's `POST /agent/config` yet. Add it to
  `agent-client.ts`, then a route in `apps/api/src/deploy/routes.ts`, then a
  control in `apps/web/src/settings/DeploymentsSection.tsx`.
- **Build:** four profiles plus a CPU-VAE toggle, written to `comfyArgs` and
  followed by a ComfyUI restart through the agent.

  | Profile | ComfyUI flags | For |
  | --- | --- | --- |
  | Fast | none | fits in VRAM |
  | Balanced | `--reserve-vram 1` | default |
  | Low VRAM | `--lowvram` | weights stream from RAM layer by layer |
  | Minimal VRAM | `--novram` | very slow, runs anything that fits in RAM |

  Check these flags against `python main.py --help` for the installed ComfyUI
  version before using them.
- **Done when:** changing the profile changes the `argv` that
  `/system_stats` reports.

#### Task 19. Offload settings inside workflows

- **Build:** manifest bindings for `CLIPLoader`'s `device` input, set to `cpu`
  under low-memory profiles, and `UNETLoader`'s `weight_dtype`, set to fp8.
  The dispatcher reads the backend's profile and sets them.
- **Done when:** tests show the compiled graph changes with the profile, and a
  real Wan job runs under Low VRAM.

#### Task 20. GGUF models

- **Stop point:** this needs the ComfyUI-GGUF custom node. Ask a person before
  installing it.
- **Build:** agent support for installing it, GGUF loaders in the folder table,
  and GGUF variants of the Wan and Hunyuan workflows.
- **Done when:** a quantised Wan 14B job completes on the 16 GB card.

#### Task 21. Warn before a slow job

- **Build:** record peak VRAM and duration per workflow from real jobs. Warn in
  the form when a job is expected to offload, so slow is expected rather than
  alarming.
- **Done when:** the form shows the warning for Hunyuan under Low VRAM.

### Run 5: keep it working

Any time, and ideally first if you want safer ground for the other runs.

#### Task 22. Refresh the test snapshot

- **Why:** tests use a hand-written copy of the backend's node list that went
  stale. The SVD nodes had to be added by hand.
- **Build:** a script that fetches `/object_info` from a backend and writes a
  trimmed fixture. Point the runnability tests at it.
- **Done when:** the script runs, and tests pass on the generated fixture.

#### Task 23. Smoke test every workflow

- **Build:** a command that compiles each built-in and imported workflow with
  its cheapest settings,
  submits it to a backend, and reports per template: runs, missing file, wrong
  folder, or missing node.
- **Done when:** it produces a report for `desktop-6900xt` that agrees with the
  status table above.

## What is already done

- `img2vid-svd` workflow, registered and verified with a real job.
- The form and the Animate action no longer send a fixed motion value of 127,
  which LTX rejected. Motion is optional in the shared type.
- Duplicate keys in `apps/api/src/lib/comfy.ts` that failed the typecheck.

Done on 2026-09-12:

- **Task 1.** Per-model video limits. `videoLimitsFor` projects each manifest's
  `frameCount`/`fps`/`motion` constraints and `frameQuantum` into a
  `VideoLimits`, carried on `GET /backends/:id/readiness` rather than a new
  route — readiness already resolves the exact template for a model on a backend
  and the form already fetches it. The form derives its duration bound from the
  frame budget per selected rate and clamps during render and at submit.
  Verified with a real SVD job.
- **Task 2.** Not the install, but the two wrong recommendations: the T5
  `preferred` list led with fp16 (9.79 GB, does not fit beside the transformer on
  16 GB) and the LTX VAE list led with a filename that 404s. Both fixed, all
  sizes checked against live HTTP headers. A real LTX job still needs the two
  files above.
- **Task 3.** `img2vid-wan22-ti2v-5b`: graph, manifest, presets, its own family
  (`wan2.2-ti2v-5b`, derived from `wan`, so a 14B file is not routed into a 5B
  graph), UMT5 and Wan-2.2-VAE requirements, registry entry, 17 tests. The
  compiled graph validates on the backend down to the three missing files.

Also measured, not built: the backend serves the workflow library at
`/templates/index.json`, and library files carry model download URLs.

## Reporting back

At the end of each run, report:

- Which tasks are done, with test and typecheck output.
- Which real jobs you ran, with settings, time and result.
- What you could not verify, and why.
- Anything you stopped on that needs a person.
