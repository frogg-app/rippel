# Tasks 17 and 20: proposed custom-node installation

Status: design ready for review; not implemented or installed.

The first supported pack would be `ComfyUI-GGUF` from
https://github.com/city96/ComfyUI-GGUF. An allowlist entry would pin a reviewed
40-character commit SHA; requests would send only the pack id and that revision,
never a repository URL, shell command, package name or destination path.

An administrator would see the repository, pinned revision, Python dependency
changes and “ComfyUI will restart” before confirming. A stored API operation
would record the administrator, deployment, revision, agent task and outcome.
Ordinary users would see “Ask an admin to fix this.”

The existing token-authenticated agent would:

1. Refuse an unknown pack/revision, a conflicting task, an existing destination,
   an escaping symlink, or a ComfyUI process it does not own.
2. Download the pinned source to an isolated staging directory and verify its
   archive digest. Reject traversal, symlinks and special files in the archive.
3. Show the reviewed, pinned dependency set. Install those dependencies with
   the managed ComfyUI venv's Python, using argument arrays and no shell.
4. Stop its managed ComfyUI, publish the staged pack without overwriting an
   existing pack, restart ComfyUI, and poll `/object_info` for the expected GGUF
   loader classes. Failure would retain logs and report the actual process state.

Dependency installation and node import execute third-party code with the
agent's OS permissions. Filesystem path checks do not sandbox that code. A
failed dependency install may already have changed the venv, so this cannot
promise automatic rollback; the UI must say so before confirmation. Automatic
updates and arbitrary repositories are outside this design.

Tests would cover allowlist/revision refusal, traversal and archive attacks,
auth and role checks, concurrent tasks, subprocess argument boundaries,
non-owned-process refusal, failed dependency installation, failed restart,
and missing-loader verification. GPU validation would run only after review
and after the target machine is reachable.

Approval is required by `MODELS_PLAN.md`, Task 17: “installing third-party code
on a machine needs a person's approval of the design before you build it.”
Task 20 also requires approval before installing ComfyUI-GGUF.
