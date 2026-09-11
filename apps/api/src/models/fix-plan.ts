/** A Fix plan is computed against current loader visibility, never inferred
 * from prose on a card. Moves precede missing companions in one operation. */
import type { ObjectInfo } from '../lib/comfy.js';
import { loaderFolderOf, folderOfInstalled, FOLDER_READ_BY } from '../workflows/folders.js';
import { resolveRequirements, rankCandidates } from '../workflows/requirements.js';
import type { WorkflowTemplate } from '../workflows/types.js';
import type { WorkflowFile } from '../library/workflows/manifest.js';
import { verifiedFile } from './download-metadata.js';
import { COMPANION_SOURCES } from './companion-sources.js';
import type { ModelOperationStep } from './operations.js';
export async function buildFixPlan(input: { template: WorkflowTemplate; filename: string; info: ObjectInfo;
  sources?: WorkflowFile[]; verify?: typeof verifiedFile }): Promise<{ steps: ModelOperationStep[]; unavailable: string[] }> {
  const steps: ModelOperationStep[] = [];
  const unavailable: string[] = [];
  const folder = folderOfInstalled(input.info, input.filename);
  const wanted = loaderFolderOf(input.template);
  if (folder && wanted && folder !== wanted) steps.push({ kind: 'move', request: { from: `${folder}/${input.filename}`, to: `${wanted}/${input.filename}` } });
  const sources = [...(input.sources ?? []), ...COMPANION_SOURCES];
  const destinations = new Set<string>();
  for (const missing of resolveRequirements(input.template, input.info).filter((item) => !item.filename)) {
    const directory = FOLDER_READ_BY[missing.site.nodeClass];
    const matching = sources.filter((file) => file.directory === directory);
    const ranked = rankCandidates(missing.requirement, matching.map((file) => file.name));
    const file = matching.find((file) => file.name === ranked[0]);
    if (!file) { unavailable.push(`No verified download source for ${missing.requirement.label}.`); continue; }
    const path = `${directory}/${file.name}`;
    if (destinations.has(path)) continue;
    destinations.add(path);
    try {
      const verified = await (input.verify ?? verifiedFile)(file);
      steps.push({ kind: 'download', request: { url: verified.url, path, sha256: verified.sha256, sizeBytes: verified.sizeBytes } });
    } catch (error) { unavailable.push((error as Error).message); }
  }
  return { steps, unavailable };
}
