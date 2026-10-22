/**
 * Style add-ons a job may not carry, refused before the job exists.
 *
 * The compiler already throws on LoRAs for a template without a `lora` chain,
 * but its words are for us ("Template \"img2vid-ltxv\" does not support
 * LoRAs"), and it says nothing at all about an SD 1.5 add-on on an SDXL model,
 * which compiles fine and produces noise. Both were reaching users: the Create
 * screen let "Pytorch LoRA Weights" (family unknown) onto an LTX-Video job.
 *
 * Pure, so the rule is tested without a database.
 */
import type { WorkflowManifest } from '../workflows/types.js';
import { inferFamily } from '../models/family.js';
import { familyName } from '../models/runnability.js';

export interface LoraCheckModel {
  display_name: string;
  filename: string;
  base_model: string | null;
}

/**
 * Families that share an architecture, so an add-on for one loads on another.
 * Pony and Illustrious are SDXL fine-tunes; refusing a Pony style on an SDXL
 * merge would be refusing something that runs.
 */
const ARCHITECTURE: Record<string, string> = { pony: 'sdxl', illustrious: 'sdxl', 'sdxl-turbo': 'sdxl' };
const arch = (family: string) => ARCHITECTURE[family] ?? family;

/** A sentence for the person, or null when the add-ons may go ahead. */
export function loraProblem(params: {
  manifest: Pick<WorkflowManifest, 'lora'>;
  checkpoint: LoraCheckModel;
  loras: readonly LoraCheckModel[];
}): string | null {
  const { checkpoint, loras } = params;
  if (loras.length === 0) return null;
  const family = inferFamily({ filename: checkpoint.filename, catalogueBase: checkpoint.base_model });
  const familyWords = family ? familyName(family) : checkpoint.display_name;
  const names = loras.map((lora) => lora.display_name).join(', ');

  if (!params.manifest.lora) {
    return `${familyWords} workflows don’t take style add-ons. Remove ${names} and try again.`;
  }

  // Only a *known* mismatch is refused. An add-on with no recorded family is
  // the common case for a locally found file, and the form warns about it.
  if (family) {
    const wrong = loras.filter((lora) => {
      const theirs = inferFamily({ filename: lora.filename, catalogueBase: lora.base_model });
      return theirs !== null && arch(theirs) !== arch(family);
    });
    if (wrong.length > 0) {
      const which = wrong
        .map((lora) => {
          const theirs = inferFamily({ filename: lora.filename, catalogueBase: lora.base_model });
          return `${lora.display_name} (made for ${theirs ? familyName(theirs) : 'another model'})`;
        })
        .join(', ');
      return `${which} ${wrong.length === 1 ? 'doesn’t' : 'don’t'} fit ${familyWords} models. Remove ${wrong.length === 1 ? 'it' : 'them'} and try again.`;
    }
  }
  return null;
}
