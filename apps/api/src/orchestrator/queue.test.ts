/**
 * Tests for the shared queue.
 *
 * Same approach as library.test.ts: an in-memory stand-in for Postgres that
 * *reads the SQL this module actually emits* rather than returning canned rows.
 * That matters for two of the properties being tested here.
 *
 *  - **Privacy.** The fake applies the `CASE ... THEN j.params ELSE NULL END`
 *    projection it finds in the statement, using the real bound parameters. If
 *    someone rewrote the query to select `j.params` unconditionally and deleted
 *    the field in JavaScript afterwards, the fake would hand the prompt over
 *    and the privacy test would fail — which is the point: the contract asks
 *    for a response constructed without the field, not scrubbed of it.
 *  - **Order.** The fake parses the ORDER BY clause and sorts by it, so
 *    "promotion changes what dispatches next" is a test of `nextQueuedJob`'s
 *    statement, not of a comparator written twice.
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GenerationParams, JobStatus, QueueView, User } from '@comfy/shared';
import { cancelJob, type CancelDeps } from './cancel.js';
import { clearSubscribers, subscribe } from './events.js';
import { nextQueuedJob, type JobRow } from './jobs.js';
import { loadQueueView, promoteToTop, publishQueuePositions, type QueueDb } from './queue.js';
import { makeQueueRoutes } from './queue-routes.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

const NAMES: Record<string, string | null> = { [ALICE]: 'Alice', [BOB]: 'Bob', [ADMIN]: 'Root' };

function jobId(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function params(prompt: string): GenerationParams {
  return {
    kind: 'txt2img',
    prompt,
    modelId: '99999999-9999-4999-8999-999999999999',
    quality: 'balanced',
    aspect: '1:1',
    batchSize: 1,
  };
}

interface FakeJob extends Omit<JobRow, 'params'> {
  params: GenerationParams;
}

function job(overrides: Partial<FakeJob> & { id: string }): FakeJob {
  return {
    user_id: ALICE,
    kind: 'txt2img',
    status: 'queued',
    params: params(`prompt for ${overrides.id}`),
    template_id: 't',
    backend_id: null,
    comfy_prompt_id: null,
    progress: {},
    priority: 0,
    error: null,
    created_at: new Date('2026-09-01T00:00:00Z'),
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------- fake pg

/** `ORDER BY j.priority DESC, j.created_at` -> a comparator over the rows. */
function comparatorFromSql(sql: string): (a: FakeJob, b: FakeJob) => number {
  const clause = /ORDER BY ([^]*?)(?:\s+LIMIT|\s*$)/i.exec(sql)?.[1];
  if (!clause) return () => 0;

  const terms = clause.split(',').map((term) => {
    const [field, direction] = term.trim().split(/\s+/);
    return {
      field: field!.replace(/^[a-z]+\./, '') as keyof FakeJob,
      sign: direction?.toUpperCase() === 'DESC' ? -1 : 1,
    };
  });

  return (a, b) => {
    for (const { field, sign } of terms) {
      const av = a[field] as number | Date | string;
      const bv = b[field] as number | Date | string;
      const cmp = av instanceof Date ? av.getTime() - (bv as Date).getTime() : av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return cmp * sign;
    }
    return 0;
  };
}

function fakeDb(rows: FakeJob[]): { db: QueueDb; rows: FakeJob[] } {
  const table = rows;

  const query = async (sql: string, values: unknown[] = []): Promise<Record<string, never>[]> => {
    const statuses = /status IN \(([^)]*)\)/i.exec(sql)?.[1];
    const wanted = statuses
      ? statuses.split(',').map((s) => s.trim().replace(/'/g, ''))
      : ['queued'];

    const hits = table.filter((r) => wanted.includes(r.status)).sort(comparatorFromSql(sql));
    const limited = /LIMIT 1\b/.test(sql) ? hits.slice(0, 1) : hits;

    // Apply the params projection exactly as written in the statement. A query
    // with no such CASE hands the prompt over — which is what makes the
    // privacy test meaningful rather than self-fulfilling.
    const masks = /CASE WHEN \$2::boolean OR j\.user_id = \$1::uuid\s+THEN j\.params ELSE NULL END AS params/.test(
      sql.replace(/\s+/g, ' '),
    );
    const [viewerId, isAdmin] = values as [string, boolean];

    return limited.map((r) => ({
      ...r,
      owner_name: NAMES[r.user_id] ?? null,
      params: masks && !(isAdmin || r.user_id === viewerId) ? null : r.params,
    })) as unknown as Record<string, never>[];
  };

  const queryOne = async (sql: string, values: unknown[] = []): Promise<never | null> => {
    // The only statement that goes through queryOne here is the promotion.
    if (/UPDATE jobs/.test(sql) && /priority/.test(sql)) {
      const [id] = values as [string];
      const row = table.find((r) => r.id === id && r.status === 'queued');
      if (!row) return null;
      const max = Math.max(0, ...table.filter((r) => r.status === 'queued').map((r) => r.priority));
      row.priority = max + 1;
      return row as unknown as never;
    }
    throw new Error(`unexpected statement: ${sql}`);
  };

  return { db: { query, queryOne } as unknown as QueueDb, rows: table };
}

afterEach(() => {
  clearSubscribers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- the view

describe('the queue view', () => {
  const world = () =>
    fakeDb([
      job({ id: jobId(1), user_id: BOB, status: 'running', started_at: new Date('2026-09-01T00:10:00Z') }),
      job({ id: jobId(2), user_id: ALICE, created_at: new Date('2026-09-01T00:01:00Z') }),
      job({ id: jobId(3), user_id: BOB, created_at: new Date('2026-09-01T00:02:00Z') }),
      job({ id: jobId(4), user_id: ALICE, created_at: new Date('2026-09-01T00:03:00Z') }),
    ]);

  it("withholds another user's prompt but not their place in the line", async () => {
    const { db } = world();
    const view = await loadQueueView({ viewerId: ALICE, isAdmin: false, db });

    const bobs = view.entries.find((e) => e.ownerId === BOB)!;
    expect(bobs.job.params).toBeNull();
    expect(bobs.ownerName).toBe('Bob');
    expect(bobs.position).toBe(2);
    expect(JSON.stringify(view)).not.toContain(`prompt for ${jobId(3)}`);

    const mine = view.entries.find((e) => e.ownerId === ALICE)!;
    expect(mine.job.params?.prompt).toBe(`prompt for ${jobId(2)}`);
  });

  it("withholds the running job's prompt from someone who does not own it", async () => {
    const { db } = world();
    const view = await loadQueueView({ viewerId: ALICE, isAdmin: false, db });
    expect(view.running?.ownerId).toBe(BOB);
    expect(view.running?.job.params).toBeNull();
    expect(view.running?.ownerName).toBe('Bob');
  });

  it('shows an admin everything', async () => {
    const { db } = world();
    const view = await loadQueueView({ viewerId: ADMIN, isAdmin: true, db });
    expect(view.entries.every((e) => e.job.params !== null)).toBe(true);
    expect(view.running?.job.params?.prompt).toBe(`prompt for ${jobId(1)}`);
  });

  it('numbers positions globally and queuePosition per user', async () => {
    const { db } = world();
    const view = await loadQueueView({ viewerId: ALICE, isAdmin: false, db });

    // Global: 1, 2, 3 in dispatch order across everybody.
    expect(view.entries.map((e) => [e.job.id, e.position])).toEqual([
      [jobId(2), 1],
      [jobId(3), 2],
      [jobId(4), 3],
    ]);
    // Per-user: Alice's second job has one of *hers* ahead of it, not two.
    expect(view.entries.map((e) => [e.ownerId, e.job.queuePosition])).toEqual([
      [ALICE, 0],
      [BOB, 0],
      [ALICE, 1],
    ]);
  });

  it('puts the running job in exactly one place', async () => {
    const { db } = world();
    const view = await loadQueueView({ viewerId: ADMIN, isAdmin: true, db });

    expect(view.running?.job.id).toBe(jobId(1));
    expect(view.entries.map((e) => e.job.id)).not.toContain(jobId(1));
    expect(idsIn(view)).toHaveLength(new Set(idsIn(view)).size);
    // Every live job is accounted for: none dropped between the buckets.
    expect(new Set(idsIn(view))).toEqual(new Set([jobId(1), jobId(2), jobId(3), jobId(4)]));
  });

  it('shows a job caught mid-dispatch once, as running rather than waiting', async () => {
    // 'dispatched' is the transitional status: ours no longer, the backend's
    // not yet visibly. It must not appear in both buckets or in neither.
    const { db } = fakeDb([
      job({ id: jobId(1), status: 'dispatched', started_at: new Date('2026-09-01T00:05:00Z') }),
      job({ id: jobId(2), created_at: new Date('2026-09-01T00:06:00Z') }),
    ]);
    const view = await loadQueueView({ viewerId: ALICE, isAdmin: false, db });
    expect(view.running?.job.id).toBe(jobId(1));
    expect(view.entries.map((e) => e.job.id)).toEqual([jobId(2)]);
  });

  it('picks the job that started first when several are still in flight', async () => {
    // A job being stored while the next one is dispatched, or several
    // re-adopted after a restart. The one on the GPU is the older one.
    const { db } = fakeDb([
      job({ id: jobId(1), status: 'uploading', started_at: new Date('2026-09-01T00:01:00Z') }),
      job({ id: jobId(2), status: 'dispatched', started_at: new Date('2026-09-01T00:09:00Z') }),
    ]);
    const view = await loadQueueView({ viewerId: ALICE, isAdmin: false, db });
    expect(view.running?.job.id).toBe(jobId(1));
    expect(view.entries).toEqual([]);
  });

  it('is empty, not broken, on an idle box', async () => {
    const { db } = fakeDb([]);
    expect(await loadQueueView({ viewerId: ALICE, isAdmin: false, db })).toEqual({
      entries: [],
      running: null,
    });
  });
});

function idsIn(view: QueueView): string[] {
  return [...view.entries.map((e) => e.job.id), ...(view.running ? [view.running.job.id] : [])];
}

// ---------------------------------------------------------------- priority

describe('priority', () => {
  const three = () =>
    fakeDb([
      job({ id: jobId(1), created_at: new Date('2026-09-01T00:01:00Z') }),
      job({ id: jobId(2), user_id: BOB, created_at: new Date('2026-09-01T00:02:00Z') }),
      job({ id: jobId(3), user_id: BOB, created_at: new Date('2026-09-01T00:03:00Z') }),
    ]);

  /** `nextQueuedJob` reading the same fake table the promotion wrote to. */
  const dispatchOrder = async (db: QueueDb) =>
    (await nextQueuedJob({ query: db.query }))?.id;

  it('changes what dispatches next', async () => {
    const { db } = three();
    expect(await dispatchOrder(db)).toBe(jobId(1));

    await promoteToTop(jobId(3), db);
    expect(await dispatchOrder(db)).toBe(jobId(3));
  });

  it('stacks: the most recently promoted job goes first', async () => {
    const { db } = three();
    await promoteToTop(jobId(3), db);
    await promoteToTop(jobId(2), db);
    expect(await dispatchOrder(db)).toBe(jobId(2));
  });

  it('leaves the rest in the order they were asked for', async () => {
    const { db } = three();
    await promoteToTop(jobId(3), db);
    const view = await loadQueueView({ viewerId: ADMIN, isAdmin: true, db });
    expect(view.entries.map((e) => e.job.id)).toEqual([jobId(3), jobId(1), jobId(2)]);
  });

  it('refuses a job that is no longer waiting', async () => {
    const { db } = fakeDb([job({ id: jobId(1), status: 'running' })]);
    expect(await promoteToTop(jobId(1), db)).toBeNull();
  });

  it('does not touch created_at, so history and per-user counts survive', async () => {
    const { db, rows } = three();
    const before = rows.map((r) => r.created_at.toISOString());
    await promoteToTop(jobId(3), db);
    expect(rows.map((r) => r.created_at.toISOString())).toEqual(before);
  });
});

// ---------------------------------------------------------------- events

describe('queue position events', () => {
  it('tells each owner where their own jobs now sit', async () => {
    const { db } = fakeDb([
      job({ id: jobId(1), created_at: new Date('2026-09-01T00:01:00Z') }),
      job({ id: jobId(2), user_id: BOB, created_at: new Date('2026-09-01T00:02:00Z') }),
      job({ id: jobId(3), created_at: new Date('2026-09-01T00:03:00Z') }),
    ]);

    const toAlice: unknown[] = [];
    const toBob: unknown[] = [];
    subscribe(ALICE, (e) => toAlice.push(e));
    subscribe(BOB, (e) => toBob.push(e));

    await publishQueuePositions(db);

    expect(toAlice).toEqual([
      { type: 'job.status', jobId: jobId(1), status: 'queued', queuePosition: 0 },
      { type: 'job.status', jobId: jobId(3), status: 'queued', queuePosition: 1 },
    ]);
    // Bob is second globally but first among his own.
    expect(toBob).toEqual([
      { type: 'job.status', jobId: jobId(2), status: 'queued', queuePosition: 0 },
    ]);
  });
});

// ---------------------------------------------------------------- cancel

describe('cancelling', () => {
  const deps = (row: FakeJob, fetchImpl: CancelDeps['fetch']): {
    deps: CancelDeps;
    statuses: JobStatus[];
  } => {
    const statuses: JobStatus[] = [];
    return {
      statuses,
      deps: {
        queryOne: (async () => ({ base_url: 'http://backend:8188' })) as CancelDeps['queryOne'],
        setStatus: (async (_id: string, status: JobStatus) => {
          statuses.push(status);
          return { ...row, status } as unknown as JobRow;
        }) as unknown as CancelDeps['setStatus'],
        fetch: fetchImpl,
      },
    };
  };

  it('drops a queued job without troubling any backend', async () => {
    const row = job({ id: jobId(1) });
    const fetchImpl = vi.fn();
    const { deps: d, statuses } = deps(row, fetchImpl as unknown as CancelDeps['fetch']);

    const after = await cancelJob(row as unknown as JobRow, d);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(statuses).toEqual(['cancelled']);
    expect(after.status).toBe('cancelled');
  });

  it('asks ComfyUI to drop a dispatched one, by prompt id', async () => {
    const row = job({
      id: jobId(1),
      status: 'running',
      comfy_prompt_id: 'p-7',
      backend_id: '44444444-4444-4444-8444-444444444444',
    });
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const { deps: d, statuses } = deps(row, fetchImpl as unknown as CancelDeps['fetch']);

    await cancelJob(row as unknown as JobRow, d);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://backend:8188/queue');
    expect(JSON.parse(String(init.body))).toEqual({ delete: ['p-7'] });
    expect(statuses).toEqual(['cancelled']);
  });

  it('still cancels when the backend cannot be reached', async () => {
    // The failure this guards: a box that is off leaving a job stuck at
    // 'running' forever in the user's tab.
    const row = job({
      id: jobId(1),
      status: 'running',
      comfy_prompt_id: 'p-7',
      backend_id: '44444444-4444-4444-8444-444444444444',
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { deps: d, statuses } = deps(row, fetchImpl as unknown as CancelDeps['fetch']);

    const after = await cancelJob(row as unknown as JobRow, d);
    expect(statuses).toEqual(['cancelled']);
    expect(after.status).toBe('cancelled');
  });

  it('leaves a job that already finished alone', async () => {
    const row = job({ id: jobId(1), status: 'complete' });
    const fetchImpl = vi.fn();
    const { deps: d, statuses } = deps(row, fetchImpl as unknown as CancelDeps['fetch']);

    expect((await cancelJob(row as unknown as JobRow, d)).status).toBe('complete');
    expect(statuses).toEqual([]);
  });
});

// ---------------------------------------------------------------- routes

describe('the queue routes', () => {
  function user(id: string, role: User['role']): User {
    return { id, email: `${id}@example.test`, displayName: NAMES[id] ?? null, role, createdAt: '' };
  }

  /**
   * A real Fastify instance with the auth decorators the app provides, so the
   * admin-only rules are exercised through the same hooks production uses.
   */
  async function server(rows: FakeJob[], as: User) {
    const { db } = fakeDb(rows);
    const app = Fastify();
    const cancelled: string[] = [];

    app.decorateRequest('user', null);
    app.addHook('onRequest', async (req) => {
      req.user = as;
    });
    app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) await reply.code(401).send({ error: 'unauthorized', message: 'Sign in.' });
    });
    app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) {
        await reply.code(401).send({ error: 'unauthorized', message: 'Sign in.' });
        return;
      }
      if (req.user.role !== 'admin') {
        await reply.code(403).send({ error: 'forbidden', message: 'Needs an administrator.' });
      }
    });

    await app.register(
      makeQueueRoutes({
        db,
        getJob: (async (id: string) => rows.find((r) => r.id === id) ?? null) as never,
        cancelJob: (async (row: JobRow) => {
          cancelled.push(row.id);
          const hit = rows.find((r) => r.id === row.id)!;
          hit.status = 'cancelled';
          return hit as unknown as JobRow;
        }) as never,
      }),
    );

    return { app, rows, cancelled };
  }

  const twoUsers = () => [
    job({ id: jobId(1), user_id: ALICE, created_at: new Date('2026-09-01T00:01:00Z') }),
    job({ id: jobId(2), user_id: BOB, created_at: new Date('2026-09-01T00:02:00Z') }),
  ];

  it('GET /queue never sends a foreign prompt over the wire', async () => {
    const { app } = await server(twoUsers(), user(ALICE, 'user'));
    const res = await app.inject({ method: 'GET', url: '/queue' });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(`prompt for ${jobId(2)}`);

    const view = res.json<QueueView>();
    const foreign = view.entries.find((e) => e.ownerId === BOB)!;
    expect(foreign.job.params).toBeNull();
    expect(foreign.ownerName).toBe('Bob');
    expect(foreign.position).toBe(2);
    expect(view.entries.find((e) => e.ownerId === ALICE)!.job.params).not.toBeNull();
  });

  it('GET /queue is open to any signed-in user', async () => {
    const { app } = await server(twoUsers(), user(BOB, 'user'));
    expect((await app.inject({ method: 'GET', url: '/queue' })).statusCode).toBe(200);
  });

  it('refuses a normal user the admin routes', async () => {
    const { app, cancelled } = await server(twoUsers(), user(ALICE, 'user'));

    const promote = await app.inject({
      method: 'POST',
      url: `/queue/${jobId(2)}/priority`,
      payload: { position: 'top' },
    });
    expect(promote.statusCode).toBe(403);

    const remove = await app.inject({ method: 'DELETE', url: `/queue/${jobId(2)}` });
    expect(remove.statusCode).toBe(403);
    expect(cancelled).toEqual([]);
  });

  it('lets an admin move a job to the top', async () => {
    const { app, rows } = await server(twoUsers(), user(ADMIN, 'admin'));
    const res = await app.inject({
      method: 'POST',
      url: `/queue/${jobId(2)}/priority`,
      payload: { position: 'top' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().job.id).toBe(jobId(2));
    expect(rows.find((r) => r.id === jobId(2))!.priority).toBeGreaterThan(0);

    const view = await app.inject({ method: 'GET', url: '/queue' });
    expect(view.json<QueueView>().entries.map((e) => e.job.id)).toEqual([jobId(2), jobId(1)]);
  });

  it('rejects a position it cannot honour', async () => {
    const { app } = await server(twoUsers(), user(ADMIN, 'admin'));
    const res = await app.inject({
      method: 'POST',
      url: `/queue/${jobId(1)}/priority`,
      payload: { position: 'third' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('tells an admin when the job they promoted has already started', async () => {
    const rows = [job({ id: jobId(1), status: 'running' })];
    const { app } = await server(rows, user(ADMIN, 'admin'));
    const res = await app.inject({
      method: 'POST',
      url: `/queue/${jobId(1)}/priority`,
      payload: { position: 'top' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already running/);
  });

  it("lets an admin cancel somebody else's queued job", async () => {
    const { app, rows, cancelled } = await server(twoUsers(), user(ADMIN, 'admin'));
    const res = await app.inject({ method: 'DELETE', url: `/queue/${jobId(2)}` });

    expect(res.statusCode).toBe(204);
    expect(cancelled).toEqual([jobId(2)]);
    expect(rows.find((r) => r.id === jobId(2))!.status).toBe('cancelled');

    const view = await app.inject({ method: 'GET', url: '/queue' });
    expect(view.json<QueueView>().entries.map((e) => e.job.id)).toEqual([jobId(1)]);
  });

  it('cancels a dispatched job through the same path as a queued one', async () => {
    const rows = [
      job({
        id: jobId(1),
        status: 'running',
        comfy_prompt_id: 'p-7',
        backend_id: '44444444-4444-4444-8444-444444444444',
        started_at: new Date('2026-09-01T00:05:00Z'),
      }),
    ];
    const { app, cancelled } = await server(rows, user(ADMIN, 'admin'));

    expect((await app.inject({ method: 'DELETE', url: `/queue/${jobId(1)}` })).statusCode).toBe(204);
    // The route does not know the difference; cancel.ts does, and it is the
    // only implementation either route calls.
    expect(cancelled).toEqual([jobId(1)]);
  });

  it('404s a job that does not exist', async () => {
    const { app } = await server(twoUsers(), user(ADMIN, 'admin'));
    const res = await app.inject({ method: 'DELETE', url: `/queue/${jobId(9)}` });
    expect(res.statusCode).toBe(404);
  });
});
