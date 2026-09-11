import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('./env.js', () => ({ env: { backends: [{ name: 'desktop', baseUrl: 'http://desktop:8188' }] } }));
vi.mock('./db.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() }));
import { queryOne, transaction } from './db.js';
import { seed } from './seed.js';

beforeEach(() => vi.resetAllMocks());

it('does not recreate a previously seeded backend after its removal or rename', async () => {
  vi.mocked(queryOne).mockResolvedValue({ id: 'existing-admin' });
  const sql = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
  vi.mocked(transaction).mockImplementation(async (fn) => fn({ query: sql } as never));
  await seed(() => {});
  expect(sql).toHaveBeenCalledTimes(1);
  expect(sql.mock.calls[0]?.[0]).toContain('INSERT INTO backend_seed_history');
});

it('records a new bootstrap name and creates its backend in one transaction', async () => {
  vi.mocked(queryOne).mockResolvedValue({ id: 'existing-admin' });
  const sql = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'new' }] });
  vi.mocked(transaction).mockImplementation(async (fn) => fn({ query: sql } as never));
  await seed(() => {});
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(sql).toHaveBeenCalledTimes(2);
  expect(sql.mock.calls[1]).toEqual([
    expect.stringContaining('INSERT INTO backends'), ['desktop', 'http://desktop:8188'],
  ]);
});
