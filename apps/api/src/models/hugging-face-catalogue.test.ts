import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { query, queryOne } from '../db.js';
import { huggingFaceEntry, huggingFaceSavePath, refreshHuggingFaceCatalogue, cachedHuggingFaceModels, withVariant } from './hugging-face-catalogue.js';
const model = { id: 'krea/Krea-2-Turbo', pipeline_tag: 'text-to-image', gated: 'auto', downloads: 70000 };
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllGlobals());
it('includes gated models while keeping access and compatibility explicit', () => {
  expect(huggingFaceEntry(model)).toMatchObject({ name: model.id, installBlockedReason: expect.stringContaining('Access required'), runnability: { status: 'unknown', capabilities: ['txt2img'] }, info: { downloads: 70000 } });
  // Without a single loadable file there is nothing to install, and it says why.
  expect(huggingFaceEntry({ ...model, gated: false })?.installBlockedReason).toContain('No single file');
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

it('puts diffusion-model-only families and GGUF builds in diffusion_models, not checkpoints', () => {
  expect(huggingFaceSavePath('checkpoint', 'black-forest-labs/FLUX.1-dev', [], [])).toBe('diffusion_models');
  expect(huggingFaceSavePath('checkpoint', 'Qwen/Qwen-Image', [], [])).toBe('diffusion_models');
  expect(huggingFaceSavePath('checkpoint', 'someone/anything', ['gguf'], [])).toBe('diffusion_models');
  expect(huggingFaceSavePath('checkpoint', 'someone/finetune', [], ['Wan-AI/Wan2.1-T2V-14B'])).toBe('diffusion_models');
  // The SD 1.5 / SDXL fine-tunes that are most of the list stay checkpoints.
  expect(huggingFaceSavePath('checkpoint', 'someone/juggernaut-xl', [], ['stabilityai/stable-diffusion-xl-base-1.0'])).toBe('');
  expect(huggingFaceSavePath('lora', 'someone/flux-style-lora', [], [])).toBe('');
  expect(huggingFaceEntry({ ...model, id: 'black-forest-labs/FLUX.1-schnell' })?.savePath).toBe('diffusion_models');
});

const files = (...names: string[]) => names.map((rfilename) => ({ rfilename }));

it('makes a repository with a loadable file installable, defaulting to its best build', () => {
  const entry = huggingFaceEntry({
    id: 'black-forest-labs/FLUX.1-dev', pipeline_tag: 'text-to-image', gated: false,
    siblings: files('README.md', 'ae.safetensors', 'flux1-dev.safetensors', 'transformer/diffusion_pytorch_model-00001-of-00003.safetensors'),
  })!;
  expect(entry.installBlockedReason).toBeUndefined();
  expect(entry.filename).toBe('flux1-dev.safetensors');
  expect(entry.url).toBe('https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors');
  expect(entry.savePath).toBe('diffusion_models');
  // Judged against our FLUX workflow, not left as "Hugging Face".
  expect(entry.base).toBe('FLUX.1');
  expect(entry.variants!.map((v) => v.filename)).toEqual(['flux1-dev.safetensors']);
});

it('offers a GGUF repository at Q8 and re-points the entry at another build', () => {
  const entry = huggingFaceEntry({
    id: 'city96/FLUX.1-dev-gguf', pipeline_tag: 'text-to-image',
    siblings: files('flux1-dev-F16.gguf', 'flux1-dev-Q4_K_S.gguf', 'flux1-dev-Q8_0.gguf', 'flux1-dev-Q2_K.gguf'),
  })!;
  expect(entry.filename).toBe('flux1-dev-Q8_0.gguf');
  expect(entry.savePath).toBe('diffusion_models');
  const smaller = withVariant(entry, 'flux1-dev-Q4_K_S.gguf')!;
  expect(smaller).toMatchObject({ ref: entry.ref, filename: 'flux1-dev-Q4_K_S.gguf', savePath: 'diffusion_models' });
  expect(smaller.url).toMatch(/flux1-dev-Q4_K_S\.gguf$/);
  expect(withVariant(entry, 'not-in-the-repo.gguf')).toBeNull();
});

it('blocks a Diffusers-only repository with the reason', () => {
  const entry = huggingFaceEntry({
    id: 'Wan-AI/Wan2.1-T2V-14B', pipeline_tag: 'text-to-video',
    siblings: files('diffusion_pytorch_model-00001-of-00006.safetensors', 'model_index.json'),
  })!;
  expect(entry.installBlockedReason).toContain('Diffusers');
  expect(entry.variants).toBeUndefined();
});

it('keeps an SDXL fine-tune whose name contains another family in checkpoints', () => {
  const entry = huggingFaceEntry({
    id: 'misri/zavychromaxl_v80', pipeline_tag: 'text-to-image',
    cardData: { base_model: 'stabilityai/stable-diffusion-xl-base-1.0' },
    siblings: files('zavychromaxl_v80.safetensors'),
  })!;
  expect(entry.base).toBe('SDXL');
  expect(entry.savePath).toBe('');
});

it('does not take FLUX.2 for FLUX.1', () => {
  const entry = huggingFaceEntry({
    id: 'leejet/FLUX.2-klein-4B-GGUF', pipeline_tag: 'text-to-image',
    siblings: files('flux-2-klein-4b-Q8_0.gguf'),
  })!;
  expect(entry.base).not.toBe('FLUX.1');
});
