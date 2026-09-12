/**
 * Making a graph cheaper to run, for a machine that has been told to try.
 *
 * ## Why this is a transform and not a manifest binding
 *
 * Every one of these settings is a property of the *machine*, not of the job or
 * of the family. "Keep the text encoder in system RAM" is the same instruction
 * whether the graph is LTX-Video or Wan, and it is answered by the deployment's
 * memory profile rather than by anything the user typed. Binding it through the
 * manifests would mean adding the same two entries to every video template and
 * keeping them in step forever, and would put a machine's configuration into a
 * per-family file where nobody would look for it.
 *
 * So it is one pass over the compiled graph, applied at dispatch once the
 * backend is known, keyed on node class. A template that does not use these
 * loaders is simply untouched.
 *
 * ## What it changes, and why those two
 *
 * Both input names and both value sets were read from `/object_info` on the
 * reference backend (ComfyUI 0.35.0), not from memory:
 *
 *   UNETLoader.weight_dtype  ['default', 'fp8_e4m3fn', 'fp8_e4m3fn_fast', 'fp8_e5m2']
 *   CLIPLoader.device        ['default', 'cpu']
 *
 * **`CLIPLoader.device = 'cpu'`** is the big one and it is nearly free. A text
 * encoder runs once per prompt, produces a small tensor, and is then dead
 * weight for the whole sample. Running it on the CPU costs a few seconds and
 * removes 5-10 GB from the peak — on the reference box, a 16 GB card beside
 * 64 GB of system RAM, that is the difference between a model fitting and not.
 *
 * **`UNETLoader.weight_dtype = 'fp8_e4m3fn'`** halves the transformer by
 * quantising it as it loads. This one is a real trade: the output changes
 * slightly. It is applied only at `minimal-vram`, where the alternative is not
 * running at all, and deliberately *not* at `low-vram` — `--lowvram` already
 * streams the weights layer by layer, which solves the same problem without
 * touching the numbers.
 *
 * ## What it does not do
 *
 * It never touches a `CheckpointLoaderSimple`. A checkpoint yields the model,
 * the CLIP and the VAE from one file, and there is no per-part dial on it; the
 * profile's launch flags are the whole lever for those graphs. That is a real
 * gap and the honest place for it is here, in a comment, rather than in a
 * setting that appears to apply and does nothing.
 */

import type { MemoryProfile } from '@comfy/shared';
import type { ComfyApiGraph } from './types.js';

export interface OffloadSettings {
  profile: MemoryProfile;
  /**
   * Kept for symmetry with the deployment record, and deliberately unused here:
   * `--cpu-vae` is a launch flag, not a graph input. Accepting it and ignoring
   * it is clearer than making callers remember which half goes where.
   */
  cpuVae?: boolean;
}

/** Which profiles want the text encoder off the card. */
const ENCODER_ON_CPU: readonly MemoryProfile[] = ['low-vram', 'minimal-vram'];

/** Which profiles want the transformer quantised on load. See the header. */
const QUANTISE_UNET: readonly MemoryProfile[] = ['minimal-vram'];

/**
 * Rewrite a compiled graph for one machine's memory profile.
 *
 * Returns the graph unchanged — the same object — when nothing applies, so the
 * common path costs nothing and a caller can pass any graph through
 * unconditionally.
 */
export function withOffload(graph: ComfyApiGraph, settings: OffloadSettings): ComfyApiGraph {
  const encoderToCpu = ENCODER_ON_CPU.includes(settings.profile);
  const quantise = QUANTISE_UNET.includes(settings.profile);
  if (!encoderToCpu && !quantise) return graph;

  let changed = false;
  const next: Record<string, ComfyApiGraph[string]> = {};

  for (const [nodeId, node] of Object.entries(graph)) {
    const isEncoder = encoderToCpu && CLIP_LOADERS.includes(node.class_type);
    const isUnet = quantise && node.class_type === 'UNETLoader';

    // Only rewrite an input the node actually declares. A graph authored
    // against an older ComfyUI may have no `device` on its CLIPLoader, and
    // inventing one would make the prompt fail validation outright — which
    // would turn a memory *optimisation* into a job that cannot run at all.
    const setsDevice = isEncoder && 'device' in node.inputs;
    const setsDtype = isUnet && 'weight_dtype' in node.inputs;

    if (!setsDevice && !setsDtype) {
      next[nodeId] = node;
      continue;
    }

    changed = true;
    next[nodeId] = {
      ...node,
      inputs: {
        ...node.inputs,
        ...(setsDevice ? { device: 'cpu' } : {}),
        ...(setsDtype ? { weight_dtype: 'fp8_e4m3fn' } : {}),
      },
    };
  }

  return changed ? next : graph;
}

/** Every loader that reads `text_encoders/` and takes a `device`. */
const CLIP_LOADERS = ['CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader'];
