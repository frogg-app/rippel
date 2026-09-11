# Official workflow fixtures

`index.json` and workflow JSON files are unmodified files from
`comfyui-workflow-templates-json==0.1.68`, the exact dependency of
`comfyui-workflow-templates==0.11.55`. Retrieved from the PyPI wheel on
2026-09-11. The index contains 538 entries; 66 have the Image to Video tag,
of which 14 are open source.

Package metadata:
https://pypi.org/pypi/comfyui-workflow-templates/0.11.55/json
https://pypi.org/pypi/comfyui-workflow-templates-json/0.1.68/json

These are upstream fixtures, not files captured from desktop-6900xt in this
session. The LAN backend is unreachable. Converter unit tests do not establish
that its installed nodes accept these workflows; live `/prompt` validation and
completed outputs remain required.

`object-info.json` was generated on 2026-09-12 with `npm run snapshot:nodes`
against a local CPU-only ComfyUI 0.34.0, commit
`12d5279438bfefc058a269eae805ceab6047777f`, with custom nodes disabled and no
model weights installed. It contains 899 node specifications. To refresh from
the actual GPU machine:

```sh
npm run snapshot:nodes -w @comfy/api -- http://192.168.1.10:8188 src/library/workflows/fixtures/object-info.json
```

Record the backend/version here after refresh. Runnability tests copy this
snapshot and replace only installed-file lists for each scenario.
