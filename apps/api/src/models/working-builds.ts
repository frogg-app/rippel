/**
 * The build of a family that is known to load in ComfyUI, for when the file a
 * person picked cannot.
 *
 * A diffusers-format file ("This file won't run") has no repair: no part, no
 * folder makes ComfyUI read it. What the person wanted was the model, so the
 * one useful offer is the same family in a form ComfyUI loads. Every row points
 * at a `KNOWN_DOWNLOADS` file, so a URL somebody has opened, never a guess.
 */
import type { ModelCatalogEntry } from '@comfy/shared';
import { FAMILIES, inferFamily, type ModelFamily } from './family.js';
import { KNOWN_DOWNLOADS } from './known-downloads.js';

const WORKING_BUILD: Partial<Record<ModelFamily, string>> = {
  // Lightricks' single-file build: model and VAE together, as
  // CheckpointLoaderSimple expects.
  [FAMILIES.ltxVideo]: 'ltx-video-2b-v0.9.5.safetensors',
  [FAMILIES.wan22Ti2v5b]: 'wan2.2_ti2v_5B_fp16.safetensors',
};

function sizeWords(bytes: number | null | undefined): string | null {
  return bytes ? `${(bytes / 1e9).toFixed(1)} GB` : null;
}

/**
 * The install for a working build of this model's family, as a catalogue entry
 * `startInstall` takes. Null when the family has none, or when the model is
 * that build already.
 */
export function workingBuildFor(model: { filename: string; base_model: string | null }): ModelCatalogEntry | null {
  const family = inferFamily({ filename: model.filename, catalogueBase: model.base_model });
  const filename = family ? WORKING_BUILD[family] : undefined;
  const source = filename ? KNOWN_DOWNLOADS.find((row) => row.filename === filename) : undefined;
  if (!family || !source) return null;
  if (model.filename.split(/[\\/]/).pop()!.toLowerCase() === source.filename.toLowerCase()) return null;
  const repo = new URL(source.url).pathname.split('/').slice(1, 3).join('/');
  return {
    ref: `hugging-face:${repo}`,
    name: source.filename.replace(/\.safetensors$/i, ''),
    filename: source.filename,
    type: 'checkpoint',
    base: family,
    description: null,
    size: sizeWords(source.approxBytes),
    url: source.url,
    reference: `https://huggingface.co/${repo}`,
    savePath: source.folder,
    installed: false,
    info: null,
    runnability: null,
  };
}
