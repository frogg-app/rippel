# Windows ROCm agent installation

The old agent used PyTorch's Linux ROCm 6.2 index on Windows. Reproduced on
TUNA on 2026-09-12: pip reported “No matching distribution found for torch”.
The new checkout and Python 3.12 virtual environment were created successfully.

Windows installations now use AMD's stable multi-architecture index, with
GPU-specific extras. The RX 6900 XT selects `device-gfx1030`. The pinned package
combination is torch 2.13.0+rocm10.0.0, torchvision 0.28.0+rocm10.0.0 and
 torchaudio 2.11.0.2+rocm10.0.0. A constraints file protects those versions when
installing ComfyUI requirements. Installation ends by checking that ROCm can
actually see a GPU. Unknown GPU mappings fail instead of selecting CUDA or CPU.

Sources checked on 2026-09-12:

- https://github.com/Comfy-Org/ComfyUI#amd-gpus-windows-rocm-100
- https://github.com/ROCm/TheRock/blob/main/RELEASES.md
- https://stable.repo.amd.com/rocm/whl-next/

The published index contains Windows CPython 3.10–3.14 wheels for these pins.
Actual desktop installation and GPU verification are recorded in MODELS_PLAN.md.
