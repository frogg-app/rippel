# Official workflow fixtures

`index.json` and workflow JSON files are unmodified files from
`comfyui-workflow-templates-json==0.1.68`, the exact dependency of
`comfyui-workflow-templates==0.11.55`. Retrieved from the PyPI wheel on
2026-09-11. The index contains 538 entries; 66 have the Image to Video tag,
of which 14 are open source.

Package metadata:
https://pypi.org/pypi/comfyui-workflow-templates/0.11.55/json
https://pypi.org/pypi/comfyui-workflow-templates-json/0.1.68/json

The workflow files are upstream fixtures. Converter unit tests alone do not
establish that the GPU accepts them; live `/prompt` validation and completed
outputs remain required.

`object-info.json` was refreshed on 2026-09-12 from the newly agent-deployed
ComfyUI 0.35.0 on desktop-6900xt, with ROCm 10.0/PyTorch 2.13.0, the RX 6900 XT
selected explicitly and no model weights installed. It contains 928 node
specifications. The desktop's current library is 0.11.59 (547 entries, still
14 explicitly open-source image-to-video entries); the saved library fixtures
remain pinned to 0.11.55 to exercise cross-version conversion.

Refresh with:

```sh
npm run snapshot:nodes -w @comfy/api -- http://192.168.1.10:8188 src/library/workflows/fixtures/object-info.json
```

Record the backend/version here after refresh. Runnability tests copy this
snapshot and replace only installed-file lists for each scenario.
