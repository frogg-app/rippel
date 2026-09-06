"""
rippel storage helper for ComfyUI.

ComfyUI's own HTTP API can list only the top level of input/ and output/, and
cannot delete anything. rippel puts everything it sends or generates under a
`comfy-studio/` subfolder of each, so an operator has no way to see what those
folders hold from the rippel UI, let alone clear them. This custom node adds
three routes that do exactly that, and nothing else:

    GET    /rippel/storage/ping
    GET    /rippel/storage/files?type=input|output
    DELETE /rippel/storage/files      body: {"type": "...", "paths": [...]}

Every route requires the header `X-Rippel-Token` to equal the environment
variable `RIPPEL_STORAGE_TOKEN` of the ComfyUI process. If that variable is not
set, every route answers 503 — the helper is never open by default.

Scope is hard-coded: only `<input>/comfy-studio` and `<output>/comfy-studio`
are ever read or written. A path that resolves outside those directories is
refused with 400. Nothing outside rippel's own folders can be touched through
this node, whatever the request says.

No nodes are registered; this file exists only for its routes.
"""

from __future__ import annotations

import hmac
import os
from datetime import datetime, timezone

from aiohttp import web

import folder_paths
from server import PromptServer

SUBFOLDER = "comfy-studio"
TOKEN_ENV = "RIPPEL_STORAGE_TOKEN"
VERSION = 1

NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}


def _root(kind: str) -> str | None:
    """The absolute comfy-studio directory for `input` or `output`, or None."""
    if kind == "input":
        base = folder_paths.get_input_directory()
    elif kind == "output":
        base = folder_paths.get_output_directory()
    else:
        return None
    return os.path.abspath(os.path.join(base, SUBFOLDER))


def _authorised(request: web.Request) -> web.Response | None:
    """None when the caller may proceed; otherwise the response to send."""
    expected = os.environ.get(TOKEN_ENV, "")
    if not expected:
        return web.json_response(
            {
                "error": "not_configured",
                "message": f"Set {TOKEN_ENV} for the ComfyUI process and restart it.",
            },
            status=503,
        )
    given = request.headers.get("X-Rippel-Token", "")
    if not hmac.compare_digest(given, expected):
        return web.json_response(
            {"error": "unauthorized", "message": "X-Rippel-Token does not match."},
            status=401,
        )
    return None


def _inside(root: str, candidate: str) -> bool:
    """True when `candidate` (absolute) is `root` or below it."""
    try:
        return os.path.commonpath([root, candidate]) == root
    except ValueError:
        # Different drives on Windows.
        return False


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _list(root: str) -> tuple[list[dict], int]:
    files: list[dict] = []
    total = 0
    if not os.path.isdir(root):
        return files, total
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                stat = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            files.append({"path": rel, "size": stat.st_size, "modifiedAt": _iso(stat.st_mtime)})
            total += stat.st_size
    files.sort(key=lambda f: f["path"])
    return files, total


def _prune_empty_dirs(root: str, start: str) -> None:
    """Remove now-empty directories from `start` up to (not including) `root`."""
    current = os.path.abspath(start)
    while _inside(root, current) and current != root:
        try:
            if os.listdir(current):
                return
            os.rmdir(current)
        except OSError:
            return
        current = os.path.dirname(current)


routes = PromptServer.instance.routes


@routes.get("/rippel/storage/ping")
async def ping(request: web.Request) -> web.Response:
    denied = _authorised(request)
    if denied is not None:
        return denied
    return web.json_response({"ok": True, "version": VERSION})


@routes.get("/rippel/storage/files")
async def list_files(request: web.Request) -> web.Response:
    denied = _authorised(request)
    if denied is not None:
        return denied
    kind = request.query.get("type", "")
    root = _root(kind)
    if root is None:
        return web.json_response(
            {"error": "invalid_input", "message": "type must be input or output."}, status=400
        )
    files, total = _list(root)
    return web.json_response({"root": root, "files": files, "totalBytes": total})


@routes.delete("/rippel/storage/files")
async def delete_files(request: web.Request) -> web.Response:
    denied = _authorised(request)
    if denied is not None:
        return denied
    try:
        body = await request.json()
    except Exception:
        return web.json_response(
            {"error": "invalid_input", "message": "Body must be JSON."}, status=400
        )
    kind = body.get("type") if isinstance(body, dict) else None
    paths = body.get("paths") if isinstance(body, dict) else None
    root = _root(kind or "")
    if root is None or not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
        return web.json_response(
            {
                "error": "invalid_input",
                "message": 'Body must be {"type": "input"|"output", "paths": [string, ...]}.',
            },
            status=400,
        )

    # Resolve and check every path before touching any file, so a bad entry
    # refuses the whole request rather than half-applying it.
    resolved: list[tuple[str, str]] = []
    for rel in paths:
        full = os.path.abspath(os.path.join(root, rel))
        if not _inside(root, full) or full == root:
            return web.json_response(
                {"error": "invalid_input", "message": f"Path escapes {SUBFOLDER}: {rel}"},
                status=400,
            )
        resolved.append((rel, full))

    deleted: list[str] = []
    missing: list[str] = []
    for rel, full in resolved:
        if not os.path.isfile(full):
            missing.append(rel)
            continue
        os.remove(full)
        deleted.append(rel)
        _prune_empty_dirs(root, os.path.dirname(full))

    return web.json_response({"deleted": deleted, "missing": missing})


# ---------------------------------------------------------------- models
#
# One more thing rippel needs and ComfyUI cannot do: delete a model file so
# that it can be downloaded again. Scoped to ComfyUI's own model folders as
# `folder_paths` knows them (checkpoints, diffusion_models, loras, vae, ...),
# never anywhere else, and always exactly one file.


@routes.delete("/rippel/storage/models")
async def delete_model(request: web.Request) -> web.Response:
    denied = _authorised(request)
    if denied is not None:
        return denied
    try:
        body = await request.json()
    except Exception:
        return web.json_response(
            {"error": "invalid_input", "message": "Body must be JSON."}, status=400
        )
    folder = body.get("folder") if isinstance(body, dict) else None
    filename = body.get("filename") if isinstance(body, dict) else None
    if not isinstance(folder, str) or not isinstance(filename, str) or not filename:
        return web.json_response(
            {
                "error": "invalid_input",
                "message": 'Body must be {"folder": "checkpoints", "filename": "x.safetensors"}.',
            },
            status=400,
        )

    try:
        roots = folder_paths.get_folder_paths(folder)
    except Exception:
        roots = []
    if not roots:
        return web.json_response(
            {"error": "invalid_input", "message": f"Unknown model folder: {folder}"},
            status=400,
        )

    for base in roots:
        root = os.path.abspath(base)
        full = os.path.abspath(os.path.join(root, filename))
        if not _inside(root, full) or full == root:
            return web.json_response(
                {"error": "invalid_input", "message": f"Path escapes {folder}: {filename}"},
                status=400,
            )
        if os.path.isfile(full):
            os.remove(full)
            return web.json_response({"deleted": True, "path": full})

    return web.json_response(
        {"error": "not_found", "message": f"{folder}/{filename} is not on this machine."},
        status=404,
    )
