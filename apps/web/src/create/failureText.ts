/**
 * ComfyUI's validation errors, in words a person who never opened ComfyUI reads.
 *
 * The commonest failure after out-of-memory is a loader asked for a file the
 * backend does not have. ComfyUI says so as
 * `value_not_in_list: unet_name: 'wan2.1_t2v.safetensors' not in []` — accurate,
 * and opaque to everybody who does not already know that `unet_name` is a
 * loader input and `[]` is the folder it listed. The server classifies most
 * failures already; this covers the jobs it did not (older rows, or a
 * `bad-value` that is really a missing file). The raw text is never dropped —
 * callers keep it in the "details" disclosure.
 */
import type { JobFailure } from '@comfy/shared';

/** Loader inputs that name a model file, with the friendly word for each. */
const FILE_INPUTS: Record<string, string> = {
  ckpt_name: 'model',
  unet_name: 'model',
  lora_name: 'style add-on',
  vae_name: 'image decoder',
  clip_name: 'prompt reader',
  clip_name1: 'prompt reader',
  clip_name2: 'prompt reader',
  control_net_name: 'pose & outline guide',
  model_name: 'enlarger',
};

/**
 * The plain sentence for a raw ComfyUI error, or null when it is not one we
 * recognise (the caller then shows what it already had).
 */
export function translateComfyError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // `unet_name: 'foo.safetensors' not in [...]` — the quoted value is the file.
  const match = /\b([a-z_0-9]+):\s*'([^']+)'\s+not in\s+\[/i.exec(raw);
  if (match) {
    const [, input, file] = match;
    const noun = FILE_INPUTS[input!.toLowerCase()] ?? 'model';
    return `The ${noun} file isn't on this machine (${file}). Install it from Models, or pick another.`;
  }
  if (/value_not_in_list/i.test(raw)) {
    return "A model file this job needs isn't on this machine. Install it from Models, or pick another.";
  }
  return null;
}

/**
 * The whole explanation for a raw failure the server did not classify (an
 * older job, or one it filed as `unknown` / `bad-value`): a title-worthy kind,
 * one plain sentence, what to do, and where in rippel to do it. Mirrors the
 * server's `orchestrator/failure.ts` rules for the loader errors people hit
 * most, so an old job reads the same as a new one. Null when not recognised.
 */
export function friendlyFailure(raw: string | null | undefined): JobFailure | null {
  if (!raw) return null;
  const text = raw.toLowerCase();
  if (/device kernel image is invalid|hiperrorinvalidimage|no kernel image is available|invalid device function|hiperrornobinaryforgpu|no binary for gpu/.test(text)) {
    return { kind: 'gpu-setup', summary: 'This PC’s graphics card isn’t set up correctly.', steps: [], detail: raw, link: null };
  }
  if (/could not detect model type|unsupported checkpoint|error while deserializing header/.test(text)) {
    return {
      kind: 'unreadable-model',
      summary: 'The machine has this model file, but ComfyUI can’t recognise what kind of model is inside it.',
      steps: [
        'It is usually a file in a format ComfyUI does not load (for example diffusers-format weights), or diffusion weights alone in the "checkpoints" folder.',
        'Open the model on the Models page to see what it needs, or pick a model marked “Will run”.',
      ],
      detail: raw,
      link: { label: 'Open installed models', href: '/models?tab=installed' },
    };
  }
  if (/out of memory|outofmemory|allocation on device|failed to allocate memory/.test(text)) {
    return {
      kind: 'out-of-memory',
      summary: 'The machine ran out of graphics memory part-way through this job.',
      steps: ['Make the clip shorter, or drop the resolution one step.'],
      detail: raw,
      link: null,
    };
  }
  const missing = translateComfyError(raw);
  if (missing || /no such file or directory|filenotfounderror/.test(text)) {
    return {
      kind: 'missing-model',
      summary: missing ?? 'A file this job needs isn’t on that machine.',
      steps: missing ? [] : ['Install it from the Models page, or pick a model that is already on that machine.'],
      detail: raw,
      link: { label: 'Open Models', href: '/models?tab=installed' },
    };
  }
  return null;
}
