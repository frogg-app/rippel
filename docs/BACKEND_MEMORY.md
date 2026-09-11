# Backend memory usage

Settings → Backends → Memory usage offers two per-machine policies from agent 0.3.1:

- **Automatic** keeps ComfyUI's normal memory management, including its existing RAM offloading.
- **Use more system RAM** uses ComfyUI's `--novram` option to minimize GPU-resident model weights. This can help larger models fit, at the cost of slower generation. Available RAM, model operations and image/video dimensions still limit what can run.

Apply and restart restarts an agent-owned running engine and shows progress until it responds. Applying while stopped saves the choice for the next start. Active generation and model downloads block the change. The agent preserves GPU selection and other non-memory launch options, and refuses to restart an externally managed engine.

The choice is persisted as `memoryMode` in the agent's config. Automatic is the default; selecting RAM does not change hardware memory or combine RAM and VRAM into one guaranteed capacity.

Implementation uses `--novram` because current ComfyUI's `--lowvram` has no effect while dynamic VRAM is enabled. See [ComfyUI CLI arguments](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/cli_args.py).
