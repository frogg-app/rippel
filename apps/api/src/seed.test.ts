import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./env.js', () => ({ env: { backends: [{ name: 'desktop', baseUrl: 'http://desktop:8188' }] } }));
vi.mock('./db.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { query, queryOne } from './db.js';
import { seed } from './seed.js';
beforeEach(() => vi.resetAllMocks());
it('does not create unmanaged backends from legacy environment configuration', async () => {
  vi.mocked(queryOne).mockResolvedValue({ id: 'existing-admin' });
  await seed(() => {});
  expect(query).not.toHaveBeenCalled();
  expect(queryOne).toHaveBeenCalledExactlyOnceWith('SELECT id FROM users LIMIT 1');
});
