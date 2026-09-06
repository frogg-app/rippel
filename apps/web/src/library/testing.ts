/**
 * A scriptable stand-in for `LibraryApi`, for the tests.
 *
 * Distinct from `mock.ts`: that one is a plausible library you can browse in a
 * dev server, this one is a lever the tests pull — it holds an ordered list of
 * rows, pages it with a real cursor, and can be made to fail a specific call.
 */
import type {
  Collection,
  LibraryApi,
  LibraryAsset,
  LibraryJob,
  LibraryPage,
  LibraryPageRequest,
} from '../lib/api-library';

export function asset(overrides: Partial<LibraryAsset> & { id: string }): LibraryAsset {
  return {
    jobId: `job-${overrides.id}`,
    kind: 'image',
    url: `/api/assets/${overrides.id}`,
    thumbUrl: `/api/assets/${overrides.id}/thumb`,
    width: 1024,
    height: 1024,
    duration: null,
    starred: false,
    createdAt: '2026-09-06T12:00:00.000Z',
    prompt: `prompt ${overrides.id}`,
    modelName: 'SDXL 1.0 base',
    collectionIds: [],
    ...overrides,
  };
}

export function assets(count: number, startAt = 0): LibraryAsset[] {
  return Array.from({ length: count }, (_, index) =>
    asset({
      id: `a${startAt + index}`,
      // Descending, so the list is in real feed order (newest first).
      createdAt: new Date(Date.UTC(2026, 8, 6, 12) - (startAt + index) * 60_000).toISOString(),
    }),
  );
}

export interface FakeLibrary extends LibraryApi {
  /** The server's rows, newest first. Mutate to simulate the world changing. */
  rows: LibraryAsset[];
  /** Every list request the hook made, in order. */
  requests: LibraryPageRequest[];
  /** Set to make the next call of that kind reject once. */
  failNext: Partial<Record<'setStarred' | 'remove' | 'restore', boolean>>;
  /** Deleted ids, so a test can assert the server was actually told. */
  deleted: Set<string>;
}

export function fakeLibrary(initial: LibraryAsset[], collections: Collection[] = []): FakeLibrary {
  const api: FakeLibrary = {
    rows: [...initial],
    requests: [],
    failNext: {},
    deleted: new Set(),

    assets: {
      list(request: LibraryPageRequest): Promise<LibraryPage> {
        api.requests.push({ ...request });
        const limit = request.limit ?? 40;
        const live = api.rows.filter((row) => !api.deleted.has(row.id));
        // The cursor names a row, so an insertion above it cannot move it —
        // this is the behaviour the real endpoint promises and the reason the
        // hook can be trusted not to duplicate or skip.
        const start = request.cursor
          ? live.findIndex((row) => row.id === request.cursor) + 1
          : 0;
        const window = live.slice(start, start + limit);
        const last = window.at(-1);
        const exhausted = !last || live.indexOf(last) === live.length - 1;
        return Promise.resolve({
          items: window.map((row) => ({ ...row })),
          nextCursor: exhausted ? null : (last?.id ?? null),
        });
      },

      get(id) {
        const row = api.rows.find((candidate) => candidate.id === id);
        if (!row) return Promise.reject(new Error('not found'));
        const job: LibraryJob = {
          id: row.jobId,
          kind: 'txt2img',
          status: 'complete',
          params: {
            kind: 'txt2img',
            prompt: row.prompt ?? '',
            modelId: 'm1',
            quality: 'balanced',
            aspect: '1:1',
            batchSize: 1,
            advanced: { steps: 30, guidance: 4.5, sampler: 'dpmpp_2m', seed: 42 },
          },
          modelName: row.modelName,
          loraNames: [],
          seed: 42,
          backendName: 'desktop-4090',
          durationMs: 19_400,
          createdAt: row.createdAt,
        };
        return Promise.resolve({ asset: { ...row }, job });
      },

      setStarred(id, starred) {
        if (api.failNext.setStarred) {
          api.failNext.setStarred = false;
          return Promise.reject(new Error('nope'));
        }
        const row = api.rows.find((candidate) => candidate.id === id);
        if (row) row.starred = starred;
        return Promise.resolve({ asset: { ...(row ?? asset({ id })), starred } });
      },

      remove(id) {
        if (api.failNext.remove) {
          api.failNext.remove = false;
          return Promise.reject(new Error('nope'));
        }
        api.deleted.add(id);
        return Promise.resolve();
      },

      restore(id) {
        if (api.failNext.restore) {
          api.failNext.restore = false;
          return Promise.reject(new Error('nope'));
        }
        api.deleted.delete(id);
        const row = api.rows.find((candidate) => candidate.id === id);
        return Promise.resolve({ asset: { ...(row ?? asset({ id })) } });
      },
    },

    collections: {
      list: () => Promise.resolve({ collections: [...collections] }),
      create: (name) =>
        Promise.resolve({
          collection: { id: `c${collections.length + 1}`, name, assetCount: 0, createdAt: '' },
        }),
      add: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  };

  return api;
}
