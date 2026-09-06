# comfyui-rippel-storage

A tiny ComfyUI custom node that lets rippel see and clear the files it has put
on a ComfyUI machine. It registers no nodes, only three HTTP routes, and it only
ever touches rippel's own subfolders:

- `<ComfyUI>/input/comfy-studio/` — starting images rippel uploaded
- `<ComfyUI>/output/comfy-studio/` — renders rippel generated

Nothing else under `input/` or `output/` can be listed or deleted through it,
whatever the request asks for.

Stock ComfyUI can list only the top level of those folders and cannot delete
anything, which is why this exists.

## Install (Windows)

1. Copy this folder into the ComfyUI install:

   ```
   <ComfyUI>\custom_nodes\comfyui-rippel-storage\
   ```

   It needs no dependencies beyond ComfyUI itself.

2. Choose a long random token and set it for the ComfyUI **process**. The
   helper answers 503 until it is set; it is never open by default.

   - Portable build: edit `run_nvidia_gpu.bat` (or the launcher you use) and
     add, above the line that starts python:

     ```bat
     set RIPPEL_STORAGE_TOKEN=paste-a-long-random-token-here
     ```

   - Desktop app / manual venv: set it as a user environment variable
     (Settings → System → Environment variables), then fully quit and reopen
     ComfyUI.

3. Restart ComfyUI. The startup log should list `comfyui-rippel-storage`.

4. Give rippel the same token: in rippel's `.env`, set

   ```
   COMFY_STORAGE_TOKEN=paste-the-same-token-here
   ```

   and restart the rippel API.

5. Verify from any machine on the LAN:

   ```
   curl -H "X-Rippel-Token: <token>" http://<comfyui-host>:8188/rippel/storage/ping
   ```

   Expected: `{"ok": true, "version": 1}`. A 503 means the variable is not set
   for the running process; a 401 means the tokens differ; a 404 means the
   folder is not in `custom_nodes` or ComfyUI was not restarted.

Then open rippel → Models → **Storage** (administrators only).

## Routes

All require the header `X-Rippel-Token`.

| Route | Purpose |
| --- | --- |
| `GET /rippel/storage/ping` | `{ ok, version }` |
| `GET /rippel/storage/files?type=input\|output` | `{ root, files: [{ path, size, modifiedAt }], totalBytes }`, recursive under `comfy-studio/` |
| `DELETE /rippel/storage/files` body `{ type, paths }` | Deletes those files, prunes emptied folders, returns `{ deleted, missing }` |
| `DELETE /rippel/storage/models` body `{ folder, filename }` | Deletes one model file from a ComfyUI model folder (`checkpoints`, `diffusion_models`, `loras`, …) so rippel can download it again; 404 when it is not there |

Paths are relative to the `comfy-studio` folder with forward slashes. A path
that resolves outside it is refused with 400 and nothing is deleted.

Deleting a file here removes it from the ComfyUI disk only. The copy in a
user's rippel library is untouched.
