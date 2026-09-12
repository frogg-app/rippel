# Handover — 2026-09-12

Replaces the 2026-09-06 version, which had gone badly stale: it claimed nothing
was committed to git, described a database container that is two migrations
behind, and listed models that are no longer on the test machine.

## Where things stand

Branch `check-project-status`, 15 commits ahead of `origin/master`, nothing
pushed. Working tree clean. 807 API tests, 304 web tests, the Go agent's suite,
and every typecheck pass.

`MODELS_PLAN.md` is the live plan. Runs 1 and 4 are done; Run 2 (the workflow
library converter) and Run 3 (Fix buttons) are not started, and Run 3 has a
blocker described below.

## Two things that are broken and are not code

**The test backend is down.** `192.168.1.10:8188` and the agent on `:8189` have
both refused connections since the middle of 2026-09-12. It answered earlier
that day — an SVD job really ran on it — so this is the machine, not the app.
Everything since has been verified offline.

**ComfyUI-Manager is gone from that machine.** `/customnode/getmappings` and
`/externalmodel/getlist` both 404. That leaves the app with **no install
transport** to it: `models/installs.ts` cannot queue a download, and Run 3's Fix
buttons would have nothing to call. This is the biggest unplanned blocker in the
plan and wants a decision — reinstall Manager, or give the agent its own
model-download route.

## What landed on 2026-09-12

In order, and each commit message carries the reasoning:

1. **Per-model video limits.** The duration slider offered LTX-Video's frame
   budget to every model, so the form's own default was rejected for Stable
   Video Diffusion — 100 frames against a 25-frame ceiling. Limits now come from
   the manifest that does the rejecting, ride on the readiness endpoint, and are
   converted from frames to seconds per selected rate. Verified with a real job.
2. **LTX companion fixes.** The T5 list led with a build that does not fit; the
   VAE list led with a filename that 404s.
3. **Wan 2.2 TI2V 5B image-to-video.** Graph, manifest, presets, its own family,
   17 tests. Validated on the live backend down to three missing-file errors.
4. **The stale-panel fix.** A machine could say OFFLINE in red while three green
   pips claimed its engine was running.
5. **Failure classification.** Out-of-memory, missing file, missing node, lost
   contact — each with a headline and a next move, the raw text kept under a
   disclosure.
6. **The fit ledger.** Every finished job records a size score and whether it
   died for want of memory; each machine gets a learned ceiling and floor. This
   is the README's "durable fix: learning each backend's real ceiling from
   observed job outcomes".
7. **Memory profiles.** Fast / Balanced / Low VRAM / Minimal, plus a CPU-decode
   switch, written to the agent's `comfyArgs` — which existed and had never been
   written to. Low-memory profiles also rewrite the graph: text encoder to CPU,
   and at Minimal the transformer quantised on load.
8. **Warnings and routing off the ledger.** The Create screen warns before a job
   that this machine has already failed at, and the dispatcher sends a big job
   to a machine that has finished one.
9. **Offline graph validation.** Node specs captured to a fixture; every shipped
   graph checked against them in the test suite.

## Picking it up

```bash
cd /home/frogg/.fde/worktrees/2id8pgcb/loud-lynx
npm install
npm run build -w @comfy/shared        # both apps read its built output
cd apps/api && npm test               # or: npx tsc --noEmit -p .
cd ../web && npm test                 # typecheck: npx tsc --noEmit -p tsconfig.app.json
cd ../agent/go && go test ./...
```

A dev database, if you want to run the API rather than just its tests:

```bash
docker start comfy-dev-pg 2>/dev/null || docker run -d --name comfy-dev-pg \
  -e POSTGRES_USER=comfy -e POSTGRES_PASSWORD=comfy -e POSTGRES_DB=comfy_studio \
  -p 5433:5432 postgres:17.5-alpine
cd apps/api && set -a && . ../../.env && set +a && npx tsx src/index.ts
```

Migrations run at boot and are append-only. Two are new and unapplied anywhere:
`015_job_size_and_oom.sql` and `016_deployment_memory_profile.sql`.

## The first things to do when that machine is back

1. **Refresh the node-spec fixture.** `node tools/capture-object-info.mjs
   http://192.168.1.10:8188`. The current one was typed by hand from console
   output and is missing `CLIPTextEncode`; a test names that gap and will go
   green when it closes.
2. **Check the memory-profile flags** against `python main.py --help` for
   ComfyUI 0.35. They are long-standing arguments and `--cpu-vae` is one that
   machine was already launched with, but the plan's ground rules ask for the
   check and it has not been possible.
3. **Install the model files** listed in `MODELS_PLAN.md` under "Files a person
   needs to install" — 10.9 GB unblocks a real LTX image-to-video job, 16.9 GB
   unblocks Wan 2.2. Both templates are written and structurally validated;
   neither has produced a clip.
4. **Run one job per profile** to give the fit ledger its first observations. It
   answers `unknown` and shows nothing until a machine has finished something,
   so it is inert on a fresh install by design.

## Things worth knowing before changing any of this

- **The reported VRAM figure is not the card's size.** See the README section
  before "fixing" it. The fit ledger deliberately never compares against it.
- **Scores are an ordering, not a measurement.** `cost.ts` has arbitrary
  constants and is only ever compared within one backend. Do not put a score in
  front of a user as a number of gigabytes.
- **Out-of-range values are rejected, not clamped**, server-side. Existing tests
  assert this. The form now avoids *producing* out-of-range values, which is a
  different thing.
- **`withInitImage` writes to node `10`**, always, with no node id passed. Any
  new img2* graph must number its `LoadImage` 10 or the picture is silently
  dropped.
- **Migrations are append-only.** Never edit one that has shipped.
- The UI in the 0.4.2 screenshot from 2026-09-12 is **not in this repository** —
  not in any branch, commit, or sibling worktree, and this repo's agent is
  0.2.0. It was agreed to leave it aside and merge later.
