import { describe, expect, it } from 'vitest';
import { friendlyFailure, translateComfyError } from './failureText';

describe('translateComfyError', () => {
  it('names the missing file for a loader that listed nothing', () => {
    expect(
      translateComfyError("Prompt outputs failed validation: UNETLoader: value_not_in_list: unet_name: 'wan2.1_t2v_14B.safetensors' not in []"),
    ).toBe("The model file isn't on this machine (wan2.1_t2v_14B.safetensors). Install it from Models, or pick another.");
  });

  it('uses the friendly word for the loader input', () => {
    expect(translateComfyError("vae_name: 'ae.safetensors' not in ['other.safetensors']")).toMatch(
      /^The image decoder file isn't on this machine \(ae\.safetensors\)/,
    );
    expect(translateComfyError("ckpt_name: 'sdxl.safetensors' not in []")).toMatch(/^The model file/);
  });

  it('falls back to a general sentence for an unparsed value_not_in_list', () => {
    expect(translateComfyError('value_not_in_list')).toMatch(/isn't on this machine/);
  });

  it('leaves anything else alone', () => {
    expect(translateComfyError('KSampler failed: HIP out of memory.')).toBeNull();
    expect(translateComfyError(null)).toBeNull();
  });
});

describe('friendlyFailure', () => {
  it('maps the LTX "Could not detect model type" error to an unreadable-model explanation', () => {
    const raw = 'CheckpointLoaderSimple failed: ERROR: Could not detect model type of: C:\\m\\checkpoints\\model_weights_0306.safetensors';
    const failure = friendlyFailure(raw)!;
    expect(failure.kind).toBe('unreadable-model');
    expect(failure.link?.href).toBe('/models?tab=installed');
    expect(failure.detail).toBe(raw);
  });

  it('maps out-of-memory and missing files, and leaves the rest alone', () => {
    expect(friendlyFailure('torch.OutOfMemoryError: HIP out of memory')!.kind).toBe('out-of-memory');
    expect(friendlyFailure("ckpt_name: 'x.safetensors' not in []")!.kind).toBe('missing-model');
    expect(friendlyFailure('FileNotFoundError: [Errno 2] No such file or directory')!.kind).toBe('missing-model');
    expect(friendlyFailure('something else')).toBeNull();
  });
});
