import { expect, it, vi } from 'vitest';
import index from './fixtures/index.json' with { type: 'json' };
import { filterCatalogue, parseCatalogue, WorkflowLibraryClient } from './catalogue.js';

it('reads all 538 pinned workflows and finds 14 open-source image-to-video workflows', () => {
  const catalogue = parseCatalogue(index, '0.11.55');
  expect(catalogue.entries).toHaveLength(538);
  expect(filterCatalogue(catalogue, { tag: 'Image to Video' })).toHaveLength(14);
  expect(filterCatalogue(catalogue, { tag: 'Image to Video', includeCloud: true })).toHaveLength(66);
});

it('isolates backend caches, pins imports and refuses paths outside the catalogue', async () => {
  let version = '0.11.55';
  const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).endsWith('/system_stats') ? { system: { installed_templates_version: version } }
      : String(url).endsWith('/index.json') ? index : { nodes: [] },
  )));
  const client = new WorkflowLibraryClient(fetchImpl);
  await client.catalogue('a', 'http://a'); await client.catalogue('a', 'http://a');
  expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('index.json'))).toHaveLength(1);
  await client.catalogue('b', 'http://b');
  expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('index.json'))).toHaveLength(2);
  const name = 'video_wan2_2_5B_ti2v';
  expect(await client.workflow('a', 'http://a', name, version)).toEqual({ nodes: [] });
  await expect(client.workflow('a', 'http://a', '../private', version)).rejects.toThrow('No such');
  version = '0.11.56';
  await expect(client.workflow('a', 'http://a', name, '0.11.55')).rejects.toThrow('changed');
});
