# Create screen: model prerequisites, file layout, add-on rules, friendlier failures

## Problem

Video mode, "Model Weights 0306" (`Muinez/ltxvideo-2b-nsfw/model_weights_0306.safetensors`,
in `checkpoints/` on steve-pc) failed with `CheckpointLoaderSimple ... Could not detect
model type`, while the Installed tab said "Will run". The Create screen also let an
unknown-family LoRA onto an LTX-Video job, which failed with `Template "img2vid-ltxv"
does not support LoRAs`.

## What is true today

- The file's safetensors header holds only the diffusers-named LTX transformer
  (`transformer_blocks.*`, `time_embed.*`, `proj_in.*`; no `model.diffusion_model.*`,
  no `vae.*`). ComfyUI converts diffusers layouts only for AuraFlow, PixArt, Z-Image,
  Flux and SD3, so no loader reads this file from any folder.
- Runnability and readiness judge files by name, folder and `/object_info`. steve-pc
  lists the file under `CheckpointLoaderSimple` and has `t5xxl_fp16`, so both said ready.
- Readiness already knows each gap's recommended download; the Create screen only used
  it in a "Get it" note on unselectable tiles. LoRA support (`manifest.lora`) never
  reached the client.

## Phases

1. API: `weights-layout.ts` reads a file's header by range request and classifies it
   (bundled / diffusion-only / diffusers / unknown); `weights-probe.ts` probes installed
   checkpoints from their install URL once and stores the answer in `models.metadata`.
   Runnability, readiness and `POST /jobs` use it. Readiness also reports `takesLoras`.
   `POST /jobs` refuses unsupported or mismatched LoRAs with a 400 in plain words.
   Failure classifier gains `unreadable-model` and links.
2. Web: fit pills on tiles, runnable-first order, needs-setup tiles selectable with an
   inline notice (per-part Install with progress, Find on Models), Generate explains
   what is missing. LoRA section follows `takesLoras` and family, drops invalid
   selections with a notice, groups unknown-family styles under "Might not match".
   Failures show a plain headline, steps, a link, and the raw text under "Details".

## Testing

Real header fixtures (the Muinez file and Lightricks' single-file build) for the
classifier; runnability/readiness cases reproducing steve-pc; LoRA rule unit tests;
CreatePage tests for the notice, install-by-ref, Generate gating and LoRA drop.
