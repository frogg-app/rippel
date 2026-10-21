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
