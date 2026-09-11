/** Usage: npm run smoke:workflows -w @comfy/api -- http://backend:8188
 * Add --imports with DATABASE_URL/AUTH_SECRET to include database imports.
 * --check-only performs no uploads or submissions. Jobs run one at a time. */
import { setTimeout as delay } from 'node:timers/promises';
import { TEMPLATES } from '../workflows/registry.js';
import { fetchSnapshot } from '../library/workflows/snapshot.js';
import { submitSmoke, inspectSmoke } from '../library/workflows/smoke.js';
import { comboOptions } from '../lib/comfy.js';
import { inferFamily } from '../models/family.js';
import { normalizeBaseModel } from '../workflows/registry.js';
import { checkGraph } from '../orchestrator/preflight.js';
import { withResolvedRequirements } from '../workflows/requirements.js';
import { loaderFolderOf, folderOfInstalled } from '../workflows/folders.js';

const baseUrl = process.argv[2]?.replace(/\/$/, '');
if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error('Supply a ComfyUI HTTP URL.');
const info = await fetchSnapshot(baseUrl);
const templates = [...TEMPLATES];
if (process.argv.includes('--imports')) {
  const { listImported, importedTemplate } = await import('../library/workflows/store.js');
  for (const row of await listImported()) {
    const template = importedTemplate(row);
    if (template) templates.push(template);
  }
  await (await import('../db.js')).pool.end();
}
for (const template of templates) {
  const started = Date.now();
  try {
    const binding = template.manifest.inputs.find((input) => input.source === 'checkpointFilename');
    const [nodeId, , inputName] = binding?.path.split('.') ?? [];
    const node = nodeId ? template.graph[nodeId] : undefined;
    const spec = node ? info[node.class_type] : undefined;
    const options = inputName ? comboOptions(spec?.input?.required?.[inputName] ?? spec?.input?.optional?.[inputName]) ?? [] : [];
    const literal = node && inputName ? node.inputs[inputName] : undefined;
    const filename = options.find((name) => name === literal) ?? (!template.manifest.id.startsWith('library-') ? options.find((name) => {
      const family = inferFamily({ filename: name });
      return family && template.manifest.baseModels.some((base) => normalizeBaseModel(base) === normalizeBaseModel(family));
    }) : undefined);
    const graph = withResolvedRequirements(template.graph, template, info);
    const checks = checkGraph(graph, info);
    if (checks.missingNodeClasses.length) throw new Error(`Missing node: ${checks.missingNodeClasses.join(', ')}`);
    if (!filename) {
      const folder = typeof literal === 'string' ? folderOfInstalled(info, literal) : null;
      throw new Error(folder && folder !== loaderFolderOf(template) ? `Wrong folder: ${literal} is in ${folder}` : `Missing file: ${literal}`);
    }
    if (process.argv.includes('--check-only')) {
      const missing = checks.missingFiles.filter((file) => file.nodeId !== nodeId || file.input !== inputName);
      console.log(JSON.stringify({ template: template.manifest.id, status: missing.length ? 'missing-file' : 'untested', missing: missing.map((file) => file.filename) }));
      continue;
    }
    const test = await submitSmoke(template, baseUrl, info, filename);
    console.log(JSON.stringify({ template: template.manifest.id, status: 'submitted', ...test }));
    while (true) {
      const result = await inspectSmoke(baseUrl, test.promptId);
      if (result.status !== 'running') {
        console.log(JSON.stringify({ template: template.manifest.id, ...result, seconds: (Date.now() - started) / 1000 }));
        break;
      }
      if (Date.now() - started > 30 * 60_000) {
        console.log(JSON.stringify({ template: template.manifest.id, status: 'timeout', promptId: test.promptId }));
        // Do not submit the next graph while an earlier job may still be running.
        process.exitCode = 1;
        break;
      }
      await delay(3000);
    }
    if (process.exitCode) break;
  } catch (error) {
    const message = (error as Error).message;
    const status = message.startsWith('Missing node:') ? 'missing-node' : message.startsWith('Wrong folder:') ? 'wrong-folder' : message.startsWith('Missing file:') ? 'missing-file' : 'failed';
    console.log(JSON.stringify({ template: template.manifest.id, status, error: message }));
  }
}
