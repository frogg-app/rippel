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
 *
 * There is one wrinkle on top of that: some templates are *fallbacks* (see
 * sd-generic.ts). They answer the same question, but only when nothing better
 * does, so the index is built in two layers — specific first, generic behind it
 * — rather than as one map that would have to declare a winner at import time.
 */

import type { JobKind } from '@comfy/shared';
import type { WorkflowManifest, WorkflowTemplate } from './types.js';
import { loaderFolderOf } from './folders.js';
import { img2imgSdxlTemplate } from './img2img-sdxl.js';
import { img2vidLtxvTemplate } from './img2vid-ltxv.js';
import { img2vidLtxvDmTemplate } from './img2vid-ltxv-dm.js';
import { img2vidSvdTemplate } from './img2vid-svd.js';
import { img2vidWan22Ti2v5bTemplate } from './img2vid-wan22-ti2v-5b.js';
import { txt2imgSdxlTemplate } from './txt2img-sdxl.js';
import { txt2vidHunyuanTemplate } from './txt2vid-hunyuan.js';
import { txt2vidLtxvTemplate } from './txt2vid-ltxv.js';
import { txt2vidLtxvDmTemplate } from './txt2vid-ltxv-dm.js';
import { NON_SD_NODE_SET_FAMILIES, SD_GENERIC_TEMPLATES } from './sd-generic.js';

/**
 * Every template we ship. Add new families here and nowhere else.
 *
 * Order matters in one place: when two specific templates serve the same
 * (capability, family) from different folders, the one registered first is
 * what a lookup with no folder knowledge gets. The `checkpoints/` LTX graphs
 * come first because that is where ComfyUI-Manager's catalogue installs the
 * file and where the family's own reference workflow expects it.
 */
export const TEMPLATES: readonly WorkflowTemplate[] = [
  txt2imgSdxlTemplate,
  img2imgSdxlTemplate,
  txt2vidLtxvTemplate,
  img2vidLtxvTemplate,
  txt2vidLtxvDmTemplate,
  img2vidLtxvDmTemplate,
  img2vidSvdTemplate,
  img2vidWan22Ti2v5bTemplate,
  txt2vidHunyuanTemplate,
  ...SD_GENERIC_TEMPLATES,
];

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
 * Indexes keyed by `<capability>::<normalizedBaseModel>`. Built once at import
 * time; a duplicate registration is a programming error and throws immediately
 * rather than letting whichever template loaded last quietly win.
 *
 * Two maps, not one. A specific template and a fallback may both name the same
 * family — that is not a conflict, it is the whole point of a fallback — but two
 * *specific* templates naming it still is, and so is two fallbacks. Keeping them
 * apart means the collision check stays as strict as it was inside each layer
 * while `findTemplate` gets to pick between the layers at lookup time.
 */
export interface TemplateIndex {
  /**
   * More than one entry per key is allowed, and means one thing only: the
   * same family served from *different model folders* (see folders.ts). Two
   * specific templates reading the same folder are still a conflict.
   */
  readonly specific: ReadonlyMap<string, readonly WorkflowTemplate[]>;
  readonly fallback: ReadonlyMap<string, WorkflowTemplate>;
  /** Fallbacks for a model whose family we could not infer, by capability. */
  readonly unknownFamily: ReadonlyMap<JobKind, WorkflowTemplate>;
  readonly byId: ReadonlyMap<string, WorkflowTemplate>;
}

function key(capability: JobKind, baseModel: string): string {
  return `${capability}::${normalizeBaseModel(baseModel)}`;
}

const excludedFromFallback = new Set(NON_SD_NODE_SET_FAMILIES.map(normalizeBaseModel));

/**
 * Build the lookup indexes for a set of templates, validating them as it goes.
 *
 * Exported, and taking its templates as an argument, so the resolution rules
 * below can be tested against a synthetic registry. That is not ceremony: the
 * rule that matters most — a hand-authored template shadows a generic one for
 * the same family — has no example in the templates we currently ship, and a
 * rule with no test is a rule that stops being true the first time somebody
 * reorders this loop.
 */
export function buildTemplateIndex(templates: readonly WorkflowTemplate[]): TemplateIndex {
  const specific = new Map<string, WorkflowTemplate[]>();
  const fallback = new Map<string, WorkflowTemplate>();
  const unknownFamily = new Map<JobKind, WorkflowTemplate>();
  const byId = new Map<string, WorkflowTemplate>();

  for (const template of templates) {
    const { id, capability, baseModels, isFallback, appliesToUnknownFamily } = template.manifest;
    if (byId.has(id)) {
      throw new Error(`Duplicate workflow template id: ${id}`);
    }
    byId.set(id, template);

    // "The guess we make when we know nothing" only makes sense for a template
    // that admits it is a guess, and there can only be one per capability or the
    // answer depends on registration order.
    if (appliesToUnknownFamily) {
      if (!isFallback) {
        throw new Error(`Template ${id} claims the unknown-family slot without isFallback`);
      }
      const existing = unknownFamily.get(capability);
      if (existing) {
        throw new Error(
          `Two templates claim the unknown-family ${capability} fallback: ` +
            `${existing.manifest.id} and ${id}`,
        );
      }
      unknownFamily.set(capability, template);
    }

    // Two maps, not one. A specific template and a fallback may both name the
    // same family — that is not a conflict, it is the point of a fallback — but
    // two *specific* templates naming it still is, and so is two fallbacks.
    // Keeping them apart leaves the collision check as strict as it was inside
    // each layer while `findTemplate` picks between the layers at lookup time.
    for (const baseModel of baseModels) {
      // The exclusion list in sd-generic.ts, enforced. A fallback that claimed a
      // video or FLUX family would dispatch a graph those models cannot run and
      // fail only after the GPU had been busy for a minute; failing here costs
      // an import instead.
      if (isFallback && excludedFromFallback.has(normalizeBaseModel(baseModel))) {
        throw new Error(
          `Fallback template ${id} claims "${baseModel}", which is on the ` +
            `non-SD-node-set exclusion list and needs a graph of its own`,
        );
      }
      const k = key(capability, baseModel);
      if (isFallback) {
        const existing = fallback.get(k);
        if (existing) {
          throw new Error(
            `Two templates claim ${capability} for base model "${baseModel}": ` +
              `${existing.manifest.id} and ${id}`,
          );
        }
        fallback.set(k, template);
        continue;
      }
      // Two specific graphs may share a family only when they load the model
      // from different folders: that is a real difference in what will run,
      // and the lookup picks between them by where the file actually is.
      const held = specific.get(k) ?? [];
      const folder = loaderFolderOf(template);
      const clash = held.find((other) => loaderFolderOf(other) === folder);
      if (clash) {
        throw new Error(
          `Two templates claim ${capability} for base model "${baseModel}" from the same ` +
            `folder (${folder ?? 'unknown'}): ${clash.manifest.id} and ${id}`,
        );
      }
      specific.set(k, [...held, template]);
    }
  }

  return { specific, fallback, unknownFamily, byId };
}

/**
 * Resolve one lookup against an index. See `findTemplate` for the order and
 * why it is that order.
 */
export function resolveTemplate(
  index: TemplateIndex,
  capability: JobKind,
  baseModel: string | null,
  /**
   * The ComfyUI folder the model file is in, when known. Picks between
   * specific templates that differ only by loader; ignored otherwise. Unknown
   * (null) gets the first-registered specific template.
   */
  folder: string | null = null,
): WorkflowTemplate | undefined {
  if (!baseModel) return index.unknownFamily.get(capability);
  const k = key(capability, baseModel);
  const specifics = index.specific.get(k);
  if (specifics && specifics.length > 0) {
    if (folder) {
      const match = specifics.find((template) => loaderFolderOf(template) === folder);
      if (match) return match;
    }
    return specifics[0];
  }
  return index.fallback.get(k);
}

/**
 * Every template that could serve a capability for a family — each specific
 * one (one per loader folder) and then the fallback — in the order a lookup
 * would prefer them. What the runnability check measures against, so a file
 * in `diffusion_models/` is judged by the graph that reads that folder rather
 * than only by the one that does not.
 */
export function candidateTemplates(
  index: TemplateIndex,
  capability: JobKind,
  baseModel: string | null,
): WorkflowTemplate[] {
  if (!baseModel) {
    const unknown = index.unknownFamily.get(capability);
    return unknown ? [unknown] : [];
  }
  const k = key(capability, baseModel);
  const out = [...(index.specific.get(k) ?? [])];
  const generic = index.fallback.get(k);
  if (generic) out.push(generic);
  return out;
}

/** The shipped registry. Built once at import; a bad manifest fails the build. */
const INDEX = buildTemplateIndex(TEMPLATES);

/**
 * Look up the template for a capability + base model. Returns `undefined`
 * rather than throwing: "we have no template for FLUX video yet" is an ordinary
 * 400 the route turns into a readable message, not an exception.
 *
 * Resolution order, and it matters:
 *
 *   1. A specific, hand-authored template for that family. **Always wins.**
 *      Adding a real SD 1.5 template later must shadow the generic one without
 *      anybody remembering to withdraw the generic one first.
 *   2. A generic fallback that lists the family (sd-generic.ts).
 *   3. For `baseModel === null` only, the unknown-family fallback.
 *
 * A null `baseModel` used to mean "no answer". It no longer does: `Model.
 * baseModel` is null for any checkpoint whose family we could not infer, and
 * refusing those outright meant a user could install a perfectly ordinary merge
 * and be told it was unusable. An unrecognised checkpoint is far more likely to
 * be an SD-family model than anything else, so we offer the generic graph and
 * flag it as generic — see `isFallback` on the manifest — rather than refusing.
 */
export function findTemplate(
  capability: JobKind,
  baseModel: string | null,
  folder: string | null = null,
): WorkflowTemplate | undefined {
  return resolveTemplate(INDEX, capability, baseModel, folder);
}

/** Every template that could serve this capability for this family. */
export function templatesFor(capability: JobKind, baseModel: string | null): WorkflowTemplate[] {
  return candidateTemplates(INDEX, capability, baseModel);
}

/** Every capability any template implements. */
export function knownCapabilities(): JobKind[] {
  return [...new Set<JobKind>(TEMPLATES.map((t) => t.manifest.capability))];
}

/** Look up by manifest id, for re-running a job against the template it used. */
export function findTemplateById(id: string): WorkflowTemplate | undefined {
  return INDEX.byId.get(id);
}

/**
 * A capability we can offer for a model, and how confident we are about it.
 *
 * The confidence is not decoration. `capabilitiesFor` is what the Create screen
 * uses to decide whether a checkpoint is selectable at all, and with the generic
 * fallback in place the honest answer for most models is "yes, but with a
 * best-guess workflow". Collapsing that to a bare capability list would have the
 * UI present a guess with the same confidence as `txt2img-sdxl`.
 */
export interface CapabilityOffer {
  readonly capability: JobKind;
  readonly templateId: string;
  /** True when the graph is generic rather than authored for this family. */
  readonly isFallback: boolean;
}

/**
 * Which capabilities we can offer for a given base model, with the template
 * that would run and whether it is a guess. Resolved through `findTemplate`, so
 * this cannot drift from what a dispatch would actually pick.
 */
export function capabilityOffersFor(
  baseModel: string | null,
  folder: string | null = null,
): CapabilityOffer[] {
  const kinds = new Set<JobKind>(TEMPLATES.map((t) => t.manifest.capability));
  const offers: CapabilityOffer[] = [];
  for (const capability of kinds) {
    const template = findTemplate(capability, baseModel, folder);
    if (!template) continue;
    offers.push({
      capability,
      templateId: template.manifest.id,
      isFallback: template.manifest.isFallback === true,
    });
  }
  return offers;
}

/**
 * Which capabilities we can offer for a given base model. The Create screen
 * uses this to decide whether the Video toggle and the reference-image roles
 * are available at all for the currently selected checkpoint.
 *
 * This now answers for a model with *no* family too, because the generic
 * fallback covers that case — see `findTemplate`. Callers that want to tell the
 * user they are on a best guess want `capabilityOffersFor` instead.
 */
export function capabilitiesFor(baseModel: string | null): JobKind[] {
  return capabilityOffersFor(baseModel).map((o) => o.capability);
}

/** Every manifest, for the API endpoint that tells the UI what knobs exist. */
export function allManifests(): WorkflowManifest[] {
  return TEMPLATES.map((t) => t.manifest);
}
