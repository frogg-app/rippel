/**
 * An in-memory stand-in for the library endpoints.
 *
 * The routes described at the top of `lib/api-library.ts` are being written in
 * parallel with this screen. Rather than build against nothing, the whole
 * feature runs on this fixture in dev: real cursor paging, real filtering, real
 * failures, so infinite scroll, optimistic star and delete/undo are exercised
 * now instead of on the day the server catches up.
 *
 * It is a *fixture*, not a second implementation of the product. It implements
 * `LibraryApi` and nothing else, so `libraryApi` can be pointed at the real
 * client by flipping one flag (`VITE_LIBRARY_MOCK=0`) with no other change.
 *
 * Two knobs, both from the URL so they need no rebuild:
 *   ?mock=empty   a brand-new install with nothing in it — the state most
 *                 people genuinely see first, and the one easiest to forget
 *   ?mock=140     that many fixture assets (default 64)
 */
import type { GenerationParams, Uuid } from '@comfy/shared';
import type {
  Collection,
  LibraryApi,
  LibraryAsset,
  LibraryJob,
  LibraryPage,
  LibraryPageRequest,
} from '../lib/api-library';

// ---------------------------------------------------------------- fixtures

const PROMPTS = [
  'a lone figure on a rain-slick street, neon signage, anamorphic bokeh, shallow depth of field',
  'brutalist concrete cathedral at golden hour, volumetric light through dust',
  'macro photograph of frost forming on a black leaf, studio lighting',
  'an abandoned observatory overgrown with wisteria, matte painting',
  'portrait of a falconer in a wool coat, overcast north light, 85mm',
  'aerial view of salt flats at dawn, long shadows, muted palette',
  'a paper boat on still water, single warm lamp overhead, minimal',
  'cross-section of a mechanical orange, technical illustration, ink and wash',
  'storm front over a wheat field, high contrast black and white',
  'interior of a night train, condensation on glass, cinematic',
  'a glass bead resting on wet slate, caustics, extreme close-up',
  'desert highway vanishing into heat haze, 35mm film grain',
];

const NEGATIVES = ['blurry, watermark, text', 'lowres, jpeg artifacts', ''];
const MODELS = ['FLUX.1 dev', 'SDXL 1.0 base', 'Juggernaut XL v9'];
const SAMPLERS = ['dpmpp_2m', 'euler_ancestral', 'ddim'];
const BACKENDS = ['desktop-4090', 'workshop-7900xtx'];

/** The artboard's tile gradients — the fixture has no real bytes to serve. */
const GRADIENTS: Array<[string, string, string, string]> = [
  ['120% 100% at 25% 15%', '#ff7a3d', '#b5245a', '#1c0f2e'],
  ['100% 100% at 70% 20%', '#7fd1ff', '#2a5fa8', '#0b1526'],
  ['110% 100% at 30% 80%', '#d8ff7a', '#2f8f5b', '#08201a'],
  ['100% 90% at 60% 30%', '#ffd9a0', '#a05c2a', '#2a1408'],
  ['120% 100% at 40% 20%', '#cbb2ff', '#5b3fa8', '#140d26'],
  ['110% 100% at 70% 70%', '#7affd0', '#1d6f6a', '#06181c'],
  ['100% 100% at 30% 30%', '#ff9fb8', '#8e2f5f', '#200c1c'],
  ['120% 90% at 50% 80%', '#ffe9a8', '#6d5620', '#16120a'],
  ['110% 100% at 20% 40%', '#a8c6ff', '#37478f', '#0c0f22'],
  ['120% 100% at 70% 30%', '#ffb37a', '#7a3a1e', '#1a0d06'],
];

/**
 * A gradient as an SVG data URL, so the fixture's tiles are real `<img>` loads
 * and the grid's loading, sizing and object-fit behaviour is genuinely
 * exercised rather than faked with a CSS background.
 */
function gradientUrl(index: number, width: number, height: number): string {
  const stops = GRADIENTS[index % GRADIENTS.length]!;
  const [, a, b, c] = stops;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><radialGradient id="g" cx="35%" cy="25%" r="95%">` +
    `<stop offset="0%" stop-color="${a}"/><stop offset="45%" stop-color="${b}"/>` +
    `<stop offset="100%" stop-color="${c}"/></radialGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SIZES: Array<[number, number]> = [
  [1024, 1024],
  [1344, 768],
  [768, 1344],
  [1536, 864],
];

interface MockRow {
  asset: LibraryAsset;
  job: LibraryJob;
  deleted: boolean;
}

function urlParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

function fixtureCount(): number {
  const raw = urlParam('mock');
  if (raw === null) return 64;
  if (raw === 'empty') return 0;
  // `Number(null)` is 0, not NaN — testing the string for absence first is the
  // difference between the default fixture and a permanently empty library.
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 500) : 64;
}

function makeRow(index: number): MockRow {
  const id = `a${String(index).padStart(4, '0')}0000-0000-4000-8000-000000000000`;
  const jobId = `j${String(index).padStart(4, '0')}0000-0000-4000-8000-000000000000`;
  const prompt = PROMPTS[index % PROMPTS.length]!;
  const [width, height] = SIZES[index % SIZES.length]!;
  const isVideo = index % 9 === 4;
  // Spread across the last three weeks so the day headings have something to
  // group, with the newest first.
  const createdAt = new Date(Date.now() - index * 5.4e6).toISOString();
  const modelName = MODELS[index % MODELS.length]!;

  const params: GenerationParams = {
    kind: isVideo ? 'img2vid' : 'txt2img',
    prompt,
    negativePrompt: NEGATIVES[index % NEGATIVES.length] || undefined,
    modelId: `m${index % MODELS.length}`,
    quality: (['fast', 'balanced', 'high'] as const)[index % 3]!,
    aspect: width === height ? '1:1' : width > height ? '16:9' : '9:16',
    batchSize: 1,
    loras: index % 4 === 0 ? [{ modelId: 'lora-film-grain', weight: 0.7 }] : undefined,
    advanced: {
      steps: 20 + (index % 4) * 5,
      guidance: 3.5 + (index % 5) * 0.5,
      sampler: SAMPLERS[index % SAMPLERS.length]!,
      scheduler: 'karras',
      seed: 874203551 + index * 7919,
      seedLocked: false,
    },
  };

  return {
    deleted: false,
    asset: {
      id,
      jobId,
      kind: isVideo ? 'video' : 'image',
      url: gradientUrl(index, width, height),
      thumbUrl: gradientUrl(index, Math.round(width / 3), Math.round(height / 3)),
      width,
      height,
      duration: isVideo ? 4 : null,
      starred: index % 7 === 1,
      createdAt,
      prompt,
      modelName,
      collectionIds: index % 5 === 0 ? ['c1'] : [],
    },
    job: {
      id: jobId,
      kind: params.kind,
      status: 'complete',
      params,
      modelName,
      loraNames: params.loras ? ['film-grain'] : [],
      seed: params.advanced?.seed ?? null,
      backendName: BACKENDS[index % BACKENDS.length]!,
      durationMs: 11_000 + index * 431,
      createdAt,
    },
  };
}

// ---------------------------------------------------------------- store

const rows: MockRow[] = Array.from({ length: fixtureCount() }, (_, i) => makeRow(i));

const collections: Collection[] = rows.length
  ? [
      { id: 'c1', name: 'Keepers', assetCount: rows.filter((r) => r.asset.collectionIds.includes('c1')).length, createdAt: new Date().toISOString() },
      { id: 'c2', name: 'Reference', assetCount: 0, createdAt: new Date().toISOString() },
    ]
  : [];

/** Enough latency to see a skeleton, little enough to not be annoying. */
function latency<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function matches(row: MockRow, filters: LibraryPageRequest): boolean {
  if (row.deleted) return false;
  if (filters.kind && row.asset.kind !== filters.kind) return false;
  if (filters.starred && !row.asset.starred) return false;
  if (filters.collectionId && !row.asset.collectionIds.includes(filters.collectionId)) return false;
  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const haystack = `${row.job.params.prompt} ${row.job.params.negativePrompt ?? ''}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/**
 * The cursor is the id of the last row returned. The real API will encode
 * `(created_at, id)` into something opaque; what matters for the client — and
 * the whole reason paging is not `?offset=` — is that it names a *row*, so an
 * insertion at the head of the feed cannot shift it.
 */
function afterCursor(matching: MockRow[], cursor: string | null | undefined): MockRow[] {
  if (!cursor) return matching;
  const index = matching.findIndex((row) => row.asset.id === cursor);
  return index === -1 ? [] : matching.slice(index + 1);
}

function findRow(id: Uuid): MockRow {
  const row = rows.find((candidate) => candidate.asset.id === id);
  if (!row) throw new Error(`mock library: no asset ${id}`);
  return row;
}

export const mockLibrary: LibraryApi = {
  assets: {
    list(request: LibraryPageRequest): Promise<LibraryPage> {
      const limit = request.limit ?? 40;
      const matching = rows.filter((row) => matches(row, request));
      const window = afterCursor(matching, request.cursor).slice(0, limit);
      const last = window.at(-1);
      const exhausted = !last || matching.indexOf(last) === matching.length - 1;
      return latency({
        items: window.map((row) => ({ ...row.asset })),
        nextCursor: exhausted ? null : (last?.asset.id ?? null),
      });
    },

    get(id) {
      const row = findRow(id);
      return latency({ asset: { ...row.asset }, job: { ...row.job } }, 120);
    },

    setStarred(id, starred) {
      const row = findRow(id);
      // One tile in ten refuses, so the optimistic update's revert path is
      // something you can see rather than something only a test exercises.
      if (row.asset.id.charCodeAt(5) % 10 === 3) {
        return latency(null, 300).then(() => {
          throw new Error('mock library: starring failed');
        });
      }
      row.asset = { ...row.asset, starred };
      return latency({ asset: { ...row.asset } }, 260);
    },

    remove(id) {
      findRow(id).deleted = true;
      return latency(undefined, 180);
    },

    restore(id) {
      const row = findRow(id);
      row.deleted = false;
      return latency({ asset: { ...row.asset } }, 180);
    },
  },

  collections: {
    list: () => latency({ collections: collections.map((c) => ({ ...c })) }, 140),

    create(name) {
      const collection: Collection = {
        id: `c${collections.length + 1}-${Date.now()}`,
        name,
        assetCount: 0,
        createdAt: new Date().toISOString(),
      };
      collections.push(collection);
      return latency({ collection: { ...collection } }, 160);
    },

    add(collectionId, assetId) {
      const row = findRow(assetId);
      if (!row.asset.collectionIds.includes(collectionId)) {
        row.asset = { ...row.asset, collectionIds: [...row.asset.collectionIds, collectionId] };
        const collection = collections.find((c) => c.id === collectionId);
        if (collection) collection.assetCount += 1;
      }
      return latency(undefined, 160);
    },

    remove(collectionId, assetId) {
      const row = findRow(assetId);
      if (row.asset.collectionIds.includes(collectionId)) {
        row.asset = {
          ...row.asset,
          collectionIds: row.asset.collectionIds.filter((id) => id !== collectionId),
        };
        const collection = collections.find((c) => c.id === collectionId);
        if (collection) collection.assetCount = Math.max(0, collection.assetCount - 1);
      }
      return latency(undefined, 160);
    },
  },
};
