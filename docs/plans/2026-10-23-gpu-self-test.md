# GPU self-test and repair

**Problem.** steve-pc (RX 6900 XT, gfx1030, plus a Ryzen iGPU, gfx1036) ran
torch 2.13.0+rocm10.0.0 with `device-gfx1030` kernels, the right wheel for the card. But HIP
lists the iGPU as device 0 ("AMD Radeon(TM) Graphics", 39 GB shared memory),
ComfyUI used device 0, and every op (VAEEncode, CLIPTextEncode) failed with
hipErrorInvalidImage. The install check only asked `torch.cuda.is_available()`.

**Agent (0.4.14).**
- Choose the wheel target per adapter, preferring the discrete card, and cover
  every gfx extra AMD publishes (TheRock RELEASES.md, 2026-10-23).
- `gpu_health.go`: list torch devices (`gcnArchName`) and run an fp16 VAE-sized
  conv on each, wheel target and discrete cards first. Pin the first that
  passes with `HIP_VISIBLE_DEVICES` / `CUDA_VISIBLE_DEVICES`.
- If none pass: install the wheel for each arch the devices report (cu128 on
  NVIDIA), then fall back to CPU torch and `--cpu`. Report `gpuHealth` in
  ComfyState.
- Runs after install, on start when the drivers or torch changed, and from
  `POST /agent/gpu/repair`.

**API/web.** A `gpu-setup` failure kind gives one line plus Repair (admins) or
"Ask an admin" (others), with the raw error under Details. `/backends` carries
`gpuState`, and Generate is blocked when the target machine is `unsupported`.
The machine card shows a GPU pill and a "Repair GPU setup" button.

**Tested.** Go unit tests with steve-pc's real device list, plus API and web
tests. Not run on a real GPU.
