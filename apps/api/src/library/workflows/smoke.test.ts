import { afterEach, expect, it, vi } from 'vitest';
import { cheapestParams, inspectSmoke } from './smoke.js';
import { TEMPLATES } from '../../workflows/registry.js';
import { compile } from '../../compiler/compile.js';
afterEach(() => vi.unstubAllGlobals());
it('compiles cheap settings for every built-in workflow', () => {
  for (const template of TEMPLATES) expect(() => compile({ template, params: cheapestParams(template),
    modelFilenames: { 'smoke-model': 'fixture.safetensors' }, jobId: 'smoke' })).not.toThrow();
});
it('requires completed history and actual output bytes', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ p: { status: { completed: true }, outputs: {} } }))
    .mockResolvedValueOnce(Response.json({ p: { status: { completed: true }, outputs: { '1': { videos: [{ filename: 'result.mp4', type: 'output' }] } } } }))
    .mockResolvedValueOnce(new Response('video-bytes'));
  vi.stubGlobal('fetch', fetchMock);
  expect((await inspectSmoke('http://backend', 'p')).status).toBe('running');
  expect((await inspectSmoke('http://backend', 'p')).status).toBe('failed');
  expect(await inspectSmoke('http://backend', 'p')).toEqual({ status: 'ready', output: 'result.mp4' });
});
