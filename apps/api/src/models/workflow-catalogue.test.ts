import { expect, it, vi } from 'vitest';
vi.mock('../library/workflows/catalogue.js', () => ({ workflowLibrary: { catalogue: vi.fn(), workflow: vi.fn() } }));
import { workflowLibrary, type LibraryEntry } from '../library/workflows/catalogue.js';
import { workflowModelEntries, workflowCatalogue, workflowCataloguePending } from './workflow-catalogue.js';
const entry = { name: 'krea', title: 'Krea-2: Text to Image', models: ['Krea 2'], openSource: true, date: '2026-07-08' } as LibraryEntry;
const file = { name: 'krea.safetensors', directory: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea.safetensors' };
const graph = (files = [file]) => ({ nodes: [{ type: 'UNETLoader', properties: { models: files } }] });
it('discovers exact workflow files including nested subgraph declarations', () => {
  const models = workflowModelEntries({ definitions: { subgraphs: [graph()] } }, entry);
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({ ref: 'diffusion_models/krea.safetensors', base: 'Krea 2', reference: 'https://huggingface.co/Comfy-Org/Krea-2', sourceWorkflow: { name: 'krea' }, runnability: null });
});
it('rejects unsupported sources, traversal, executable files and mismatched loader folders', () => {
  expect(workflowModelEntries(graph([
    { ...file, name: '../model.safetensors' }, { ...file, name: 'code.py' },
    { ...file, url: 'http://127.0.0.1/private.safetensors' },
    { ...file, url: 'https://huggingface.co.evil.example/a/b/resolve/main/model.safetensors' },
    { ...file, directory: 'custom_nodes' }, { ...file, directory: 'vae' },
  ]), entry)).toEqual([]);
});
it('fills the catalogue in the background and survives an unavailable template', async () => {
  vi.mocked(workflowLibrary.catalogue).mockResolvedValue({ version: '1.0.0', entries: [entry, { ...entry, name: 'broken' }] });
  vi.mocked(workflowLibrary.workflow).mockImplementation(async (_id, _url, name) => { if (name === 'broken') throw new Error('missing'); return graph(); });
  expect(workflowCatalogue('backend-test', 'http://desktop')).toEqual([]);
  expect(workflowCataloguePending('backend-test', 'http://desktop')).toBeGreaterThan(0);
  await vi.waitFor(() => expect(workflowCataloguePending('backend-test', 'http://desktop')).toBe(0));
  expect(workflowCatalogue('backend-test', 'http://desktop')).toHaveLength(1);
});
