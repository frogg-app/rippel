/**
 * Pure helpers over the two model vocabularies.
 *
 * They are pure and they are here rather than inline in the components because
 * every one of them encodes something the API taught us that is easy to get
 * subtly wrong: how a family name is spelled on each side, that a filename can
 * carry a Windows subfolder, and that 372 catalogue entries must be narrowed
 * before they are rendered.
 */
import { familyDisplayName } from '../lib/family';
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

// ------------------------------------------------------- generators vs support

/**
 * The one distinction this screen is built around.
 *
 * A checkpoint is a model you *generate with*: it is what the Create screen's
 * picker lists. Everything else — a LoRA, a VAE, a ControlNet, an upscaler, a
 * text encoder — is a file some workflow loads *alongside* a checkpoint. The
 * owner assigned a workflow to a LoRA, went to Create, and could not find it,
 * because there was never anywhere for it to go.
 *
 * This is the same line the API draws in `runnabilityFor` — everything that is
 * not a checkpoint comes back with status `support` — so it is derived from
 * `type` here rather than round-tripped through a verdict that may be absent
 * (an offline backend returns none, and the grouping must not collapse then).
 */
export function generates(type: ModelType): boolean {
  return type === 'checkpoint';
}

export type ModelKind = 'generator' | 'support';

export function kindOf(type: ModelType): ModelKind {
  return generates(type) ? 'generator' : 'support';
}

/** The two headings, and the sentence under each. */
export const KIND_HEADINGS: Record<ModelKind, { title: string; blurb: string }> = {
  generator: {
    title: 'Models you can generate with',
    blurb: 'These are what the Create screen lets you pick.',
  },
  support: {
    title: 'Support files',
    blurb: 'Add-ons a model uses. You cannot generate with one on its own.',
  },
};

/**
 * What a support file is *for*, without the jargon.
 *
 * Two sentences, deliberately: what it does to a model, and where in rippel it
 * gets used. "LoRA" tells somebody who already knows what a LoRA is nothing
 * they did not know, and tells everybody else nothing at all — so the type word
 * is never printed on its own next to one of these.
 */
export interface SupportRole {
  /** A plain-words name for the row, e.g. "Extra style". */
  noun: string;
  /** What it does. */
  what: string;
  /** Where it is used in rippel. */
  where: string;
}

export const SUPPORT_ROLES: Record<ModelType, SupportRole> = {
  checkpoint: {
    noun: 'Model',
    what: 'Generates images or video on its own.',
    where: 'Pick it on the Create screen.',
  },
  lora: {
    noun: 'Extra style',
    what: 'A style or subject you add on top of a model — it cannot generate by itself.',
    where: 'Extra styles, on the Create screen.',
  },
  vae: {
    noun: 'Image decoder',
    what: 'Turns what a model produces into a picture, in place of the decoder built into it.',
    where: 'Loaded automatically by the workflows that ask for one.',
  },
  controlnet: {
    noun: 'Reference guide',
    what: 'Steers a model using a reference image — a pose, an outline, a depth map.',
    where: 'Used by the workflows built around a reference image.',
  },
  upscaler: {
    noun: 'Enlarger',
    what: 'Enlarges a finished picture. It does not make one.',
    where: 'Used by the Upscale workflow.',
  },
  clip: {
    noun: 'Prompt reader',
    what: 'Reads your prompt, for the model families that keep that part in a separate file.',
    where: 'Loaded automatically alongside those models.',
  },
  video: {
    noun: 'Video part',
    what: 'A piece a video workflow loads, rather than a model you pick yourself.',
    where: 'Used by the video workflows.',
  },
};

/** One line for a chip or a card: "Extra style · a style you add on top…". */
export function supportLine(type: ModelType): string {
  const role = SUPPORT_ROLES[type];
  return `${role.noun} · ${role.what}`;
}

/**
 * The kind filter, offered on both tabs.
 *
 * `all` is the default and stays the default: hiding support files by default
 * would trade one confusion for a worse one — somebody looking for a LoRA
 * finding an empty screen.
 */
export type KindFilter = 'all' | ModelKind;

export const KIND_FILTER_LABELS: Record<KindFilter, string> = {
  // "All files", not "Everything": the runnability segments sit directly below
  // with their own "Everything", and two identical words on two rows that mean
  // different things is worse than no filter at all.
  all: 'All files',
  generator: 'Can generate',
  support: 'Support files',
};

export function matchesKind(type: ModelType, filter: KindFilter): boolean {
  return filter === 'all' || kindOf(type) === filter;
}

/**
 * How many of each kind, for the segments.
 *
 * Taken over the unfiltered-by-kind set, so a segment states how many rows it
 * would leave rather than how many it is currently leaving.
 */
export function kindCounts(types: { type: ModelType }[]): Record<KindFilter, number> {
  let generator = 0;
  for (const item of types) if (generates(item.type)) generator += 1;
  return { all: types.length, generator, support: types.length - generator };
}

/**
 * Split anything typed into the two kinds, generators first, dropping an empty
 * half. The order is the claim: what you can generate with comes first because
 * that is what most people are here for, and the support half is not hidden
 * behind a click because sometimes they are here for a LoRA.
 */
export function splitByKind<T>(
  items: T[],
  typeOf: (item: T) => ModelType,
): { kind: ModelKind; items: T[] }[] {
  const generator = items.filter((item) => generates(typeOf(item)));
  const support = items.filter((item) => !generates(typeOf(item)));
  return [
    { kind: 'generator' as const, items: generator },
    { kind: 'support' as const, items: support },
  ].filter((section) => section.items.length > 0);
}

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

/**
 * How a family is spelled for a reader.
 *
 * This used to title-case the folded key word by word, which is where "Sdxl",
 * "Ltx Video" and "Svd" came from. The casing map now lives in
 * `lib/family.ts`, shared with the Create screen's LoRA picker, which had the
 * same fault; this is kept as the name the models screens already import.
 */
export const familyLabel = familyDisplayName;

// ---------------------------------------------------------------- installed

export interface InstalledFilters {
  type: ModelType | null;
  /** A folded family key, or null for all. */
  family: string | null;
  q: string;
  /** Generators, support files, or both. Absent means both. */
  kind?: KindFilter;
}

export function filterInstalled(models: Model[], filters: InstalledFilters): Model[] {
  const q = filters.q.trim().toLowerCase();
  return models.filter((model) => {
    if (!matchesKind(model.type, filters.kind ?? 'all')) return false;
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
/**
 * Group by type alone, for the card grid.
 *
 * The list grouped by type *and* family, which was right for rows: a heading
 * cost one line and the family was the second question anybody asked. It is
 * wrong for cards. Ten models across six families gave six sections of one
 * card each — a column of single tiles with an acre of empty grid beside them —
 * and the family is on the card anyway, under the name. So the section is the
 * type, the grid inside it fills the width, and the family is where it can be
 * read per model rather than as a heading over one of them.
 *
 * `groupInstalled` is kept for the two-level grouping; nothing else uses it
 * now, and it is the shape to come back to if these ever become rows again.
 */
export function groupInstalledByType(models: Model[]): ModelGroup[] {
  const groups = new Map<ModelType, ModelGroup>();
  for (const model of models) {
    let group = groups.get(model.type);
    if (!group) {
      group = { type: model.type, family: '', key: model.type, models: [] };
      groups.set(model.type, group);
    }
    group.models.push(model);
  }
  return [...groups.values()].sort(
    (a, b) => MODEL_TYPES.indexOf(a.type) - MODEL_TYPES.indexOf(b.type),
  );
}

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
  /** Generators, support files, or both. Absent means both. */
  kind?: KindFilter;
}

export const EMPTY_CATALOGUE_FILTERS: CatalogueFilters = {
  type: null,
  base: null,
  q: '',
  run: 'all',
  kind: 'all',
};

export function hasCatalogueFilter(filters: CatalogueFilters): boolean {
  return Boolean(
    filters.type ||
      filters.base ||
      filters.q.trim() ||
      filters.run !== 'all' ||
      (filters.kind ?? 'all') !== 'all',
  );
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
    if (!matchesKind(entry.type, filters.kind ?? 'all')) return false;
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

/**
 * A byte count as a human reads it.
 *
 * Decimal units, not binary, because every number this sits next to is decimal:
 * HuggingFace's `Content-Length` is quoted that way, Manager's catalogue says
 * "6.94GB" for 6,938,078,334 bytes, and the operator comparing the two would
 * be right to be confused if we said "6.46 GiB". Three significant figures is
 * as much precision as means anything at this scale.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  // 9.87 GB, 98.7 MB, 987 kB - three significant figures throughout.
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/**
 * Bytes per second, averaged over the whole download so far.
 *
 * An average rather than an instantaneous rate, and said to be an average
 * wherever it is shown. We sample the file's size every few seconds, so an
 * instantaneous figure would be the difference between two polls divided by the
 * gap between them - a number that swings wildly with poll jitter and tells a
 * watching human nothing. The average is stable, and it is the one that
 * actually predicts when the thing will finish.
 *
 * Null until there is enough to divide: a rate computed over the first second
 * of a download is noise dressed up as information.
 */
export function transferRate(
  bytesReceived: number | null,
  sinceIso: string | null,
  now: number,
): number | null {
  if (bytesReceived === null || bytesReceived <= 0 || !sinceIso) return null;
  const seconds = (now - Date.parse(sinceIso)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 3) return null;
  return bytesReceived / seconds;
}

/**
 * How long the rest is likely to take, in the same terse form as `elapsed`.
 *
 * This is the one number on the screen that is a prediction rather than a
 * measurement, and it is labelled as such where it is rendered. It is honest
 * arithmetic on two measured quantities - bytes still to come, over the rate
 * actually achieved so far - but a download can stall or a CDN can throttle,
 * and it must never be mistaken for a countdown. It drives no bar.
 */
export function remaining(
  bytesReceived: number | null,
  bytesTotal: number | null,
  rateBytesPerSecond: number | null,
): string | null {
  if (bytesReceived === null || bytesTotal === null || !rateBytesPerSecond) return null;
  const left = bytesTotal - bytesReceived;
  if (left <= 0) return null;
  const seconds = Math.round(left / rateBytesPerSecond);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The fraction of the download that has arrived, 0-100, or null.
 *
 * Null is the important return. It means "no percentage exists", and every
 * caller must render that as an absence rather than a zero - a bar sitting at
 * 0% is a claim about the download, and the claim would be false. Both inputs
 * have to be real: `bytesTotal` is only ever an exact Content-Length, so when
 * it is null there is genuinely no denominator and nothing may be shown.
 */
export function percentComplete(
  bytesReceived: number | null,
  bytesTotal: number | null,
): number | null {
  if (bytesReceived === null || bytesTotal === null || bytesTotal <= 0) return null;
  return Math.max(0, Math.min(100, (bytesReceived / bytesTotal) * 100));
}

/** Elapsed wall-clock, in the terse form the mono numerics use. */
export function elapsed(sinceIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(sinceIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
