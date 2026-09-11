import { expect, it } from 'vitest';
import { fetchSnapshot, trimObjectInfo } from './snapshot.js';

it('keeps ordering and dynamic widget metadata without display information', () => {
  const input = { required: { size: ['INT', { default: 512, min: 64, step: 32 }] } };
  expect(trimObjectInfo({ Node: { input, input_order: { required: ['size'] }, output: ['IMAGE'], output_node: true, description: 'discard' } }))
    .toEqual({ Node: { input, input_order: { required: ['size'] }, output: ['IMAGE'], output_node: true } });
});
it('fails failed and empty snapshots rather than replacing a useful fixture', async () => {
  await expect(fetchSnapshot('http://backend', async () => new Response('', { status: 503 }))).rejects.toThrow('503');
  await expect(fetchSnapshot('http://backend', async () => new Response('{}'))).rejects.toThrow('no node');
});
