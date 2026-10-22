import { describe, expect, it } from 'vitest';
import { workingBuildFor } from './working-builds.js';

describe('workingBuildFor', () => {
  it('offers the single-file LTX-Video build for a diffusers LTX file', () => {
    const entry = workingBuildFor({ filename: 'model_weights_0306.safetensors', base_model: 'ltx-video' });
    expect(entry).toMatchObject({
      filename: 'ltx-video-2b-v0.9.5.safetensors',
      savePath: 'checkpoints',
      ref: 'hugging-face:Lightricks/LTX-Video',
      type: 'checkpoint',
    });
    expect(entry!.url).toMatch(/^https:\/\/huggingface\.co\/Lightricks\/LTX-Video\/resolve\/main\//);
  });

  it('offers nothing for the build itself, or for a family without one', () => {
    expect(workingBuildFor({ filename: 'ltx-video-2b-v0.9.5.safetensors', base_model: 'ltx-video' })).toBeNull();
    expect(workingBuildFor({ filename: 'some_sdxl.safetensors', base_model: 'sdxl' })).toBeNull();
  });
});
