# Hugging Face models you can actually install

Written 2026-10-22.

## The problem

Every Hugging Face entry in Discover (2,755 of them) carries
`installBlockedReason`, because an entry is a whole repository and nothing
chooses which file in it to download. All 1,778 models therefore have no
verdict and "Works on this machine" hides them; the add-ons skipped that check
and flooded the list (fixed separately: blocked entries no longer pass).

A repository usually holds several builds of one model: the full weights
(fp16/bf16), a smaller fp8 file, sometimes a distilled one, and in GGUF repos a
ladder of quantised files (Q8 down to Q2). Those builds are what a person should
be choosing between, sized against their graphics card.

## What "Works on this machine" checks today

An entry passes when its verdict is ready, generic or needs-companion:

1. we have a workflow template for the model's family;
2. the file would land in the folder that workflow's loader reads;
3. the other files that workflow needs (text encoder, decoder) are on the
   machine, or are known downloads that can come with it.

It does **not** check that the file fits in the card's memory. Add-ons (LoRAs,
decoders, enlargers) pass as long as they can be installed; they are not checked
against the families the machine can run.

## Plan

### 1. Choose files (API, `models/hugging-face-files.ts`)

From the repository file list the listing already returns (`siblings`):

- keep single weight files: `.safetensors` and `.gguf` at the top level, or under
  `split_files/diffusion_models|checkpoints|loras|vae/` (Comfy-Org's layout);
- drop shards, Diffusers sub-folders, `.ckpt`/`.bin` (pickles), Apple MLX,
  NVFP4/SVDQuant/INT4 builds, and side files in a model repo (its VAE, text
  encoder, example LoRA);
- label each one: **Full** (fp32/fp16/bf16), **Smaller (fp8)**, **Distilled**,
  **Compact GGUF Q8 … Q2**.

The entry gets `variants`, and its default `filename`/`url` become the best
full-precision file (or, in a GGUF-only repo, the best quantisation). An entry
with no usable file stays blocked, saying why ("Diffusers folders only").

### 2. Family and folder

Map Hugging Face ids (`black-forest-labs/FLUX.1-dev`,
`stabilityai/stable-diffusion-xl-base-1.0`) to our families, so a variant is
judged against the right workflow. GGUF and `split_files/diffusion_models`
files go to `diffusion_models/`.

### 3. Versions, sizes and a recommendation

`GET /backends/:id/catalogue/variants?ref=` reads the repository tree (sizes and
SHA-256), cached for an hour, and marks the variant recommended for the card:
the largest file that fits in the machine's graphics memory with headroom.

### 4. Install a chosen version

The install route takes `variant`; the entry is re-pointed at that file before
it is judged and queued. Only agent-managed machines can install these
(ComfyUI-Manager installs only its own list), so other backends keep the
blocked reason.

### 5. GGUF

GGUF files need the ComfyUI-GGUF node (`UnetLoaderGGUF`). When the machine has
it, the workflow's diffusion-model loader is swapped for it; when it does not,
the verdict says the machine needs GGUF support rather than hiding the model.

### 6. Web

- Drawer: a **Version** picker (label, size, "Recommended for this machine"),
  and Install installs that version.
- Card: "N versions" and the recommended version's size.
- Discover: a **Version** filter (Full · Distilled · Smaller · GGUF).

## Testing

Unit tests for file selection and labelling on real repository listings
(SDXL base, FLUX.1-dev, a Comfy-Org split repo, a GGUF repo, a LoRA repo, a
Diffusers-only repo); route tests for the variants endpoint and installing a
chosen variant; web tests for the picker. Verified against the live catalogue
on dev after deploying.
