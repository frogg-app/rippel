import { expect, it } from 'vitest';
import { FOLDER_READ_BY, folderForType, checkpointSlotOf } from './folders.js';
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
