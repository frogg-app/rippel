/**
 * Which template a job for a given model actually gets.
 *
 * Three places used to ask the registry directly — `POST /jobs`, the
 * dispatcher, and the readiness route — and each asked the same one-line
 * question, `findTemplate(capability, family)`. Two things have made that
 * question insufficient:
 *
 *  1. The registry can now hold two specific templates for one family that
 *     differ only by the folder they load the model from (the LTX-Video pair).
 *     Which one is right depends on where the file *is*, which `/object_info`
 *     can tell us for an installed model.
 *  2. An operator can pin a template per model and capability (the
 *     `model_workflows` table). That choice outranks every rule below it.
 *
 * So the question is now asked here, once, in this order:
 *
 *   switched off  →  override  →  folder-aware registry lookup  →  plain registry lookup
 *
 * "Switched off" (migration 017) comes first and wins outright: an operator who
 * turns img2vid off for a model means no graph at all, pinned or not, and the
 * answer is the same `undefined` a family with no template gets. That reuses
 * every caller's existing refusal rather than teaching three of them a new one;
 * the cost is that POST /jobs words the refusal as "no workflow", which is true
 * from where the user stands and says nothing about why.
 *
 * Every caller is deliberately tolerant of a missing database: the override
 * lookup is an ordinary query, and a failure to read it degrades to the
 * automatic answer rather than refusing the job.
 */

import type { JobKind } from '@comfy/shared';
import { queryOne } from '../db.js';
import type { ObjectInfo } from '../lib/comfy.js';
import { folderOfInstalled } from '../workflows/folders.js';
import { findTemplate, findTemplateById } from '../workflows/registry.js';
import type { WorkflowTemplate } from '../workflows/types.js';

export interface OverrideLookup {
  (modelId: string, capability: JobKind): Promise<string | null>;
}

/** The pinned template id for (model, capability), or null when automatic. */
export const overrideFor: OverrideLookup = async (modelId, capability) => {
  const row = await queryOne<{ template_id: string }>(
    'SELECT template_id FROM model_workflows WHERE model_id = $1 AND capability = $2',
    [modelId, capability],
  );
  return row?.template_id ?? null;
};

export interface SwitchLookup {
  (modelId: string, capability: JobKind): Promise<boolean>;
}

/** Whether an operator has switched this capability off for this model. */
export const switchedOff: SwitchLookup = async (modelId, capability) => {
  const row = await queryOne<{ model_id: string }>(
    'SELECT model_id FROM model_capability_switches WHERE model_id = $1 AND capability = $2',
    [modelId, capability],
  );
  return row !== null;
};

export interface ChooseTemplateInput {
  modelId: string | null;
  capability: JobKind;
  /** `models.base_model`, our canonical family spelling, or null. */
  family: string | null;
  /** The filename as ComfyUI reports it; used to find its folder. */
  filename?: string | null;
  /** `/object_info` of the backend the job will run on, when known. */
  info?: ObjectInfo | null;
  /** Injectable for tests; defaults to the database. */
  lookupOverride?: OverrideLookup;
  /**
   * Injectable for tests. Defaults to the database — except when
   * `lookupOverride` is injected, where it defaults to "on", so a test that
   * fakes the pin lookup is not made to reach for a real Postgres by the back
   * door.
   */
  lookupSwitchedOff?: SwitchLookup;
}

export interface TemplateChoice {
  template: WorkflowTemplate;
  /** 'pinned' when a `model_workflows` row decided; 'automatic' otherwise. */
  source: 'pinned' | 'automatic';
  /** The folder the file was found in, when `/object_info` said. */
  folder: string | null;
}

/**
 * The template to run, or undefined when nothing serves this capability for
 * this family. A pinned template must still be for the requested capability;
 * one that is not (or that the registry no longer knows) is ignored, not
 * honoured blindly.
 */
export async function chooseTemplate(input: ChooseTemplateInput): Promise<TemplateChoice | undefined> {
  const folder = input.filename ? folderOfInstalled(input.info ?? null, input.filename) : null;

  if (input.modelId) {
    const isOff =
      input.lookupSwitchedOff ?? (input.lookupOverride ? async () => false : switchedOff);
    let off = false;
    try {
      off = await isOff(input.modelId, input.capability);
    } catch {
      // Same tolerance as the pin: an unreadable switch is not a refusal. A
      // missing table (017 not yet applied) lands here too.
      off = false;
    }
    if (off) return undefined;

    const lookup = input.lookupOverride ?? overrideFor;
    let pinnedId: string | null = null;
    try {
      pinnedId = await lookup(input.modelId, input.capability);
    } catch {
      pinnedId = null;
    }
    if (pinnedId) {
      const pinned = findTemplateById(pinnedId);
      if (pinned && pinned.manifest.capability === input.capability) {
        return { template: pinned, source: 'pinned', folder };
      }
    }
  }

  const automatic = findTemplate(input.capability, input.family, folder);
  return automatic ? { template: automatic, source: 'automatic', folder } : undefined;
}
