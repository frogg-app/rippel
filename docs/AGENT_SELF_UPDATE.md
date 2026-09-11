# Agent self-update

Added at the user's request on 2026-09-12. The authenticated agent endpoint is
`POST /agent/update` with `{ "sha256": "<64 hex characters>" }`. No caller-chosen
URL, command or destination is accepted. It downloads its own OS/architecture
binary from the configured rippel server's existing deployment download route,
using its enrollment token. Redirects are refused. Downloads are capped at
64 MiB and verified before publication; failed partial files are removed.

The binary is staged in the agent directory and must successfully identify
itself via `version` before activation. Unix uses atomic rename and re-exec,
preserving the service PID. Windows uses a detached copy of the new binary to
wait for the old agent, replace the installed executable and restart the
scheduled task, with a direct process fallback if necessary. Handoff errors
are recorded in `agent-update.log`. Config and ComfyUI are not rewritten.

The admin API and Deployment settings expose Update agent. Currently the UI
update route supports the distributed Windows amd64 target; other platforms
require an explicit architecture before the API can choose their binary hash.
The agent-side protocol supports all compiled targets.

Validation: Go tests and race tests pass. An actual local Linux agent downloaded,
verified, atomically replaced and re-executed itself with configuration intact.
Windows cross-compilation passes; the first manual replacement on TUNA reported
version 0.3.0. The Windows automatic handoff still needs a live update test.
