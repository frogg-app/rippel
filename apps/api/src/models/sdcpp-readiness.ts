/**
 * The readiness answer for a stable-diffusion.cpp backend.
 *
 * `readiness.ts` reads a ComfyUI template's requirements against
 * `/object_info`. sd-server has neither: it has recipes with slots, and a file
 * list. The planner (`orchestrator/sdcpp-plan.ts`) already turns those into
 * "filled" and "gaps" for the dispatcher, so the readiness screen is that plan
 * in the shared `BackendReadiness` shape — the same shape the Create page
 * already renders, so no new UI is needed to say what is missing.
 *
 * No catalogue offers yet: the install transport is keyed to ComfyUI folders
 * and this backend may not have ComfyUI at all. Every gap arrives as a manual
 * step naming the folder and the kind of file, which is the honest answer.
 */

import type { BackendReadiness, JobKind, ModelRequirementReport, ModelType } from '@comfy/shared';
import { queryOne } from '../db.js';
import { SdcppClient, discoverSdcppModels } from '../lib/sdcpp.js';
import { planFor, type SdcppPlan } from '../orchestrator/sdcpp-plan.js';

const SLOT_TYPES: Record<string, ModelType> = {
  model: 'checkpoint',
  diffusion_model: 'checkpoint',
  vae: 'vae',
  tae: 'vae',
  clip_l: 'clip',
  clip_g: 'clip',
  t5xxl: 'clip',
  llm: 'clip',
  clip_vision: 'clip',
};

export async function sdcppReadiness(params: {
  backend: { id: string; name: string; base_url: string };
  modelId: string;
  capability: JobKind;
}): Promise<BackendReadiness | null> {
  const model = await queryOne<{ id: string; display_name: string; base_model: string | null; filename: string }>(
    'SELECT id, display_name, base_model, filename FROM models WHERE id = $1',
    [params.modelId],
  );
  if (!model) return null;

  const client = new SdcppClient(params.backend.base_url);
  const [files, recipes] = await Promise.all([client.modelFiles(), client.recipes()]);
  const planned = planFor({
    family: model.base_model,
    checkpointFilename: model.filename,
    modelLabel: model.display_name,
    capability: params.capability,
    files,
    recipes,
  });
  const plan: SdcppPlan | null = planned.plan;
  const discovered = discoverSdcppModels(files);
  const byId = new Map(discovered.map((file) => [file.fileId, file]));

  const requirements: ModelRequirementReport[] = [];
  if (plan) {
    const recipe = recipes.find((r) => r.id === plan.recipe);
    for (const slot of recipe?.slots ?? []) {
      const filled = plan.models[slot.id];
      const gap = plan.gaps.find((g) => g.slot === slot.id);
      if (!filled && !gap) continue; // an optional slot nobody needs
      const category = slot.category.toLowerCase();
      requirements.push({
        id: slot.id,
        label: slot.label ?? slot.id,
        why: slot.id === 'model' || slot.id === 'diffusion_model' ? 'The model you chose.' : `${recipe?.name ?? plan.recipe} loads this beside the model.`,
        type: SLOT_TYPES[slot.id] ?? 'checkpoint',
        loaderClass: 'sd-server',
        loaderInput: slot.id,
        status: filled ? 'satisfied' : 'missing',
        resolved: filled ? byId.get(filled)?.filename ?? filled : null,
        available: discovered.filter((file) => file.category === category).map((file) => file.filename),
        misfiled: null,
        offers: [],
      });
    }
  }

  return {
    backendId: params.backend.id,
    backendName: params.backend.name,
    templateId: plan ? `sdcpp:${plan.recipe}` : 'sdcpp:none',
    templateLabel: plan ? `${plan.recipeName} (stable-diffusion.cpp)` : 'stable-diffusion.cpp',
    capability: params.capability,
    isFallback: false,
    videoLimits: null,
    modelId: model.id,
    modelLabel: model.display_name,
    ready: planned.ok,
    requirements,
    missingNodeClasses: [],
    installable: [],
    manualSteps: planned.ok ? [] : plan ? plan.gaps.map((gap) => gap.hint) : [planned.reason],
    catalogueError: null,
    takesLoras: true,
    modelProblem: null,
  };
}
