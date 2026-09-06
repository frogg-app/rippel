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
