/**
 * The Discover tab's tag vocabulary: what a tag *is* on this side, how a typed
 * search turns into tags, how the facet counts are taken, and how all of it
 * round-trips through the query string.
 *
 * Pure, and separate from catalogue.ts, because it is the part of the screen
 * with a grammar. `-tag:anime`, `licence:mit` and a half-typed `base:fl` all
 * have to mean one thing everywhere — in the search box, in the autocomplete,
 * in the URL a person pastes to somebody else — and that is far easier to pin
 * down in a function with tests than in three components that each parse it.
 *
 * ## What a tag is here
 *
 * A **key**: `group:value`, lower-cased — `task:text-to-image`, `base:sdxl`,
 * `tag:photorealistic`. The groups are the API's (`ModelTagGroup`), sorted
 * server-side out of HuggingFace's flat `tags[]`. One addition is made on this
 * side: the catalogue's own family (`entry.base`, "SDXL") is put at the front
 * of the `base` group. Every entry has one, including the half of the catalogue
 * whose model page says nothing, so the base facet is never emptier than the
 * family dropdown it replaced.
 *
 * Tags within the include list are ANDed, excludes are NOT-any. That is what a
 * person stacking chips means ("text-to-image *and* sdxl"), and it is what
 * makes a facet count honest: the number beside a row is how many cards adding
 * it would leave.
 */
import type { ModelCatalogEntry, ModelTagGroup, ModelTags, ModelType } from '@comfy/shared';
import { DEFAULT_INTENT, INTENTS, isPart, matchesIntent, statusRank, worksHere, type Intent } from './intents';
import { isRecommendedHere } from './recommended';

/**
 * The types a `type=` parameter may name. catalogue.ts has the same list as
 * `MODEL_TYPES`; it is repeated rather than imported because catalogue.ts
 * imports this module for its filter, and the cycle is not worth one array.
 */
const TYPES: readonly ModelType[] = ['checkpoint', 'lora', 'vae', 'controlnet', 'upscaler', 'clip', 'video'];

/** `group:value`, lower-cased. */
export type TagKey = string;

/** The order the drawer lists a model's tags in, after HuggingFace's own page. */
export const DRAWER_TAG_ORDER: readonly ModelTagGroup[] = [
  'task',
  'library',
  'format',
  'language',
  'base',
  'tag',
  'license',
];

/** The facet rail's order: the questions people ask first, first. */
export const RAIL_TAG_ORDER: readonly ModelTagGroup[] = [
  'task',
  'version',
  'base',
  'tag',
  'license',
  'format',
  'language',
  'library',
];

/**
 * The groups the rail shows open. The rest — and the type facet — sit under
 * "More filters": "safetensors" and "diffusers" are answers to questions only
 * somebody who already knows ComfyUI asks.
 */
export const RAIL_OPEN_GROUPS: readonly ModelTagGroup[] = ['task', 'version', 'base', 'tag'];
export const RAIL_MORE_GROUPS: readonly ModelTagGroup[] = RAIL_TAG_ORDER.filter(
  (group) => !RAIL_OPEN_GROUPS.includes(group),
);

export const TAG_GROUP_LABEL: Record<ModelTagGroup, string> = {
  task: 'Task',
  version: 'Version',
  base: 'Model family',
  library: 'Library',
  format: 'Format',
  language: 'Language',
  license: 'Licence',
  tag: 'Tags',
};

/**
 * One glyph per group, from the mockup. Text rather than SVG because they are
 * typographic marks at chip size, and every one is `aria-hidden` beside the
 * value it decorates.
 */
export const TAG_GROUP_ICON: Record<ModelTagGroup, string> = {
  task: '◧',
  version: '◑',
  base: '△',
  library: '⬡',
  format: '◈',
  language: '◍',
  license: '⚖',
  tag: '#',
};

/**
 * What a person may type before the colon. The British spelling is accepted
 * because it is the one this interface prints; the short forms because nobody
 * types `language:` twice.
 */
const PREFIXES: Record<string, ModelTagGroup> = {
  task: 'task',
  base: 'base',
  license: 'license',
  licence: 'license',
  tag: 'tag',
  library: 'library',
  lib: 'library',
  format: 'format',
  language: 'language',
  lang: 'language',
};

export function tagKey(group: ModelTagGroup, value: string): TagKey {
  return `${group}:${value.trim().toLowerCase()}`;
}

export function splitKey(key: TagKey): { group: ModelTagGroup; value: string } {
  const cut = key.indexOf(':');
  return { group: key.slice(0, cut) as ModelTagGroup, value: key.slice(cut + 1) };
}

function emptyTags(): ModelTags {
  return { task: [], version: [], base: [], library: [], format: [], language: [], license: [], tag: [] };
}

/**
 * An entry's tags, with the catalogue's family folded into `base`.
 *
 * `info.tags` is absent on a response from an API older than tags, and `info`
 * itself is null until the metadata sweep reaches the entry; both read as "no
 * tags yet" rather than as an error.
 */
export function entryTags(entry: ModelCatalogEntry): ModelTags {
  const source = entry.info?.tags ?? emptyTags();
  const tags = emptyTags();
  for (const group of Object.keys(tags) as ModelTagGroup[]) tags[group] = [...(source[group] ?? [])];
  const family = entry.base.trim().toLowerCase();
  if (family) tags.base = [family, ...tags.base.filter((value) => value !== family)];
  tags.version = versionTags(entry);
  return tags;
}

/**
 * Which kinds of build a model comes in, from its installable versions: the
 * Version filter. Only for entries that can be installed, so the filter never
 * offers something that then cannot be had.
 */
export function versionTags(entry: ModelCatalogEntry): string[] {
  const variants = entry.installBlockedReason ? [] : entry.variants ?? [];
  const out: string[] = [];
  if (variants.some((variant) => variant.kind === 'full' && !variant.distilled)) out.push('full');
  if (variants.some((variant) => variant.distilled)) out.push('distilled');
  if (variants.some((variant) => variant.kind === 'fp8')) out.push('smaller (fp8)');
  if (variants.some((variant) => variant.kind === 'gguf')) out.push('gguf');
  return out;
}

/** Every key an entry carries. */
export function entryKeys(entry: ModelCatalogEntry): Set<TagKey> {
  const tags = entryTags(entry);
  const keys = new Set<TagKey>();
  for (const group of Object.keys(tags) as ModelTagGroup[]) {
    for (const value of tags[group]) keys.add(tagKey(group, value));
  }
  return keys;
}

/**
 * The chips a card has room for: task, then base, then free tags, at most
 * `limit` of them, plus how many more the drawer holds. Library, format,
 * language and licence are drawer-only — on a card they are the same four
 * words on every tile and push the useful ones off the row.
 */
export function cardTags(
  entry: ModelCatalogEntry,
  limit = 5,
): { shown: { group: ModelTagGroup; value: string }[]; more: number } {
  const tags = entryTags(entry);
  const ordered = (['task', 'base', 'tag'] as const).flatMap((group) =>
    tags[group].map((value) => ({ group, value })),
  );
  const total = DRAWER_TAG_ORDER.reduce((sum, group) => sum + tags[group].length, 0);
  const shown = ordered.slice(0, limit);
  return { shown, more: total - shown.length };
}

// ---------------------------------------------------------------- the parser

export interface ParsedToken {
  key: TagKey;
  negate: boolean;
}

/**
 * One word of the search box, as a tag — or null when it is just text.
 *
 *   task:text-to-image   include that task
 *   -license:mit         exclude that licence
 *   -anime               exclude whichever group "anime" is in; `resolve`
 *                        answers that from the catalogue's own vocabulary, and
 *                        a word it has never seen is taken as a free tag
 *   anime                text: a bare word is a name search, never a tag,
 *                        or typing "flux" would silently become a filter
 *
 * An unknown prefix (`fp8:`) is text too, rather than an error: it might be
 * part of a filename.
 */
export function parseToken(
  word: string,
  resolve: (value: string) => ModelTagGroup | null = () => null,
): ParsedToken | null {
  let rest = word.trim();
  const negate = rest.startsWith('-');
  if (negate) rest = rest.slice(1);
  if (!rest) return null;

  const cut = rest.indexOf(':');
  if (cut > 0) {
    const group = PREFIXES[rest.slice(0, cut).toLowerCase()];
    const value = rest.slice(cut + 1);
    if (!group || !value) return null;
    return { key: tagKey(group, value), negate };
  }
  if (!negate) return null;
  return { key: tagKey(resolve(rest.toLowerCase()) ?? 'tag', rest), negate: true };
}

export interface ParsedSearch {
  include: TagKey[];
  exclude: TagKey[];
  /** Whatever was not a tag, single-spaced. The live name search. */
  text: string;
}

/** A whole line of the search box. See `parseToken` for the grammar. */
export function parseSearch(
  input: string,
  resolve?: (value: string) => ModelTagGroup | null,
): ParsedSearch {
  const include: TagKey[] = [];
  const exclude: TagKey[] = [];
  const text: string[] = [];
  for (const word of input.split(/\s+/)) {
    if (!word) continue;
    const token = parseToken(word, resolve);
    if (!token) {
      // A bare "-" or a half-typed "task:" is neither text nor tag yet.
      if (word !== '-' && !/^-?[a-z]+:$/i.test(word)) text.push(word);
      continue;
    }
    const list = token.negate ? exclude : include;
    if (!list.includes(token.key)) list.push(token.key);
  }
  return { include, exclude, text: text.join(' ') };
}

/**
 * A resolver over the catalogue's vocabulary, for `-word` without a group:
 * the first group (in rail order) that has the word.
 */
export function resolverFor(known: Iterable<TagKey>): (value: string) => ModelTagGroup | null {
  const byValue = new Map<string, ModelTagGroup>();
  const keys = [...known].sort(
    (a, b) => RAIL_TAG_ORDER.indexOf(splitKey(a).group) - RAIL_TAG_ORDER.indexOf(splitKey(b).group),
  );
  for (const key of keys) {
    const { group, value } = splitKey(key);
    if (!byValue.has(value)) byValue.set(value, group);
  }
  return (value) => byValue.get(value) ?? null;
}

// ---------------------------------------------------------------- filtering

export type CatalogueSort = 'best' | 'downloads' | 'likes' | 'name';

export const SORT_LABELS: Record<CatalogueSort, string> = {
  best: 'Best first',
  downloads: 'Downloads',
  likes: 'Likes',
  name: 'Name',
};

/**
 * Does an entry carry every included key and none of the excluded ones?
 * The text half of the search lives in `filterCatalogue`.
 */
export function matchesTags(
  keys: ReadonlySet<TagKey>,
  include: readonly TagKey[],
  exclude: readonly TagKey[],
): boolean {
  for (const key of include) if (!keys.has(key)) return false;
  for (const key of exclude) if (keys.has(key)) return false;
  return true;
}

/**
 * How many of `matching` carry each key.
 *
 * Taken over the entries that pass *every* filter, tags included. With AND
 * semantics that is exactly "how many cards adding this tag would leave" — the
 * same rule as the type chips — and an already-included key reads as the
 * current total, which is what it should say.
 */
export function tagFacets(matching: readonly ModelCatalogEntry[]): Map<TagKey, number> {
  const counts = new Map<TagKey, number>();
  for (const entry of matching) {
    for (const key of entryKeys(entry)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Every key in the catalogue, for the autocomplete and the `-word` resolver. */
export function vocabulary(entries: readonly ModelCatalogEntry[]): Set<TagKey> {
  const keys = new Set<TagKey>();
  for (const entry of entries) for (const key of entryKeys(entry)) keys.add(key);
  return keys;
}

/**
 * One group's rows for the rail: every value with a non-zero count, plus any
 * value that is selected even if nothing has it any more (so it can be
 * unselected), most common first.
 */
export function facetRows(
  group: ModelTagGroup,
  known: Iterable<TagKey>,
  counts: ReadonlyMap<TagKey, number>,
  selected: readonly TagKey[],
): { key: TagKey; value: string; count: number }[] {
  const rows: { key: TagKey; value: string; count: number }[] = [];
  for (const key of known) {
    const split = splitKey(key);
    if (split.group !== group) continue;
    const count = counts.get(key) ?? 0;
    if (count === 0 && !selected.includes(key)) continue;
    rows.push({ key, value: split.value, count });
  }
  return rows.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface TagSuggestion {
  key: TagKey;
  group: ModelTagGroup;
  value: string;
  count: number;
  negate: boolean;
}

/**
 * What the autocomplete offers for the word being typed (the last one).
 *
 * `-` asks for exclusions, a prefix narrows to one group, and the rest is a
 * substring of the value. Nothing is offered for an empty word: a dropdown of
 * the seven most common tags on every focus is in the way.
 */
export function suggestTags(
  word: string,
  known: Iterable<TagKey>,
  counts: ReadonlyMap<TagKey, number>,
  active: readonly TagKey[],
  limit = 7,
): TagSuggestion[] {
  let rest = word.trim().toLowerCase();
  const negate = rest.startsWith('-');
  if (negate) rest = rest.slice(1);
  let group: ModelTagGroup | null = null;
  const cut = rest.indexOf(':');
  if (cut > 0) {
    group = PREFIXES[rest.slice(0, cut)] ?? null;
    if (!group) return [];
    rest = rest.slice(cut + 1);
  }
  if (!rest && !group) return [];

  const found: TagSuggestion[] = [];
  for (const key of known) {
    if (active.includes(key)) continue;
    const split = splitKey(key);
    if (group && split.group !== group) continue;
    if (!split.value.includes(rest)) continue;
    found.push({ key, ...split, count: counts.get(key) ?? 0, negate });
  }
  return found
    .sort(
      (a, b) =>
        // A value that starts with what was typed beats one that merely
        // contains it; then the more common one; then the alphabet.
        Number(!b.value.startsWith(rest)) - Number(!a.value.startsWith(rest)) ||
        b.count - a.count ||
        a.value.localeCompare(b.value),
    )
    .slice(0, limit);
}

/**
 * Order the filtered catalogue.
 *
 * An entry the metadata sweep has not reached has no counts; it sorts after
 * every entry that does rather than being treated as zero, which would put it
 * among the genuinely unpopular ones and look like a judgement.
 */
export function sortCatalogue(
  entries: readonly ModelCatalogEntry[],
  sort: CatalogueSort,
): ModelCatalogEntry[] {
  const copy = [...entries];
  if (sort === 'best') return copy.sort(compareBest);
  if (sort === 'name') {
    return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  const metric = (entry: ModelCatalogEntry) =>
    (sort === 'likes' ? entry.info?.likes : entry.info?.downloads) ?? -1;
  return copy.sort((a, b) => metric(b) - metric(a));
}

const popularity = (entry: ModelCatalogEntry) => entry.info?.downloads ?? -1;

/**
 * The default order: what you can install and run, first.
 *
 *   1. recommended and working here (see recommended.ts)
 *   2. installable before install-blocked — a card whose only action is "you
 *      can't" belongs below every card that has a button
 *   3. will run > should run > needs one more file > the rest
 *   4. downloads, as the tiebreak the other sorts already use
 */
export function compareBest(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  return (
    Number(isRecommendedHere(b)) - Number(isRecommendedHere(a)) ||
    Number(Boolean(a.installBlockedReason)) - Number(Boolean(b.installBlockedReason)) ||
    statusRank(a) - statusRank(b) ||
    popularity(b) - popularity(a)
  );
}

/**
 * The scope the intent chips, Works on this machine and the expert type
 * filter put on the catalogue, before tags and search.
 *
 * Parts (decoders, prompt readers, video parts) are left out unless the type
 * filter names one: nobody browses for a VAE, they find out a model needs one,
 * and the model's card says so ("Needs: …").
 */
export function inScope(
  entry: ModelCatalogEntry,
  scope: { intent: Intent; type: ModelType | null; runs: boolean },
): boolean {
  if (scope.type ? entry.type !== scope.type : isPart(entry.type)) return false;
  if (!matchesIntent(entry, scope.intent)) return false;
  if (scope.runs && !worksHere(entry)) return false;
  return true;
}

// ---------------------------------------------------------------- the URL

/**
 * Discover's filter state, as the query string carries it alongside `tab`:
 *
 *   ?tab=discover&intent=video&tag=task:text-to-image&tag=-license:other
 *     &q=flux&type=vae&sort=likes&runs=0
 *
 * Every default is expressed by absence, so a plain `?tab=discover` is the
 * screen exactly as it opens: Make images, Works on this machine, best first,
 * no type. Works on this machine is on by default, so it is the *off* state
 * that is written (`runs=0`). The older `type=all` and `runs=1` still read,
 * as the defaults they now are, so a link from before the intents still opens.
 */
export interface DiscoverState {
  include: TagKey[];
  exclude: TagKey[];
  /** The live text of the search box, tags not yet committed included. */
  q: string;
  /** The chip row: what the person wants to make. */
  intent: Intent;
  /** The expert type filter, under More filters. Null is every type but parts. */
  type: ModelType | null;
  sort: CatalogueSort;
  /** "Works on this machine". */
  runs: boolean;
}

export const DEFAULT_DISCOVER: DiscoverState = {
  include: [],
  exclude: [],
  q: '',
  intent: DEFAULT_INTENT,
  type: null,
  sort: 'best',
  runs: true,
};

/** The parameters this owns, so a reset clears exactly these and leaves `tab`. */
const DISCOVER_PARAMS = ['tag', 'q', 'intent', 'type', 'sort', 'runs'] as const;

export function readDiscover(params: URLSearchParams): DiscoverState {
  const include: TagKey[] = [];
  const exclude: TagKey[] = [];
  for (const raw of params.getAll('tag')) {
    // Through the same parser as the box, so a hand-edited URL is held to the
    // same grammar — and an unparseable one is ignored rather than trusted.
    const token = parseToken(raw);
    if (!token) continue;
    const list = token.negate ? exclude : include;
    if (!list.includes(token.key)) list.push(token.key);
  }
  const askedType = params.get('type');
  const type = TYPES.includes(askedType as ModelType) ? (askedType as ModelType) : null;
  const askedSort = params.get('sort');
  const sort: CatalogueSort =
    askedSort === 'downloads' || askedSort === 'likes' || askedSort === 'name' ? askedSort : 'best';
  const askedIntent = params.get('intent');
  const intent = INTENTS.includes(askedIntent as Intent) ? (askedIntent as Intent) : DEFAULT_INTENT;
  return { include, exclude, q: params.get('q') ?? '', intent, type, sort, runs: params.get('runs') !== '0' };
}

export function writeDiscover(current: URLSearchParams, state: DiscoverState): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const name of DISCOVER_PARAMS) next.delete(name);
  for (const key of state.include) next.append('tag', key);
  for (const key of state.exclude) next.append('tag', `-${key}`);
  if (state.q) next.set('q', state.q);
  if (state.intent !== DEFAULT_INTENT) next.set('intent', state.intent);
  if (state.type) next.set('type', state.type);
  if (state.sort !== 'best') next.set('sort', state.sort);
  if (!state.runs) next.set('runs', '0');
  return next;
}

/**
 * `owner/` for a card's name, read off the model page. Only HuggingFace has
 * owners in the URL; anything else gets no prefix rather than a wrong one.
 */
export function ownerOf(entry: ModelCatalogEntry): string | null {
  const page = entry.info?.referenceUrl ?? entry.reference;
  const match = page ? /^https?:\/\/huggingface\.co\/([^/\s?#]+)\/[^/\s?#]+/i.exec(page) : null;
  return match ? match[1]! : null;
}
