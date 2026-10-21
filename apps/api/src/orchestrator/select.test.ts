import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn() }));
import { query } from '../db.js';
import { pickBackend } from './select.js';
afterEach(() => vi.resetAllMocks());
const machines = [{id:'steve',name:'steve',active_jobs:0}, {id:'paz',name:'paz',active_jobs:2}];
it('honours the target even when another backend is less busy', async () => {
 vi.mocked(query).mockResolvedValue(machines);
 expect((await pickBackend('model', undefined, 'paz')).id).toBe('paz');
});
it('does not fall back when the target lacks the model or is offline', async () => {
 vi.mocked(query).mockResolvedValueOnce([machines[0]]).mockResolvedValueOnce(machines);
 await expect(pickBackend('model', undefined, 'paz')).rejects.toThrow();
});
it('does not bypass workflow readiness for an explicit target', async () => {
 vi.mocked(query).mockResolvedValue(machines);
 await expect(pickBackend('model', ['steve'], 'paz')).rejects.toThrow();
});
