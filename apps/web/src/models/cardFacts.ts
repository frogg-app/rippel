/**
 * What a card leads with: a short name, its author, and one "size · fit" pill.
 *
 * The catalogue's own `name` is whatever its source spelled: a Hugging Face
 * repo id ("stabilityai/stable-diffusion-xl-base-1.0"), a workflow row
 * ("SDXL · sd_xl_base_1.0.safetensors") or a ComfyUI-Manager label. Prefixing
 * an owner onto any of those made titles that truncated before the part you
 * choose by. So the title is the repo's own short name where there is a repo,
 * and the author moves to a quieter second line.
 *
 * ## Grouping
 *
 * The same repository reaches the catalogue several times: once from Hugging
 * Face discovery and again per file from ComfyUI-Manager and the workflow
 * library (three SDXL base files, for one). Those are grouped here, on the
 * client, by repository and type, so the grid shows one card with "3 files"
 * and the drawer offers the choice. Type is part of the key because the
 * Comfy-Org "repackaged" repos hold a model, its VAE and its text encoder side
 * by side, and those are three different things to install.
 *
 * This is client-side for the prototype; the API could do it once instead.
 */
import type { Model, ModelCatalogEntry, ModelInstall, ModelRunnability } from '@comfy/shared';
import { basename, formatBytes, generates, RUNNABILITY_LABEL, RUNNABILITY_TONE } from './catalogue';
import { statusRank, verdictLabel } from './intents';

const HF_REPO = /^https?:\/\/huggingface\.co\/([^/\s?#]+)\/([^/\s?#]+)/i;

/** `owner/repo` of the entry's Hugging Face page, or null off Hugging Face. */
export function repoOf(entry: Pick<ModelCatalogEntry, 'ref' | 'reference' | 'info'>): { owner: string; repo: string } | null {
  for (const page of [entry.info?.referenceUrl, entry.reference]) {
    const match = page ? HF_REPO.exec(page) : null;
    if (match) return { owner: match[1]!, repo: match[2]! };
  }
  const discovered = /^hugging-face:([^/]+)\/(.+)$/.exec(entry.ref);
  return discovered ? { owner: discovered[1]!, repo: discovered[2]! } : null;
}

/** The Hugging Face model page, for "View on Hugging Face". */
export function huggingFaceUrl(entry: Pick<ModelCatalogEntry, 'ref' | 'reference' | 'info'>): string | null {
  const repo = repoOf(entry);
  return repo ? `https://huggingface.co/${repo.owner}/${repo.repo}` : null;
}

function stem(filename: string): string {
  return basename(filename).replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i, '');
}

/**
 * The title: the repo's short name, or failing that the catalogue name with
 * its owner and " · file" suffix taken off, or the file's stem.
 */
export function shortName(entry: ModelCatalogEntry): string {
  const repo = repoOf(entry);
  if (repo) return repo.repo;
  const name = entry.name.includes(' · ') ? entry.name.split(' · ')[0]! : entry.name;
  const bare = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return bare.trim() || stem(entry.filename);
}

/** The second line: who published it. Null off Hugging Face. */
export function authorOf(entry: ModelCatalogEntry): string | null {
  return repoOf(entry)?.owner ?? null;
}

/** Everything a hover should reveal: the full id and the file. */
export function fullId(entry: ModelCatalogEntry): string {
  const repo = repoOf(entry);
  const id = repo ? `${repo.owner}/${repo.repo}` : entry.name;
  return id === entry.filename ? id : `${id}\n${entry.filename}`;
}

/**
 * The catalogue's human size string as bytes. ComfyUI-Manager writes "6.94GB",
 * "335MB", sometimes "1.2 GiB"; treat G/M/K as decimal unless an "i" says not.
 */
export function parseSize(size: string | null | undefined): number | null {
  if (!size) return null;
  const match = /^\s*([\d.]+)\s*([KMGT]?)(i?)B?\s*$/i.exec(size);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const power = ' KMGT'.indexOf(match[2]!.toUpperCase() || ' ');
  return value * (match[3] ? 1024 : 1000) ** Math.max(power, 0);
}

/** Bytes of the default file, from the catalogue or the chosen variant. */
export function sizeBytesOf(entry: ModelCatalogEntry): number | null {
  const parsed = parseSize(entry.size);
  if (parsed) return parsed;
  const variant = entry.variants?.find((v) => v.filename === entry.filename) ?? entry.variants?.[0];
  return variant?.sizeBytes ?? null;
}

/**
 * The graphics memory a backend says it has, preferring an operator's limit.
 * A reported budget, not a card's physical size: see `Backend.vramTotal`.
 */
export function backendMemory(backend: { vramTotal: number | null; vramLimitMb: number | null } | null): number | null {
  if (!backend) return null;
  if (backend.vramLimitMb) return backend.vramLimitMb * 1024 * 1024;
  return backend.vramTotal ?? null;
}

export type FitTone = 'good' | 'soft' | 'warn' | 'bad' | 'muted';

export interface Fit {
  /** "6.9 GB · fits". */
  label: string;
  tone: FitTone;
  /** The longer sentence, for the tooltip and the drawer. */
  detail: string;
}

/**
 * Size against memory, in three words. The file has to sit in graphics memory
 * with room for the working set beside it, so "fits" leaves a fifth spare;
 * "should fit" is the band where it loads but offloading may kick in.
 */
export function sizeFit(bytes: number, memory: number): { word: string; tone: FitTone } {
  if (bytes <= memory * 0.8) return { word: 'fits', tone: 'good' };
  if (bytes <= memory) return { word: 'should fit', tone: 'soft' };
  return { word: 'too big', tone: 'bad' };
}

function sizeFitOf(bytes: number, memory: number): { label: string; tone: FitTone } {
  const { word, tone } = sizeFit(bytes, memory);
  return { label: `${formatBytes(bytes)} · ${word}`, tone };
}

/** A verdict that no amount of memory fixes: say that instead of the fit. */
function blocking(verdict: ModelRunnability | null): boolean {
  if (!verdict) return false;
  if (verdict.missingNode) return true;
  // Missing parts get their own pills (NeedsPills); the fit still stands.
  if (verdict.status === 'needs-companion' && verdict.missing.length > 0) return false;
  return RUNNABILITY_TONE[verdict.status] === 'warn';
}

/**
 * The card's one pill. Size first, then the most useful word about it:
 *
 *   - a support file says what it is ("335 MB · VAE");
 *   - a model that will not run says why ("6.9 GB · not supported yet");
 *   - otherwise the size against this machine's memory, falling back to the
 *     verdict's own label when either number is unknown.
 */
export function fitOf(
  entry: Pick<ModelCatalogEntry, 'type' | 'runnability'>,
  bytes: number | null,
  memory: number | null,
  supportNoun: string,
): Fit {
  const size = bytes ? formatBytes(bytes) : null;
  const join = (word: string) => (size ? `${size} · ${word}` : word.charAt(0).toUpperCase() + word.slice(1));
  const verdict = entry.runnability;
  if (!generates(entry.type)) {
    return { label: join(supportNoun.toLowerCase()), tone: 'muted', detail: verdict?.detail ?? verdict?.summary ?? supportNoun };
  }
  const said = verdict ? verdict.detail ?? verdict.summary : 'Not checked against this machine.';
  if (blocking(verdict)) {
    return { label: join(verdictLabel(verdict!).toLowerCase()), tone: 'warn', detail: said };
  }
  if (verdict?.status === 'needs-companion' && verdict.missing.length > 0) {
    return bytes && memory
      ? { ...sizeFitOf(bytes, memory), detail: said }
      : { label: size ?? 'size unknown', tone: 'muted', detail: said };
  }
  if (bytes && memory) {
    const { word, tone } = sizeFit(bytes, memory);
    return {
      label: join(word),
      tone: tone === 'good' && verdict?.status === 'generic' ? 'soft' : tone,
      detail: `${formatBytes(bytes)} file, ${formatBytes(memory)} of graphics memory. ${said}`,
    };
  }
  const word = verdict ? RUNNABILITY_LABEL[verdict.status] : 'Unchecked';
  return {
    label: join(word.toLowerCase()),
    tone: verdict ? (RUNNABILITY_TONE[verdict.status] === 'good' ? 'good' : RUNNABILITY_TONE[verdict.status] === 'soft' ? 'soft' : 'muted') : 'muted',
    detail: said,
  };
}

/** The Installed tab's version: a local file has bytes, not a size string. */
export function modelFit(model: Model, verdict: ModelRunnability | null, memory: number | null, supportNoun: string): Fit {
  return fitOf({ type: model.type, runnability: verdict }, model.sizeBytes, memory, supportNoun);
}

// ---------------------------------------------------------------- grouping

export interface EntryGroup {
  key: string;
  /** The card's face: installed first, then the best verdict, then one with a size. */
  primary: ModelCatalogEntry;
  /** Every file in the group, primary first. */
  entries: ModelCatalogEntry[];
}

export function groupKey(entry: ModelCatalogEntry): string {
  const repo = repoOf(entry);
  return repo ? `${repo.owner}/${repo.repo}`.toLowerCase() + `|${entry.type}` : `ref:${entry.ref}`;
}

function primaryOrder(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  return (
    Number(b.installed) - Number(a.installed) ||
    Number(Boolean(a.installBlockedReason)) - Number(Boolean(b.installBlockedReason)) ||
    statusRank(a) - statusRank(b) ||
    Number(Boolean(b.info?.previewUrl)) - Number(Boolean(a.info?.previewUrl)) ||
    Number(sizeBytesOf(b) !== null) - Number(sizeBytesOf(a) !== null)
  );
}

/** Groups in the order their first member appeared; members best first. */
export function groupEntries(entries: readonly ModelCatalogEntry[]): EntryGroup[] {
  const byKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const list = byKey.get(key);
    if (list) list.push(entry);
    else byKey.set(key, [entry]);
  }
  return [...byKey].map(([key, members]) => {
    // A stable sort: equal members keep the catalogue's order.
    const sorted = [...members].sort(primaryOrder);
    return { key, primary: sorted[0]!, entries: sorted };
  });
}

/** "3 files", or the version count for one repo entry with builds. */
export function filesLabel(group: EntryGroup): string | null {
  if (group.entries.length > 1) return `${group.entries.length} files`;
  const variants = group.primary.variants?.length ?? 0;
  return variants > 1 ? `${variants} versions` : null;
}

// ---------------------------------------------------------------- installed files

export interface InstalledSource {
  /** The Hugging Face model page, when one is known. */
  url: string | null;
  /**
   * How it was found. `install`: rippel installed this file from that repo, so
   * the match is exact. `filename`: the API matched the basename against the
   * catalogue, which is a good guess and no more. Null: nothing is known.
   */
  how: 'install' | 'filename' | null;
}

/**
 * Where an installed file came from. The models table keeps no source for a
 * file found on disk (`source_ref` is empty for every row), but an install
 * made through rippel keeps the download URL, and a Hugging Face URL names
 * the repo. Failing that, the catalogue match by filename the API already
 * makes for the Installed tab's pictures.
 */
export function installedSource(
  model: Pick<Model, 'filename' | 'backendIds'>,
  info: { referenceUrl: string | null } | null,
  installs: readonly Pick<ModelInstall, 'filename' | 'backendId' | 'status' | 'url'>[] = [],
): InstalledSource {
  const file = basename(model.filename).toLowerCase();
  const install = installs.find(
    (candidate) =>
      candidate.status === 'complete' &&
      model.backendIds.includes(candidate.backendId) &&
      basename(candidate.filename).toLowerCase() === file,
  );
  const repo = install ? HF_REPO.exec(install.url) : null;
  if (repo) return { url: `https://huggingface.co/${repo[1]}/${repo[2]}`, how: 'install' };
  if (info?.referenceUrl) return { url: info.referenceUrl, how: 'filename' };
  return { url: null, how: null };
}
