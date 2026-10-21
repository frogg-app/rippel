import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { query, queryOne } from '../db.js';
import { huggingFaceEntry, refreshHuggingFaceCatalogue, cachedHuggingFaceModels } from './hugging-face-catalogue.js';
const model = { id: 'krea/Krea-2-Turbo', pipeline_tag: 'text-to-image', gated: 'auto', downloads: 70000 };
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllGlobals());
it('includes gated models while keeping access and compatibility explicit', () => {
  expect(huggingFaceEntry(model)).toMatchObject({ name: model.id, installBlockedReason: expect.stringContaining('Access required'), runnability: { status: 'unknown', capabilities: ['txt2img'] }, info: { downloads: 70000 } });
  expect(huggingFaceEntry({ ...model, gated: false })?.installBlockedReason).toContain('compatible workflow');
  expect(huggingFaceEntry({ ...model, pipeline_tag: 'text-generation' })).toBeNull();
});
it('fetches generation tasks in the background and saves one deduplicated snapshot', async () => {
  const fetchMock = vi.fn(async () => Response.json([model])); vi.stubGlobal('fetch', fetchMock);
  expect(await refreshHuggingFaceCatalogue(true)).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(12);
  expect(query).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(vi.mocked(query).mock.calls[0]![1]![0] as string);
  expect(saved).toHaveLength(1);
  expect(saved[0].name).toBe(model.id);
});
it('keeps the old snapshot if any upstream page fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([model])).mockResolvedValueOnce(new Response(null, { status: 503 })));
  await expect(refreshHuggingFaceCatalogue(true)).rejects.toThrow('Keeping the cached list');
  expect(query).not.toHaveBeenCalled();
});
it('uses the database cache without fetching on page reads or before refresh is due', async () => {
  vi.mocked(queryOne).mockResolvedValueOnce({ refreshed_at: new Date() }).mockResolvedValueOnce({ entries: [huggingFaceEntry(model)] });
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  expect(await refreshHuggingFaceCatalogue()).toBeNull();
  expect(await cachedHuggingFaceModels()).toHaveLength(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('discovers visual adapters and VAEs without inventing checkpoint compatibility', () => {
 expect(huggingFaceEntry({id:'author/style',tags:['lora','diffusers'],cardData:{base_model:'black-forest-labs/FLUX.1-dev'}})).toMatchObject({type:'lora',info:{baseModels:['black-forest-labs/FLUX.1-dev']},runnability:{status:'support'}});
 expect(huggingFaceEntry({id:'author/decoder',tags:['vae']})).toMatchObject({type:'vae'});
 expect(huggingFaceEntry({id:'author/chat',tags:['lora','text-generation']})).toBeNull();
});
