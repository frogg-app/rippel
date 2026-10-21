import { describe, expect, it } from 'vitest';
import { FOLDER_READ_BY, folderForType, checkpointSlotOf, canonicalFolder, canonicalModelDir, folderOfInstalled, foldersOfInstalled } from './folders.js';
import { requirementSite } from './requirements.js';
import { TEMPLATES } from './registry.js';

it('knows every model loader in every template and companion binding', () => {
  for (const template of TEMPLATES) {
    const slot = checkpointSlotOf(template);
    if (slot) expect(FOLDER_READ_BY[slot.nodeClass], slot.nodeClass).toBeTruthy();
    for (const requirement of template.manifest.requires ?? []) {
      const site = requirementSite(template.graph, requirement)!;
      expect(FOLDER_READ_BY[site.nodeClass], site.nodeClass).toBeTruthy();
    }
    for (const node of Object.values(template.graph)) {
      if (node.class_type.endsWith('Loader') || node.class_type.endsWith('LoaderSimple')) {
        expect(FOLDER_READ_BY[node.class_type], node.class_type).toBeTruthy();
      }
    }
  }
});

it('shares installer defaults and handles the GGUF loader family', () => {
  expect(folderForType('clip')).toBe(FOLDER_READ_BY.DualCLIPLoader);
  expect(folderForType('checkpoint')).toBe(FOLDER_READ_BY.ImageOnlyCheckpointLoader);
  expect(FOLDER_READ_BY.UnetLoaderGGUF).toBe('diffusion_models');
  expect(FOLDER_READ_BY.DualCLIPLoaderGGUF).toBe('text_encoders');
  expect(folderForType('unknown')).toBeNull();
});

describe('canonicalFolder', () => {
  it('is the one answer the verdict, the install and the agent all use', async () => {
    const { folderForSavePath } = await import('../models/runnability.js');
    const { folderForRow } = await import('../models/installs.js');
    const { agentModelPath } = await import('../models/transports/agent.js');
    const cases: [string, 'checkpoint' | 'clip' | 'vae' | 'lora', string][] = [
      ['unet', 'checkpoint', 'diffusion_models'],
      ['unet/flux', 'checkpoint', 'diffusion_models'],
      ['clip', 'clip', 'text_encoders'],
      ['CLIP', 'clip', 'text_encoders'],
      ['', 'vae', 'vae'],
      ['default', 'lora', 'loras'],
      ['checkpoints/SDXL', 'checkpoint', 'checkpoints'],
      ['text_encoders\\t5', 'clip', 'text_encoders'],
    ];
    for (const [savePath, type, folder] of cases) {
      expect(canonicalFolder(savePath, type)).toBe(folder);
      expect(folderForSavePath(savePath, type)).toBe(folder);
      expect(folderForRow({ save_path: savePath, model_type: type } as never)).toBe(folder);
      expect(agentModelPath({ savePath, type, filename: 'x.safetensors' })?.split('/')[0]).toBe(folder);
    }
  });

  it('keeps subfolders, mapping only the legacy first segment', () => {
    expect(canonicalModelDir('unet/flux', 'checkpoint')).toBe('diffusion_models/flux');
    expect(canonicalModelDir('loras/ltxv/ltx2', 'lora')).toBe('loras/ltxv/ltx2');
  });
});

describe('foldersOfInstalled', () => {
  it('names every folder that lists the file, not just the first', () => {
    const info = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['ltx.safetensors']] } } },
      UNETLoader: { input: { required: { unet_name: [['ltx.safetensors', 'other.safetensors']] } } },
    } as never;
    expect(foldersOfInstalled(info, 'ltx.safetensors')).toEqual(['checkpoints', 'diffusion_models']);
    expect(folderOfInstalled(info, 'other.safetensors')).toBe('diffusion_models');
    expect(foldersOfInstalled(null, 'ltx.safetensors')).toEqual([]);
  });
});
