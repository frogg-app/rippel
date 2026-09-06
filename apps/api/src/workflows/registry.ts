/**
 * The template registry.
 *
 * The compiler and the orchestrator ask exactly one question of this module:
 * "given that the user wants to do X with a model of family Y, which graph do I
 * fill in?" Everything is looked up by the pair `(capability, baseModel)`,
 * because a capability alone is not enough — txt2img on SDXL and txt2img on
 * FLUX are entirely different node sets (FLUX has no negative conditioning and
 * uses a guidance node instead of cfg), and they must never be interchangeable.
 *
 * Registration is a plain module-level array rather than filesystem scanning:
 * a template that fails to import should break the build, not disappear at
 * runtime and leave a capability mysteriously unavailable.
 */

import type { JobKind } from '@comfy/shared';
import type { WorkflowManifest, WorkflowTemplate } from './types.js';
import { txt2imgSdxlTemplate } from './txt2img-sdxl.js';

/** Every template we ship. Add new families here and nowhere else. */
export const TEMPLATES: readonly WorkflowTemplate[] = [txt2imgSdxlTemplate];

/**
 * Base-model strings arrive from three places that disagree about spelling:
 * Civitai ("SDXL 1.0"), HuggingFace tags, and whatever an operator typed. We
 * fold case and strip everything that is not a letter or digit, so "SDXL 1.0",
 * "sdxl-1.0" and "SDXL_1.0" all collapse to `sdxl10`.
 *
 * Version digits are deliberately *kept*. Stripping them would be tempting — it
 * would make "sdxl 1.0" match a template that only lists "sdxl" — but it also
 * collapses "sd 1.5" and "sd 2.1" onto the same key, and those are incompatible
 * families with different resolutions and text encoders. Covering the spellings
 * that occur in the wild is the manifest's job instead: a template lists every
 * alias it accepts in `baseModels`.
 */
export function normalizeBaseModel(baseModel: string): string {
  return baseModel.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Index keyed by `<capability>::<normalizedBaseModel>`. Built once at import
 * time; a duplicate registration is a programming error and throws immediately
 * rather than letting whichever template loaded last quietly win.
 */
const byCapabilityAndModel = new Map<string, WorkflowTemplate>();
const byId = new Map<string, WorkflowTemplate>();

function key(capability: JobKind, baseModel: string): string {
  return `${capability}::${normalizeBaseModel(baseModel)}`;
}

for (const template of TEMPLATES) {
  const { id, capability, baseModels } = template.manifest;
  if (byId.has(id)) {
    throw new Error(`Duplicate workflow template id: ${id}`);
  }
  byId.set(id, template);

  for (const baseModel of baseModels) {
    const k = key(capability, baseModel);
    const existing = byCapabilityAndModel.get(k);
    if (existing) {
      throw new Error(
        `Two templates claim ${capability} for base model "${baseModel}": ` +
          `${existing.manifest.id} and ${id}`,
      );
    }
    byCapabilityAndModel.set(k, template);
  }
}

/**
 * Look up the template for a capability + base model. Returns `undefined`
 * rather than throwing: "we have no template for FLUX video yet" is an ordinary
 * 400 the route turns into a readable message, not an exception.
 *
 * `baseModel` is nullable because `Model.baseModel` is — a locally dropped file
 * whose family we could not infer has none, and there is nothing sensible to
 * guess. The caller should tell the user to set the family on the model.
 */
export function findTemplate(
  capability: JobKind,
  baseModel: string | null,
): WorkflowTemplate | undefined {
  if (!baseModel) return undefined;
  return byCapabilityAndModel.get(key(capability, baseModel));
}

/** Look up by manifest id, for re-running a job against the template it used. */
export function findTemplateById(id: string): WorkflowTemplate | undefined {
  return byId.get(id);
}

/**
 * Which capabilities we can offer for a given base model. The Create screen
 * uses this to decide whether the Video toggle and the reference-image roles
 * are available at all for the currently selected checkpoint.
 */
export function capabilitiesFor(baseModel: string | null): JobKind[] {
  if (!baseModel) return [];
  const normalized = normalizeBaseModel(baseModel);
  const kinds = new Set<JobKind>();
  for (const t of TEMPLATES) {
    if (t.manifest.baseModels.some((b) => normalizeBaseModel(b) === normalized)) {
      kinds.add(t.manifest.capability);
    }
  }
  return [...kinds];
}

/** Every manifest, for the API endpoint that tells the UI what knobs exist. */
export function allManifests(): WorkflowManifest[] {
  return TEMPLATES.map((t) => t.manifest);
}
