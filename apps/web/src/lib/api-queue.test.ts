/**
 * The two things about the queue that are expensive to get wrong.
 *
 *  1. The endpoint may not exist. It is being built in parallel with this
 *     screen, and a 404 means "not live yet" — not "something is broken". If
 *     that path throws, every screen carrying the chip goes down with it.
 *  2. Another user's params are withheld by design. If a foreign entry's prompt
 *     is read without checking, the queue panel renders the string "undefined"
 *     where somebody's private prompt would be — which is both a bug and a lie
 *     about what we know.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type QueueEntry,
  type QueueSnapshot,
  entryPrompt,
  isOwnEntry,
  ordinal,
  ownerLabel,
  placeInQueue,
  queueApi,
  resetQueueStore,
} from './api-queue';

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    position: 0,
    ownerName: 'Steve',
    ownerId: 'user-1',
    job: {
      id: 'job-1',
      userId: 'user-1',
      kind: 'txt2img',
      status: 'queued',
      queuePosition: 0,
      backendId: null,
      progress: {
        step: null,
        totalSteps: null,
        frame: null,
        totalFrames: null,
        fraction: 0,
        etaSeconds: null,
        previewUrl: null,
      },
      error: null,
      createdAt: '2026-09-06T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      assets: [],
      params: {
        kind: 'txt2img',
        prompt: 'a rain-slick street',
        modelId: 'model-1',
        quality: 'balanced',
        aspect: '1:1',
        batchSize: 1,
      },
    },
    ...overrides,
  };
}

/**
 * What the server sends for somebody else's job: the row arrives with `params`
 * already null — a projection in the SELECT, not a field deleted afterwards.
 */
function foreign(): QueueEntry {
  const { job } = entry();
  return {
    position: 2,
    ownerName: 'Ada',
    ownerId: 'user-2',
    job: { ...job, id: 'job-2', userId: 'user-2', params: null },
  };
}

function snapshot(entries: QueueEntry[]): QueueSnapshot {
  return { entries, running: null, live: true, loading: false };
}

beforeEach(() => {
  resetQueueStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queueApi.get', () => {
  it('treats a 404 as "not live yet" rather than a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(404, { error: 'Not Found' })));

    const result = await queueApi.get();

    expect(result.live).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.loading).toBe(false);
  });

  it('does not throw when the server errors or is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500, { error: 'boom' })));
    await expect(queueApi.get()).resolves.toMatchObject({ live: false, entries: [] });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(queueApi.get()).resolves.toMatchObject({ live: false, entries: [] });
  });

  it('reads the contract shape, and survives one it does not recognise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(200, { entries: [entry()], running: null })),
    );
    const good = await queueApi.get();
    expect(good.live).toBe(true);
    expect(good.entries).toHaveLength(1);

    // A body missing `entries` must not become `undefined.length` in a render.
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {})));
    const odd = await queueApi.get();
    expect(odd.entries).toEqual([]);
    expect(odd.running).toBeNull();
  });
});

describe('what an entry is allowed to say', () => {
  it('gives back a prompt only when the server sent one', () => {
    expect(entryPrompt(entry())).toBe('a rain-slick street');
    // The whole point: withheld params produce null, never "undefined".
    expect(entryPrompt(foreign())).toBeNull();
  });

  it('treats an empty or blank prompt as nothing to show', () => {
    const blank = entry();
    blank.job.params!.prompt = '   ';
    expect(entryPrompt(blank)).toBeNull();
  });

  it('names the owner without ever needing their params', () => {
    expect(ownerLabel(entry(), 'user-1')).toBe('You');
    expect(ownerLabel(foreign(), 'user-1')).toBe('Ada');
    expect(ownerLabel({ ...foreign(), ownerName: null }, 'user-1')).toBe('Another user');
    // Signed-out, or the user not loaded yet: nothing is "yours".
    expect(isOwnEntry(entry(), null)).toBe(false);
    expect(ownerLabel(entry(), null)).toBe('Steve');
  });
});

describe('placeInQueue', () => {
  it('reports a place from the order of the line', () => {
    const state = snapshot([foreign(), entry({ job: { ...entry().job, id: 'mine' } })]);
    expect(placeInQueue(state, 'mine')).toEqual({ ordinal: 2, ahead: 1 });
    expect(placeInQueue(state, foreign().job.id)).toEqual({ ordinal: 1, ahead: 0 });
  });

  it('says nothing when the queue is not live, or the job is not in it', () => {
    const state = snapshot([entry()]);
    expect(placeInQueue({ ...state, live: false }, 'job-1')).toBeNull();
    expect(placeInQueue(state, 'not-queued')).toBeNull();
    expect(placeInQueue(state, null)).toBeNull();
  });
});

describe('ordinal', () => {
  it('reads as English', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '101st',
    ]);
  });
});
