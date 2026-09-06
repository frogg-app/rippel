import { describe, expect, it } from 'vitest';

import { TemplateError } from '../errors.js';
import { cloneGraph, getPath, hasPath, setPath, setPaths } from '../json-path.js';
import { makeGraph } from './fixtures.js';

describe('getPath', () => {
  it('reads literals and links', () => {
    const graph = makeGraph();
    expect(getPath(graph, '6.inputs.text')).toBe('placeholder positive');
    expect(getPath(graph, '3.inputs.model')).toEqual(['4', 0]);
    expect(getPath(graph, '4.class_type')).toBe('CheckpointLoaderSimple');
  });

  it('throws on an unknown node, an unknown input, and a malformed path', () => {
    const graph = makeGraph();
    expect(() => getPath(graph, '99.inputs.text')).toThrow(TemplateError);
    expect(() => getPath(graph, '6.inputs.nope')).toThrow(/does not exist/);
    expect(() => getPath(graph, '')).toThrow(TemplateError);
    expect(() => getPath(graph, '6..text')).toThrow(/empty segment/);
  });

  it('refuses to walk through a non-object', () => {
    const graph = makeGraph();
    expect(() => getPath(graph, '6.inputs.text.deeper')).toThrow(TemplateError);
  });

  it('does not resolve inherited prototype properties', () => {
    const graph = makeGraph();
    expect(() => getPath(graph, '6.inputs.constructor')).toThrow(TemplateError);
    expect(hasPath(graph, '6.inputs.toString')).toBe(false);
  });
});

describe('setPath', () => {
  it('returns a new graph and leaves the original untouched', () => {
    const graph = makeGraph();
    const before = structuredClone(graph);

    const next = setPath(graph, '6.inputs.text', 'a cat');

    expect(next['6']!.inputs.text).toBe('a cat');
    expect(graph).toEqual(before);
    expect(next).not.toBe(graph);
    expect(next['6']).not.toBe(graph['6']);
  });

  it('deep-clones nested values so links cannot be shared', () => {
    const graph = makeGraph();
    const next = setPath(graph, '6.inputs.text', 'x');
    (next['3']!.inputs.model as unknown[])[0] = '999';
    expect(graph['3']!.inputs.model).toEqual(['4', 0]);
  });

  it('is a hard error on an unknown path rather than creating one', () => {
    const graph = makeGraph();
    expect(() => setPath(graph, '6.inputs.unknown_input', 'x')).toThrow(TemplateError);
    expect(() => setPath(graph, '42.inputs.text', 'x')).toThrow(TemplateError);
    expect(graph['6']!.inputs).not.toHaveProperty('unknown_input');
  });

  it('applies many substitutions at once', () => {
    const graph = makeGraph();
    const next = setPaths(graph, [
      ['6.inputs.text', 'a dog'],
      ['3.inputs.steps', 30],
    ]);
    expect(next['6']!.inputs.text).toBe('a dog');
    expect(next['3']!.inputs.steps).toBe(30);
    expect(graph['3']!.inputs.steps).toBe(20);
  });
});

describe('cloneGraph', () => {
  it('produces an equal but independent structure', () => {
    const graph = makeGraph();
    const copy = cloneGraph(graph);
    expect(copy).toEqual(graph);
    expect(copy['4']).not.toBe(graph['4']);
  });
});
