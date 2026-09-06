/**
 * Pure helpers over the two model vocabularies.
 *
 * They are pure and they are here rather than inline in the components because
 * every one of them encodes something the API taught us that is easy to get
 * subtly wrong: how a family name is spelled on each side, that a filename can
 * carry a Windows subfolder, and that 372 catalogue entries must be narrowed
 * before they are rendered.
 */
import type {
  Model,
  ModelCatalogEntry,
  ModelInstall,
  ModelRunnability,
  ModelType,
  RunnabilityStatus,
} from '@comfy/shared';

/** Every type the API can hand back, in the order the design lists them. */
export const MODEL_TYPES: ModelType[] = [
  'checkpoint',
  'lora',
  'vae',
  'controlnet',
  'upscaler',
  'clip',
  'video',
];

export const TYPE_LABELS: Record<ModelType, string> = {
  checkpoint: 'Checkpoint',
  lora: 'LoRA',
  vae: 'VAE',
  controlnet: 'ControlNet',
  upscaler: 'Upscaler',
  clip: 'CLIP',
  video: 'Video',
};

/**
 * Fold a family name to a comparable key.
 *
 * `/api/models` returns families already folded ("sdxl", "hunyuan-video") but
 * a catalogue entry spells the same family its own way ("SDXL", "Hunyuan
 * Video"). This is the same fold the API's `normalizeBaseModel` applies, so a
 * chip chosen on one side selects the right rows on the other.
 */
export function foldFamily(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Last path segment, for either separator.
 *
 * A backend may be Windows, and `/api/models` really does return
 * "SDXL\\sd_xl_base_1.0.safetensors". Comparing a catalogue filename against
 * one of those without this returns "not installed" for a file that is.
 */
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Title-cased family, for a chip label built from a folded API family. */
export function familyLabel(family: string): string {
  return family
    .split('-')
    .map((part) => (/^[a-z]/.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

// ---------------------------------------------------------------- installed

export interface InstalledFilters {
  type: ModelType | null;
  /** A folded family key, or null for all. */
  family: string | null;
  q: string;
}

export function filterInstalled(models: Model[], filters: InstalledFilters): Model[] {
  const q = filters.q.trim().toLowerCase();
  return models.filter((model) => {
    if (filters.type && model.type !== filters.type) return false;
    if (filters.family && foldFamily(model.baseModel ?? '') !== filters.family) return false;
    if (
      q &&
      !model.displayName.toLowerCase().includes(q) &&
      !model.filename.toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
}

export interface ModelGroup {
  type: ModelType;
  /** Family label; "Unclassified" for a model the API could not place. */
  family: string;
  key: string;
  models: Model[];
}

/**
 * Group by type, then by family, in `MODEL_TYPES` order.
 *
 * Two levels rather than one because they answer different questions: the type
 * is what slot the file fills, the family is what it is compatible with, and a
 * flat list of both mixed together is the thing an operator has to squint at.
 */
export function groupInstalled(models: Model[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const family = model.baseModel ? familyLabel(model.baseModel) : 'Unclassified';
    const key = `${model.type}::${family}`;
    let group = groups.get(key);
    if (!group) {
      group = { type: model.type, family, key, models: [] };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  return [...groups.values()].sort((a, b) => {
    const byType = MODEL_TYPES.indexOf(a.type) - MODEL_TYPES.indexOf(b.type);
    if (byType !== 0) return byType;
    // "Unclassified" last within a type; it is the least useful heading.
    if (a.family === 'Unclassified') return 1;
    if (b.family === 'Unclassified') return -1;
    return a.family.localeCompare(b.family);
  });
}

// ------------------------------------------------------------- runnability

/**
 * How a verdict reads on a card.
 *
 * Short, because it sits in a badge over a 244px tile, and *specific*, because
 * the whole point is that "Install" no longer means the same thing on every
 * card. The sentence underneath is the API's own — it names the missing file or
 * the folder, and this screen does not paraphrase it.
 */
export const RUNNABILITY_LABEL: Record<RunnabilityStatus, string> = {
  ready: 'Will run',
  generic: 'Generic workflow',
  'needs-companion': 'Needs another model',
  'wrong-folder': 'Wrong folder',
  'no-workflow': 'No workflow',
  support: 'Support file',
  unknown: 'Unchecked',
};

export type RunnabilityTone = 'good' | 'soft' | 'warn' | 'muted';

export const RUNNABILITY_TONE: Record<RunnabilityStatus, RunnabilityTone> = {
  ready: 'good',
  // Deliberately not "good": it runs, but on a graph nobody wrote for it, and
  // colouring that the same green as a verified template would be the lie the
  // `isFallback` flag exists to prevent.
  generic: 'soft',
  'needs-companion': 'warn',
  'wrong-folder': 'warn',
  'no-workflow': 'warn',
  support: 'muted',
  unknown: 'muted',
};

/** Statuses that mean "this generates images today". */
export function runs(status: RunnabilityStatus): boolean {
  return status === 'ready' || status === 'generic';
}

/**
 * The three answers worth filtering on.
 *
 * Not one per status: "show me what works" and "show me what is broken" are the
 * two questions people actually have, and a seven-way status filter would make
 * them hunt for the right word to express either.
 */
export type RunFilter = 'all' | 'runs' | 'blocked';

export const RUN_FILTER_LABELS: Record<RunFilter, string> = {
  all: 'Everything',
  runs: 'Will run here',
  blocked: 'Needs work first',
};

export function matchesRunFilter(
  runnability: ModelRunnability | null,
  filter: RunFilter,
): boolean {
  if (filter === 'all') return true;
  // No verdict means the API could not say. Neither answer is honest, so an
  // unjudged entry stays out of both narrowed lists rather than being counted
  // as working.
  if (!runnability) return false;
  if (filter === 'runs') return runs(runnability.status);
  // "Needs work" excludes support files: a VAE is not broken, it is a VAE.
  return !runs(runnability.status) && runnability.status !== 'support';
}

/** "1.8M", "8.1k", "412". A download count, in the width a card has for it. */
export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

// ---------------------------------------------------------------- catalogue

export interface CatalogueFilters {
  type: ModelType | null;
  /** The catalogue's own spelling of a family, or null. */
  base: string | null;
  q: string;
  /** "Show me what will actually work" — the query people came here with. */
  run: RunFilter;
}

export const EMPTY_CATALOGUE_FILTERS: CatalogueFilters = {
  type: null,
  base: null,
  q: '',
  run: 'all',
};

export function hasCatalogueFilter(filters: CatalogueFilters): boolean {
  return Boolean(filters.type || filters.base || filters.q.trim() || filters.run !== 'all');
}

/**
 * Narrow the catalogue.
 *
 * Text matches name, filename and description — the description is where a
 * catalogue hides the words an operator actually searches for ("inpainting",
 * "fp8"), and leaving it out makes the search feel broken.
 */
export function filterCatalogue(
  entries: ModelCatalogEntry[],
  filters: CatalogueFilters,
): ModelCatalogEntry[] {
  const q = filters.q.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filters.type && entry.type !== filters.type) return false;
    if (filters.base && entry.base !== filters.base) return false;
    if (!matchesRunFilter(entry.runnability, filters.run)) return false;
    if (!q) return true;
    return (
      entry.name.toLowerCase().includes(q) ||
      entry.filename.toLowerCase().includes(q) ||
      (entry.description?.toLowerCase().includes(q) ?? false)
    );
  });
}

/** The type chips actually worth offering, with their counts. */
export function catalogueTypes(entries: ModelCatalogEntry[]): { type: ModelType; count: number }[] {
  const counts = new Map<ModelType, number>();
  for (const entry of entries) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
  return MODEL_TYPES.filter((type) => counts.has(type)).map((type) => ({
    type,
    count: counts.get(type)!,
  }));
}

/** The families this backend's catalogue offers, alphabetical. */
export function catalogueBases(entries: ModelCatalogEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.base))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}

// ---------------------------------------------------------------- installs

export const LIVE_STATUSES = ['queued', 'downloading'] as const;

export function isLive(install: ModelInstall): boolean {
  return install.status === 'queued' || install.status === 'downloading';
}

/**
 * The most recent install per file, so a catalogue card can show what happened
 * to it — running, finished, or failed with the transport's error.
 *
 * Keyed on the basename because a `ModelInstall` carries no catalogue ref (the
 * API stores the resolved filename) and a filename may carry a subfolder. The
 * *latest* rather than the live one: a card whose install has just completed
 * must keep saying so, since the catalogue's own `installed` flag can lag a
 * completion by a poll and the card would otherwise flick back to offering an
 * install the API would refuse.
 *
 * `installs` is expected newest-first, as `useInstalls` returns it.
 */
export function latestByFilename(installs: ModelInstall[]): Map<string, ModelInstall> {
  const index = new Map<string, ModelInstall>();
  for (const install of installs) {
    const key = basename(install.filename);
    if (!index.has(key)) index.set(key, install);
  }
  return index;
}

/**
 * A deterministic hue for a model, used for its card's art.
 *
 * The artboard gives every card a photographic preview, and about half of them
 * now have one: the API resolves each entry's model page and caches a sample
 * image from the author's own repo (`info.previewUrl`). The other half never
 * will — a T5 encoder's repo contains weights and nothing else — so this is the
 * floor: a gradient derived from the family. Same family, same colour, which
 * keeps the grid scannable and never pretends to be a picture of the model.
 * It is also what a preview that fails to load falls back to.
 */
export function familyHue(base: string): number {
  let hash = 0;
  for (let index = 0; index < base.length; index += 1) {
    hash = (hash * 31 + base.charCodeAt(index)) % 360_000;
  }
  return hash % 360;
}

/** Elapsed wall-clock, in the terse form the mono numerics use. */
export function elapsed(sinceIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(sinceIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
