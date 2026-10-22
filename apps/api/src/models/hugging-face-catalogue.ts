import type { JobKind, ModelCatalogEntry } from '@comfy/shared';
import { declaredBaseModels } from './metadata-sources.js';
import { normaliseTags } from './tags.js';
import { huggingFaceFamilyBase, variantSavePath, weightVariants, type TreeFile } from './hugging-face-files.js';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
const tasks: Record<string, JobKind> = { 'text-to-image': 'txt2img', 'image-to-image': 'img2img', 'text-to-video': 'txt2vid', 'image-to-video': 'img2vid' };
const modelSchema = z.object({ id: z.string().regex(/^[\w.-]+\/[\w.-]+$/), pipeline_tag: z.string().optional(), cardData: z.object({base_model: z.unknown().optional(), description: z.string().optional()}).optional(),
  gated: z.union([z.boolean(), z.string()]).optional(), downloads: z.number().optional(), tags: z.array(z.string()).optional(),
  siblings: z.array(z.object({ rfilename: z.string() })).optional() });
let refreshing = false;
export const huggingFaceCataloguePending = () => refreshing ? 1 : 0;
const REFRESH_MS = 6 * 60 * 60_000;
export function huggingFaceEntry(value: unknown): ModelCatalogEntry | null {
  const parsed = modelSchema.safeParse(value);
  if (!parsed.success) return null;
  const model = parsed.data;
  const tags = model.tags ?? [];
  const type = tags.includes('vae') ? 'vae' : tags.includes('lora') || tags.includes('peft') ? 'lora' : 'checkpoint';
  const task = model.pipeline_tag ? tasks[model.pipeline_tag] : undefined;
  if (!task && !(type === 'vae' || (type === 'lora' && tags.some(tag => /^(diffusers|stable-diffusion|text-to-image|image-to-video|text-to-video)$/.test(tag))))) return null;
  const baseModels = declaredBaseModels(model.cardData?.base_model);
  // The files a person can actually install, best first; the first one is what
  // the card offers until somebody picks another version.
  const files = weightVariants((model.siblings ?? []).map(sibling => sibling.rfilename), type);
  const familyBase = huggingFaceFamilyBase(model.id, baseModels, files[0]?.filename ?? null);
  const repositoryPath = familyBase && CHECKPOINT_FAMILY_BASES.has(familyBase) && !tags.includes('gguf')
    ? ''
    : huggingFaceSavePath(type, model.id, tags, baseModels);
  const variants = files.map(variant => ({ ...variant, savePath: variantSavePath(variant, repositoryPath) }));
  const chosen = variants[0] ?? null;
  const blocked = model.gated && model.gated !== 'false'
    ? 'Access required on Hugging Face. Authenticated downloads are not supported yet.'
    : !chosen
      ? 'No single file ComfyUI can load: this repository is in Diffusers folders, or only in formats no stock loader reads.'
      : undefined;
  return { ref: `hugging-face:${model.id}`, name: model.id, filename: chosen?.filename ?? model.id.split('/')[1]!,
    type, base: familyBase ?? (baseModels.length === 1 ? baseModels[0]! : 'Hugging Face'), description: model.cardData?.description?.slice(0,600) ?? null,
    size: null, url: chosen ? huggingFaceFileUrl(model.id, chosen.path) : `https://huggingface.co/${model.id}`, reference: `https://huggingface.co/${model.id}`,
    savePath: chosen?.savePath ?? repositoryPath,
    installed: false, ...(blocked ? { installBlockedReason: blocked } : {}), ...(variants.length ? { variants } : {}),
    info: { baseModels, tags: normaliseTags(tags, { pipelineTag: model.pipeline_tag ?? null, license: model.tags?.find(tag => tag.startsWith('license:'))?.slice(8) ?? null, baseModels }), previewUrl: null, previewFullUrl: null, previewFrom: null, previewBorrowedFrom: null,
      license: model.tags?.find(tag => tag.startsWith('license:'))?.slice(8) ?? null, downloads: model.downloads ?? null, likes: null, pipelineTag: model.pipeline_tag ?? null, referenceUrl: `https://huggingface.co/${model.id}` },
    runnability: { status: type === 'checkpoint' ? 'unknown' : 'support', family: null, capabilities: task ? [task] : [],
      summary: 'Compatibility not checked', detail: 'Listed on Hugging Face; a supported local workflow has not been verified.', missing: [], backendId: null } };
}
/**
 * The entry re-pointed at one of its other builds, or null when the repository
 * has no such file. Everything that identifies the model stays; only what to
 * download and where it lands changes.
 */
export function withVariant(entry: ModelCatalogEntry, path: string): ModelCatalogEntry | null {
  const variant = entry.variants?.find(candidate => candidate.path === path);
  if (!variant) return null;
  const id = entry.ref.slice('hugging-face:'.length);
  return { ...entry, filename: variant.filename, url: huggingFaceFileUrl(id, variant.path), savePath: variant.savePath ?? entry.savePath };
}

/** The cached entry for a `hugging-face:` ref, optionally at one of its builds. */
export async function huggingFaceEntryFor(ref: string, variant?: string): Promise<ModelCatalogEntry | null> {
  const entry = (await cachedHuggingFaceModels()).find(candidate => candidate.ref === ref);
  if (!entry) return null;
  return variant ? withVariant(entry, variant) : entry;
}

const trees = new Map<string, { at: number; files: TreeFile[] }>();
const TREE_TTL_MS = 60 * 60_000;

/**
 * Every file in a repository with its size and SHA-256, from the Hub's tree
 * listing. Asked only when somebody opens a model's versions, and remembered
 * for an hour: the listing the catalogue refreshes from carries names only.
 */
export async function huggingFaceTree(id: string): Promise<TreeFile[]> {
  const cached = trees.get(id);
  if (cached && Date.now() - cached.at < TREE_TTL_MS) return cached.files;
  const response = await fetch(`https://huggingface.co/api/models/${id}/tree/main?recursive=true`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Hugging Face did not list ${id}'s files (HTTP ${response.status}).`);
  const body = treeSchema.safeParse(await response.json());
  if (!body.success) throw new Error(`Hugging Face's file list for ${id} was unreadable.`);
  const files = body.data
    .filter(item => item.type === 'file')
    .map(item => ({ path: item.path, size: item.lfs?.size ?? item.size ?? 0, sha256: item.lfs?.oid ?? null }));
  trees.set(id, { at: Date.now(), files });
  return files;
}
const treeSchema = z.array(z.object({ type: z.string(), path: z.string(), size: z.number().optional(),
  lfs: z.object({ oid: z.string(), size: z.number().optional() }).optional() }));

/** The download address of one file in a repository, on its main branch. */
export function huggingFaceFileUrl(id: string, path: string): string {
  return `https://huggingface.co/${id}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Where a Hugging Face model's main file goes. Hugging Face says nothing about
 * ComfyUI folders, and treating every repo as a classic all-in-one checkpoint
 * judged FLUX, Qwen-Image, Wan and every GGUF build against `checkpoints/` —
 * where their loaders never look. Those families ship the diffusion model on
 * its own (the text encoder and decoder are separate files), so they belong
 * in `diffusion_models/`. Anything unrecognised stays a checkpoint, which is
 * still the right answer for the SD 1.5 / SDXL fine-tunes that are most of
 * the list.
 */
export function huggingFaceSavePath(type: string, id: string, tags: readonly string[], baseModels: readonly string[]): string {
  if (type !== 'checkpoint') return '';
  if (tags.includes('gguf')) return 'diffusion_models';
  const names = [id, ...baseModels].join(' ').toLowerCase();
  return DIFFUSION_MODEL_FAMILIES.test(names) ? 'diffusion_models' : '';
}

// Whole words only: "zavychromaxl" is an SDXL fine-tune, not Chroma.
const DIFFUSION_MODEL_FAMILIES = /(^|[^a-z0-9])(flux|qwen[-_]?image|wan[-_]?2|hunyuan|z[-_]?image|hidream|cosmos|ltx[-_]?2|chroma|lumina|omnigen)/;

/** Families whose files are whole checkpoints, whatever the repository's name says. */
const CHECKPOINT_FAMILY_BASES = new Set(['SDXL', 'SDXL Turbo', 'Pony', 'Illustrious', 'SD1.5', 'SD2.x', 'SVD']);

export async function cachedHuggingFaceModels(): Promise<ModelCatalogEntry[]> {
  const row = await queryOne<{ entries: ModelCatalogEntry[] }>("SELECT entries FROM external_model_catalogues WHERE source='hugging-face'");
  return row?.entries ?? [];
}
/** Bounded discovery of popular and newly updated image/video models. No model
 * weights or repository code are downloaded; only public Hub metadata. */
export async function refreshHuggingFaceCatalogue(force = false): Promise<number | null> {
  const previous = await queryOne<{ refreshed_at: Date }>("SELECT refreshed_at FROM external_model_catalogues WHERE source='hugging-face'");
  if (!force && previous && Date.now() - previous.refreshed_at.getTime() < REFRESH_MS) return null;
  const entries = new Map<string, ModelCatalogEntry>();
  for (const pipeline of [...Object.keys(tasks), 'lora', 'vae']) {
    for (const [sort, limit] of [['downloads', '500'], ['lastModified', '100']] as const) {
      const params = new URLSearchParams({ ...(['lora','vae'].includes(pipeline) ? { filter: pipeline } : { pipeline_tag: pipeline }), sort, direction: '-1', limit, full: 'true', cardData: 'true' });
      const response = await fetch(`https://huggingface.co/api/models?${params}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Hugging Face catalogue returned HTTP ${response.status}. Keeping the cached list.`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error('Hugging Face catalogue was unreadable. Keeping the cached list.');
      for (const value of body) { const entry = huggingFaceEntry(value); if (entry) entries.set(entry.ref, entry); }
    }
  }
  if (!entries.size) throw new Error('Hugging Face returned no image/video models. Keeping the cached list.');
  await query(`INSERT INTO external_model_catalogues(source,entries,refreshed_at) VALUES ('hugging-face',$1::jsonb,now())
    ON CONFLICT(source) DO UPDATE SET entries=excluded.entries,refreshed_at=excluded.refreshed_at`, [JSON.stringify([...entries.values()])]);
  return entries.size;
}
export function startHuggingFaceCataloguePoller(log: (message: string) => void) {
  let busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true; refreshing = true;
    try { const count = await refreshHuggingFaceCatalogue(); if (count !== null) log(`Hugging Face catalogue: cached ${count} models.`); }
    catch (error) { log(String(error)); }
    finally { busy = false; refreshing = false; }
  };
  // Check hourly; refresh only after six hours, retry sooner after an outage.
  const timer = setInterval(() => void tick(), 60 * 60_000);
  timer.unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
