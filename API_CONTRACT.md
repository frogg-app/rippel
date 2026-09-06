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
