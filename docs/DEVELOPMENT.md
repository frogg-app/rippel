# How rippel is developed and deployed

The working practice for anyone, person or agent, changing rippel. It
replaces the old `DEV_SERVER.md`, which described the retired setup under the
`codex` user.

## Where things are

| What | Where |
|---|---|
| Source of truth | GitHub `master`. (`old-master` keeps the GitHub master from before 2026-10-22.) |
| Development checkout | The dev box, `192.168.1.9`: `~/rippel-development/src/rippel`. Every change is made and tested here. |
| Toolchains | On the dev box only: Node, Go (`~/go/bin`), Rust/cargo. |
| dev.rippel.app | The **lilypad** VM, `ssh lilypad` (`ubuntu@192.168.1.42`). Its `~/rippel` is a deploy checkout and is never edited; it only ever receives `git pull --ff-only`. |
| Services on lilypad | systemd **user** units `rippel-api` (port 4000), `rippel-web` (Vite, port 5173) and `rippel-tunnel` (Cloudflare). Lingering is on. |
| Data on lilypad | Docker `rippel-pg` (`127.0.0.1:5433`, database `comfy_codex`) and `rippel-redis` (`127.0.0.1:6380`). |
| Secrets | lilypad `~/.config/rippel/server.env`, which the API unit loads with `--env-file`. Never commit or print them. |
| Windows tray | `apps/tray` (Tauri), built only by the GitHub `tray` workflow on push. |
| Migration archive | `~/rippel-development/` on the dev box also holds the 2026-10-22 hand-over leftovers: codex's source tarball, the old unit files and env files. |

## The loop

1. **Find the cause first.** Read the code, the live logs
   (`journalctl --user -u rippel-api` on lilypad) and the live data before
   changing anything. Most bugs here were a mismatch between two places that
   each decided the same thing, such as three different folder normalisers or
   a route that had gone missing.
2. **Plan anything bigger than a fix** in `docs/plans/YYYY-MM-DD-<topic>.md`:
   the problem, what is true today, phases, and how it will be tested. Write
   it before the code.
3. **Change it, with tests beside it.** Match the surrounding code: its comment
   density (comments say *why*), its naming, its test style. Test against real
   shapes where there are some, for example real Hugging Face file listings
   rather than invented ones.
4. **Verify** (below). Run the whole suites, not only the new tests.
5. **Commit on `master`** with a message that says what was wrong and why the
   change is right, then push. `master` must stay fast-forward; never
   force-push it.
6. **Deploy** (below), then **check it live**: the health endpoint, the
   endpoint you changed, or the numbers in the database.
7. **Report plainly**: what changed, what was verified and how, and what was
   *not* verified (usually "not run on a real GPU machine").

## Verifying

| Package | Commands (run inside the package) |
|---|---|
| `packages/shared` | `npm run build -w @comfy/shared` from the repo root. Required after any type change; the API and web import its build. |
| `apps/api` | `npx tsc --noEmit -p .` and `npx vitest run` |
| `apps/web` | `npx tsc -b` and `npx vitest run`. **Not** `tsc -p .`: the root config has references and that checks nothing. |
| `apps/agent/go` | `PATH=~/go/bin:$PATH go test ./...` and `GOOS=windows go vet .` |
| `apps/tray` | `npx tsc --noEmit -p .` and `cargo check` in `src-tauri` |

## Deploying

Always push to `master` first, then on lilypad:

```sh
ssh lilypad 'cd rippel && git pull --ff-only'
# shared types changed:
ssh lilypad 'cd rippel && npm run build -w @comfy/shared'
# dependencies changed:
ssh lilypad 'cd rippel && npm ci'
# API changed (it runs TypeScript directly; migrations apply on start):
ssh lilypad 'systemctl --user restart rippel-api'
# web changed (Vite serves source; a restart makes sure):
ssh lilypad 'systemctl --user restart rippel-web'
curl -s -o /dev/null -w '%{http_code}\n' https://dev.rippel.app/api/health
```

Migrations live in `apps/api/src/migrations/NNN_name.sql` and are keyed by
their full filename, so never rename one that has run. Rehearse anything
non-trivial on a copy of the database first.

### Releasing the agent (and the tray inside it)

lilypad has no Go, so the binaries it serves are built on the dev box:

1. Bump `AgentVersion` in `apps/agent/go/config.go`. Machines are offered an
   update by version, so an unbumped build is never offered.
2. Commit and push. If `apps/tray` changed, wait for the `tray` workflow:
   `gh run list --workflow tray.yml -L1`, then `gh run watch <id>`.
3. In `apps/agent`: `node scripts/fetch-tray.mjs master` (name the branch;
   the default is whatever branch is checked out), then
   `PATH=~/go/bin:$PATH npm run build:release`.
4. `scp dist/* lilypad:rippel/apps/agent/dist/` and restart `rippel-api`.
5. Check
   `https://dev.rippel.app/api/deployments/agent/windows-amd64/latest`
   shows the new version.

Machines then update from the tray's **Update now**, or from the **Update
agent** button in Settings → Backends. Agents older than 0.4.5 can only use the
web button.

## Looking at live data

Use read-only scripts run inside the API, so they get its environment and
module paths. Delete them afterwards.

```sh
ssh lilypad 'cd rippel/apps/api && cat > src/_probe.ts <<EOF
import { cachedHuggingFaceModels } from "./models/hugging-face-catalogue.js";
console.log((await cachedHuggingFaceModels()).length);
process.exit(0);
EOF
node --env-file=/home/ubuntu/.config/rippel/server.env --import tsx src/_probe.ts; rm src/_probe.ts'
```

To query the database directly:

```sh
ssh lilypad 'docker exec rippel-pg psql -U $(docker exec rippel-pg printenv POSTGRES_USER) -d comfy_codex -c "..."'
```

## Things that have bitten us

- **Build output in commits.** `apps/tray/src-tauri/target` was committed once
  (105 MB) and GitHub refused the push. Check `git status` before committing
  after any build.
- **Mocks too broad.** Route tests that mock a whole module break as soon as
  new code calls another export. Mock only the network call, with
  `vi.mock(path, async (importOriginal) => ({ ...(await importOriginal()), fn: vi.fn() }))`.
- **Family names reused across generations.** FLUX.2 and LTX-2 are new models
  that kept old names; `NEXT_GENERATION` in `models/family.ts` keeps them from
  being run on FLUX.1 / LTX-Video workflows.
- **Hidden ComfyUI windows on Windows.** A venv's `python.exe` is a launcher;
  starting it with `DETACHED_PROCESS` opened a visible console for the real
  interpreter. Start it with `CREATE_NO_WINDOW`.
- **Windows one-liners.** PowerShell and cmd need different quoting; the
  Deployments screen shows both.
- **The headless dev box.** Share URLs as `192.168.1.9`, never `localhost`.

## Conventions

- Commit messages end with the session's attribution lines (`Co-Authored-By`
  and a `Claude-Session` link) when an agent wrote the change.
- The words a person reads come from one vocabulary
  (`apps/web/src/models/vocabulary.ts`): "Style add-on", "Prompt reader" and
  "Image decoder", with the ComfyUI term as a quiet secondary label.
- A verdict or a filter that cannot be sure says so, and does not pass
  something it has not checked.
