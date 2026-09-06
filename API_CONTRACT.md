# API contract — phase 2/3 surface

Written up front so the orchestrator, the library API and the web screens can be
built in parallel against the same shapes instead of guessing at each other.
Every type named here already exists in `packages/shared/src/index.ts` — none of
them are invented for this document, and none of them should be redefined.

All routes are under `/api`. Auth is the existing session cookie; every route
requires it (`app.requireAuth`) and is scoped to the calling user. Errors use the
existing `ApiError` shape: `{ error: string, message: string }`.

## Jobs — owned by the orchestrator

    POST   /jobs                 { params: GenerationParams } -> 202 { job: Job }
    GET    /jobs?limit&status    -> { jobs: Job[] }        newest first
    GET    /jobs/:id             -> { job: Job }
    POST   /jobs/:id/cancel      -> { job: Job }

`POST /jobs` validates, compiles and persists before returning; it does not wait
for the backend. The returned `Job` is `queued` with a `queuePosition`.

Failure modes worth coding against: 400 with `error: "invalid_input"` when the
params fail the manifest's constraints (the message names the offending control's
label), 409 `no_backend` when no online backend has the model, and 501
`no_template` when the model's family has no template for that capability.

## Realtime — owned by the orchestrator

    WS     /events

Cookie-authenticated, scoped to one user, emits `JobEvent` frames verbatim as
defined in the shared types (`job.created`, `job.status`, `job.progress`,
`job.complete`, `job.failed`, `backend.status`). Clients must tolerate an
unknown `type` and must reconnect on close.

## Library — owned by the library API

Note the namespace: `/api/assets/:id` and `/api/assets/:id/thumb` already exist
and serve *bytes* (see `src/storage/routes.ts`). Metadata lives under `/library`
so the two never collide.

    GET    /library/assets       ?limit&cursor&kind&starred&collectionId&q
                                 -> { assets: Asset[], nextCursor: string | null }
    GET    /library/assets/:id   -> { asset: Asset, job: Job | null }
    PATCH  /library/assets/:id   { starred?: boolean } -> { asset: Asset }
    DELETE /library/assets/:id   -> 204        soft delete, sets deleted_at

    GET    /library/collections  -> { collections: { id, name, count }[] }
    POST   /library/collections  { name } -> 201 { collection }
    DELETE /library/collections/:id -> 204
    PUT    /library/collections/:id/assets/:assetId    -> 204   add
    DELETE /library/collections/:id/assets/:assetId    -> 204   remove

Paging is cursor-based, not offset: the grid is an infinite scroll over a table
that gains rows at the top while you read it, and offsets duplicate rows when
that happens.

## Uploads — owned by the uploads/img2img work

    POST   /uploads              multipart, field `file` -> 201 { upload: Upload }

Feeds `ImageSource: { from: 'upload', uploadId }` in `GenerationParams`.

---

## Progress detail (added for the "nice feedback" work)

The problem this addresses: a generation spends most of its wall clock in
phases that are not sampling — the backend loads a checkpoint, encodes text,
then samples, then decodes the VAE (on this hardware, on the CPU, slowly), then
we download and thumbnail the result. Reporting only sampler steps means the
bar sits at 0% and then at 100% for a long time, which reads as broken.

`JobProgress` gains two optional fields. Both are additive; every existing
field keeps its meaning.

    phase?: 'queued' | 'preparing' | 'sampling' | 'decoding' | 'saving' | null
    phaseLabel?: string | null      // human, e.g. "Loading SDXL", "Decoding image"

`fraction` stays the single best number for a bar and remains 0..1 within the
*sampling* phase. A client must not assume the bar is meaningful outside it —
show an indeterminate state when `phase` is set and is not `sampling`.

`JobEvent` is unchanged in shape. `job.complete` already carries the finished
`assets`, and a client that receives it MUST render them without refetching;
the array is authoritative.

### What the backend emits, and when

  - `preparing` — from dispatch until the first sampler step. Covers ComfyUI
    loading weights, which is minutes on a cold model.
  - `sampling`  — driven by ComfyUI's per-step progress frames.
  - `decoding`  — after the last step, while the VAE runs.
  - `saving`    — our own download/thumbnail/store pass (job status `uploading`).

ComfyUI's WebSocket vocabulary has moved: recent versions emit `progress_state`
with per-node state alongside (or instead of) the older flat `progress` frame.
Handle both; the older one is what this project was originally written against.

---

## Queue

There is one GPU and several people. The queue is therefore a real, visible
object rather than an implementation detail, and an admin needs to be able to
act on it.

    GET   /queue                  -> { entries: QueueEntry[], running: QueueEntry | null }
    POST  /jobs/:id/cancel        existing; owner or admin
    POST  /queue/:id/priority     { position: 'top' }        admin only
    DELETE /queue/:id             admin only, cancels someone else's queued job

`QueueEntry` is a `Job` plus who owns it and where it sits:

    { job: Job, position: number, ownerName: string | null, ownerId: Uuid }

Non-admins see the queue too — knowing whether ten jobs are ahead of you is the
difference between waiting and reloading — but they see only their OWN prompts.
Another user's entry is present, with its position and a display name, and its
`job.params` withheld. That is deliberate: the length of the queue is not
private, but what someone typed into it is.

`Job.queuePosition` stays per-user (how many of *your* jobs are ahead). The
queue view's `position` is global. Both are needed and they are not the same
number; do not conflate them.

`job.status` events already fire on every transition, so a client watching the
socket can keep a queue view live without polling.

## Backend storage — owned by the storage-management work

What rippel has left on a ComfyUI machine's disk, per backend, and a way to
clear it. Admin only. Stock ComfyUI cannot list below the top level of
`input/`/`output/` and cannot delete, so both routes go through the
**comfyui-rippel-storage** helper node (`tools/comfyui-rippel-storage/`,
copied into the backend's `custom_nodes/`, sharing a token with the API's
`COMFY_STORAGE_TOKEN`). Only the backend's `input/comfy-studio/` and
`output/comfy-studio/` are ever read or deleted — the folders rippel itself
writes to.

```
GET    /api/backends/:id/storage            requireAdmin
  -> 200 BackendStorage
       { helper: 'ok' | 'missing' | 'unauthorised' | 'offline',
         input:  { totalBytes, files: StorageFile[] },
         output: { totalBytes, files: StorageFile[] } }
     helper !== 'ok' comes with two empty groups:
       missing       the helper answered 404 (not installed / not restarted)
       unauthorised  401 or 503 (token unset on either side, or mismatched)
       offline       the backend did not answer at all
  -> 404 not_found

DELETE /api/backends/:id/storage            requireAdmin
  body { type: 'input' | 'output', paths: string[] }
  -> 200 { deleted: string[], missing: string[] }
  -> 400 invalid_input   bad type, empty paths, or (from the helper) a path
                         that resolves outside comfy-studio
  -> 502 helper_<state>  the helper was missing / unauthorised / offline
```

`StorageFile` is `{ path, size, modifiedAt, owner, jobId?, assetId?,
uploadId? }`. `path` is relative to the `comfy-studio` folder with forward
slashes. `owner` is `{ id, email, displayName }` or `null` when nothing in
rippel's records matches ("not tracked by rippel").

Attribution is by construction. An output sits at
`<kind>/<jobId>/<file>` (the compiler's `filename_prefix`), so the job's owner
is the owner and the asset is matched on `(job_id, source_filename)`. An input
sits at `<hash>.<ext>` where `<hash>` is the first 32 hex characters of
sha256 of the stored bytes (`workflows/init-image.ts`); `uploads.content_hash`
and `assets.content_hash` (migration 010) are written on insert and backfilled
for older rows a bounded batch per request.

**Deleting here removes the file from the ComfyUI disk only.** The user's
library copy lives in rippel's own storage and is never touched by this route.

## Backends — admin management

Backends were seeded from `COMFY_BACKENDS` only. Administrators can now add,
change, remove and test them from Settings. A create or edit asks the poller
to visit the backend at once, so `status` usually settles within a second;
until then it is `'unknown'` (or `'offline'` if the backend is disabled).

```
POST   /api/backends                        requireAdmin
  body { name, baseUrl, enabled?, vramLimitMb? }
  -> 201 { backend: Backend }
  -> 400 invalid_input  { field: 'name' | 'baseUrl' | 'enabled' | 'vramLimitMb' }
       baseUrl must be an http(s) origin (no path or query); it is stored
       normalised, without a trailing slash.
  -> 409 conflict       another backend already has that name (case-insensitive)

PATCH  /api/backends/:id                    requireAdmin
  body any subset of { name, baseUrl, enabled, vramLimitMb: number | null }
  -> 200 { backend: Backend }   status resets to 'unknown' when baseUrl changes
  -> 400 invalid_input | 404 not_found | 409 conflict

DELETE /api/backends/:id                    requireAdmin
  -> 204
  -> 409 busy   a job is dispatched/running/uploading on it right now
  Models it reported stay in the catalogue; their availability rows for this
  backend cascade away.

POST   /api/backends/:id/probe              requireAdmin
POST   /api/backends/probe  { baseUrl }     requireAdmin   (test before saving)
  -> 200 BackendProbe { ok, latencyMs, version?, device?, vramTotal?, error? }
  A probe never writes. ok:false carries the reason: refused, timed out
  (4s), or answered but not like ComfyUI. `vramTotal` is what the backend
  reports — a budget, not the card's size.
```

## Model workflows — owned by the workflows-per-model work

Every job runs on a *template*: a hand-authored ComfyUI graph keyed by
(capability, model family) in `src/workflows/registry.ts`. Two things changed
in this work and both show up in the contract below.

**Two templates can serve one family from different folders.** The LTX-Video
graphs exist in a `checkpoints/` flavour (`txt2vid-ltxv`, `img2vid-ltxv`,
loading with `CheckpointLoaderSimple`) and a `diffusion_models/` flavour
(`txt2vid-ltxv-dm`, `img2vid-ltxv-dm`, loading with `UNETLoader` plus a
separate VAE). The automatic choice reads `/object_info` to see which loader
lists the file and picks the graph that reads that folder. `txt2vid-hunyuan`
is the Hunyuan Video graph (UNETLoader, DualCLIPLoader, VAELoader — ComfyUI's
own example, node for node).

**An operator can pin a template per model and capability** (`model_workflows`,
migration 011). The pin outranks the automatic choice at `POST /jobs`, in the
dispatcher and in the readiness route — one function, `chooseTemplate` in
`src/models/workflow-choice.ts`, answers all three. A pin naming a template the
registry no longer ships is ignored, not honoured.

`ModelRunnability` gained an optional `templateId`: the template the verdict
was measured against.

```
GET    /api/workflows/templates             requireAuth
  -> 200 { templates: WorkflowTemplateSummary[] }
  Every template: id, label, capability, baseModels, isFallback, loaderFolder
  (where its model loader reads), loaderFolders (every folder the graph
  reads), requires (companion files), requiredNodeClasses, description.

GET    /api/models/:id/workflows?backendId=  requireAuth
  -> 200 ModelWorkflows
       { model: { id, displayName, filename, family, folder },
         backend: { id, name } | null,
         assigned: { [capability]: templateId },
         options: [{ template, verdict: ModelRunnability, automatic, assigned }] }
  `folder` is where the file is on that backend per /object_info (null when
  unreadable). `options` holds every template that could serve the family,
  each with a verdict measured against that template alone, `automatic` (what
  the rules would pick) and `assigned` (what an operator pinned). Without
  `backendId` the first online backend holding the model is used.
  -> 404 not_found   no such model / no such backend

PUT    /api/models/:id/workflows            requireAdmin
  body { capability: JobKind, templateId: string | null }   null = automatic
  -> 200 { assigned }
  -> 400 invalid_input   wrong capability for that template, or a template
                         not written for the model's family
  -> 404 not_found       no such model / no such template

DELETE /api/models/:id                      requireAdmin
  -> 200 { removal: ModelRemoval { removed, removedFromDisk, note } }
  Removes the record and its backend links. **The file is not deleted**:
  ComfyUI and ComfyUI-Manager expose no route that deletes a model, so
  `removedFromDisk` is false and `note` says which machine still has it and
  that the next backend scan will list it again until it is deleted there.
  `deleteBackendFile` in src/models/workflow-routes.ts is the hook for a
  backend that can (the rippel storage helper, once it grows a model mode).
```

Model removal and the disk: `DELETE /api/models/:id` deletes the file on
each backend through the helper's `DELETE /rippel/storage/models`
`{ folder, filename }` when `COMFY_STORAGE_TOKEN` is set and the helper is
installed there; otherwise the record goes and `kept` names the file that
stayed (the poller will re-list it on its next scan).
