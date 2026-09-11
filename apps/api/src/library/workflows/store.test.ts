import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../db.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { query } from '../../db.js';
import { findImported, importedTemplate, manifestData, readyBackendIds, type ImportedWorkflow } from './store.js';
import { findAvailableTemplate } from '../../workflows/registry.js';
import { img2vidWan22Template as builtin } from '../../workflows/img2vid-wan22-5b.js';
import { chooseTemplate } from '../../models/workflow-choice.js';
import { compile } from '../../compiler/compile.js';

const id = '00000000-0000-4000-8000-000000000001';
function row(): ImportedWorkflow {
  return { id, library_name: 'wan', library_version: '0.11.55', workflow_date: '2026-09-11',
    title: 'Wan', description: '', thumbnail: null, capability: 'img2vid', family: 'wan2.2-ti2v-5b',
    graph: builtin.graph, manifest: JSON.parse(JSON.stringify(manifestData(builtin.manifest))),
    files: [], omitted: [], source_backend_id: null, created_at: new Date() };
}
beforeEach(() => vi.mocked(query).mockReset());
it('round-trips a manifest through JSON and compiles the restored graph', () => {
  const template = importedTemplate(row())!;
  expect(template.manifest.id).toBe(`library-${id}`);
  for (const requirement of template.manifest.requires ?? []) {
    expect(requirement.match.filename?.test(requirement.preferred![0]!)).toBe(true);
    expect(requirement.match.filename?.test(`wrong${requirement.preferred![0]}`)).toBe(false);
  }
  const result = compile({ template, jobId: id, modelFilenames: { wan: 'wan2.2_ti2v_5B_fp16.safetensors' },
    params: { kind: 'img2vid', modelId: 'wan', prompt: 'Waves', quality: 'fast', aspect: '16:9', batchSize: 1,
      video: { lengthSeconds: 1, fps: 5 } } });
  expect(result.graph['6']?.inputs.text).toBe('Waves');
});
it('keeps built-ins ahead of automatic library lookup', async () => {
  const lookupImported = vi.fn().mockResolvedValue(importedTemplate(row()));
  expect(await findAvailableTemplate({ capability: 'img2vid', family: 'wan2.2-ti2v-5b', lookupImported })).toBe(builtin);
  expect(lookupImported).not.toHaveBeenCalled();
});
it('uses a library choice explicitly or for a family without a built-in', async () => {
  const template = importedTemplate(row());
  const lookupImported = vi.fn().mockResolvedValue(template);
  expect(await findAvailableTemplate({ capability: 'img2vid', family: 'new-family', lookupImported })).toBe(template);
  const choice = await chooseTemplate({ modelId: 'wan', capability: 'img2vid', family: 'wan2.2-ti2v-5b',
    lookupOverride: async () => `library-${id}`, lookupImported });
  expect(choice?.template).toBe(template);
  expect(choice?.source).toBe('pinned');
});
it('does not fall back from an unavailable explicit workflow', async () => {
  expect(await findAvailableTemplate({ capability: 'img2vid', family: 'wan2.2-ti2v-5b', id: `library-${id}`,
    lookupImported: async () => undefined })).toBeUndefined();
  expect(await findAvailableTemplate({ capability: 'img2vid', family: 'sdxl', id: builtin.manifest.id })).toBeUndefined();
});
it('requires a ready online backend and the tested model filename', async () => {
  vi.mocked(query).mockResolvedValue([row()]);
  expect(await findImported({ capability: 'img2vid', family: 'wan2.2-ti2v-5b', id: `library-${id}`,
    backendId: id, filename: 'another-model.safetensors' })).toBeUndefined();
  const [sql, params] = vi.mocked(query).mock.calls[0]!;
  expect(sql).toContain("t.status = 'ready'");
  expect(sql).toContain("b.enabled AND b.status = 'online'");
  expect(params).toEqual(['img2vid', 'wan22ti2v5b', id, id]);
  vi.mocked(query).mockResolvedValue([]);
  expect(await readyBackendIds(`library-${id}`)).toEqual([]);
});
