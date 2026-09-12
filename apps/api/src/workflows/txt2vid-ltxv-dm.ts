/**
 * txt2vid for LTX-Video, loading the model from `diffusion_models/`.
 *
 * The sibling of txt2vid-ltxv.ts, for the file that ended up in the other
 * folder. ComfyUI-Manager's catalogue installs `ltx-video-2b-v0.9.1` to
 * `checkpoints/LTXV/`, but the reference box has it in `diffusion_models/`
 * (Manager matches by filename, so it believes the install is done and will
 * not fetch it again), and `CheckpointLoaderSimple` can never see a file in
 * that folder. The registry keys templates by (capability, family) and until
 * now allowed one graph per key, so that file's verdict was "on disk, but the
 * workflow cannot see it" with no route to running short of moving the file
 * by hand on a machine the API cannot touch.
 *
 * This graph is the same node set with the loader swapped:
 *
 *  - **`UNETLoader` (4) in place of `CheckpointLoaderSimple`.** It reads
 *    `diffusion_models/`, which is where the file is. It yields MODEL only.
 *  - **`VAELoader` (16) for the decode.** The VAE that lives inside an LTX
 *    checkpoint is not reachable through `UNETLoader`, so it has to come from
 *    `vae/` as a separate file. That is a genuine companion requirement, and
 *    the runnability check names it as one: a backend with the model in
 *    `diffusion_models/` and no LTX VAE is "needs another model first", which
 *    is a true sentence with a download attached, rather than "wrong folder",
 *    which is a true sentence with nothing attached.
 *  - The T5 (12) is the same requirement object the checkpoints graph uses.
 *
 * Everything else — conditioning, scheduler, sampler, save — is byte-identical
 * to txt2vid-ltxv, and the manifest inputs are that file's list with the
 * checkpoint binding repointed at `unet_name`. Which of the two templates a
 * job gets is decided by where the file actually is: see `resolveTemplate`
 * and `folderOfInstalled` in folders.ts.
 *
 * Node classes and input names verified against `/object_info` on ComfyUI
 * 0.34 at 192.168.1.10:8188 on 2026-09-07: `UNETLoader{unet_name,
 * weight_dtype}` (and it lists exactly this file), `VAELoader{vae_name}`,
 * `CLIPLoader{clip_name, type}` with `ltxv` among the types.
 */

import type { ComfyApiGraph, ManifestInput, ModelRequirement, WorkflowManifest, WorkflowTemplate } from './types.js';
import {
  LTXV_FRAME_QUANTUM,
  LTXV_QUALITY_PRESETS,
  LTXV_RESOLUTIONS,
} from './presets.js';
import {
  LTXV_BASE_MODELS,
  LTXV_TEXT_ENCODER_REQUIREMENT,
  TXT2VID_LTXV_INPUTS,
} from './txt2vid-ltxv.js';
import rawGraph from './graphs/txt2vid-ltxv-dm.api.json' with { type: 'json' };

export const txt2vidLtxvDmGraph = rawGraph as unknown as ComfyApiGraph;

/**
 * The VAE the diffusion_models route needs and the checkpoints route does not.
 *
 * Any LTX-Video safetensors placed in `vae/` will do — ComfyUI's VAE loader
 * detects the LTXV VAE from its keys, so the full checkpoint file copied into
 * `vae/` works as well as a VAE-only extraction. The match is therefore on the
 * family name rather than on a specific build.
 */
export const LTXV_VAE_REQUIREMENT: ModelRequirement = {
  id: 'vae',
  path: '16.inputs.vae_name',
  modelType: 'vae',
  label: 'LTX-Video VAE',
  why:
    'Loading the model from diffusion_models gives only the transformer; the VAE that ' +
    'decodes its latents into frames has to come from the vae folder as a separate file.',
  match: {
    filename: /ltx/i,
    catalogueBase: ['ltxv', 'ltx-video', 'LTX-Video'],
    catalogueFilename: /ltx/i,
  },
  // The full checkpoint, because a VAE-only LTX-Video file does not exist.
  //
  // `ltx-video-2b-v0.9.1-vae.safetensors` was the first entry here and there is
  // no such file: Lightricks/LTX-Video ships the 2B and 13B checkpoints plus
  // `vae/diffusion_pytorch_model.safetensors`, which is the diffusers layout
  // and matches neither this requirement's `/ltx/i` filename pattern nor
  // anything ComfyUI's `vae/` folder would name. So the head of this list was a
  // 404 offered as the recommended download.
  //
  // Copying the checkpoint into `vae/` is the real answer and it works, because
  // ComfyUI's VAE loader detects the LTXV VAE from the tensor keys — see the
  // note above on why the match is on the family rather than a specific build.
  // It costs 5.72 GB of disk for a second copy of a file the machine already
  // has, which is worth saying out loud in the instruction rather than hiding
  // behind a filename that cannot be fetched.
  preferred: ['ltx-video-2b-v0.9.1.safetensors', 'ltx-video-2b-v0.9.5.safetensors'],
};

/** Every companion the diffusion_models graphs load: the T5, plus the VAE. */
export const LTXV_DM_REQUIREMENTS: readonly ModelRequirement[] = [
  LTXV_TEXT_ENCODER_REQUIREMENT,
  LTXV_VAE_REQUIREMENT,
];

/** The checkpoints manifest's inputs with the model binding on `unet_name`. */
export function repointToUnet(inputs: readonly ManifestInput[]): ManifestInput[] {
  return inputs.map((input) =>
    input.source === 'checkpointFilename' ? { ...input, path: '4.inputs.unet_name' } : input,
  );
}

export const txt2vidLtxvDmManifest: WorkflowManifest = {
  id: 'txt2vid-ltxv-dm',
  version: 1,
  label: 'Text to video (LTX-Video, diffusion_models)',
  capability: 'txt2vid',
  baseModels: LTXV_BASE_MODELS,
  requires: LTXV_DM_REQUIREMENTS,
  requiredNodeClasses: [
    'UNETLoader',
    'VAELoader',
    'CLIPLoader',
    'CLIPTextEncode',
    'EmptyLTXVLatentVideo',
    'LTXVConditioning',
    'KSamplerSelect',
    'LTXVScheduler',
    'SamplerCustom',
    'VAEDecode',
    'SaveWEBM',
  ],
  outputNodeId: '9',
  inputs: repointToUnet(TXT2VID_LTXV_INPUTS),
  resolutions: LTXV_RESOLUTIONS,
  quality: LTXV_QUALITY_PRESETS,
  frameQuantum: LTXV_FRAME_QUANTUM,
};

export const txt2vidLtxvDmTemplate: WorkflowTemplate = {
  manifest: txt2vidLtxvDmManifest,
  graph: txt2vidLtxvDmGraph,
};
