/**
 * Every shipped graph, against the node specs captured from a real ComfyUI.
 *
 * This is the automated half of MODELS_PLAN's "read node specs from the backend,
 * do not write graphs from memory" rule. It cannot prove a graph correct — the
 * fixture is partial — but it catches the class of mistake that no other test
 * here can see: an input name that does not exist, a link to a node that does
 * not, an enum value ComfyUI would refuse.
 */
import { describe, expect, it } from 'vitest';

import { TEMPLATES } from './registry.js';
import { coverageOf, describeProblems, validateGraph } from './validate-graph.js';
import type { ComfyApiGraph } from './types.js';

describe('the shipped graphs', () => {
  it.each(TEMPLATES.map((t) => [t.manifest.id, t] as const))(
    '%s agrees with the captured node specs',
    (_id, template) => {
      const problems = validateGraph(template.graph);
      expect(problems, `\n${describeProblems(problems)}\n`).toEqual([]);
    },
  );

  it('knows every class in the Wan 2.2 graph bar the one nobody captured', () => {
    // That template was written against a live /object_info, so the fixture
    // should speak to almost all of it. `CLIPTextEncode` is the exception and
    // is named here rather than quietly filled in from memory: the fixture is a
    // record of what was *captured*, and guessing an entry would hollow out the
    // rule this whole module exists to enforce. Refreshing the fixture against
    // a live backend should empty this list, and this test will say so.
    const wan = TEMPLATES.find((t) => t.manifest.id === 'img2vid-wan22-ti2v-5b')!;
    expect(coverageOf(wan.graph).unknown).toEqual(['CLIPTextEncode']);
  });

  it('has something to say about every graph we ship', () => {
    // A template the fixture knew nothing at all about would pass vacuously.
    for (const template of TEMPLATES) {
      expect(coverageOf(template.graph).known.length, template.manifest.id).toBeGreaterThan(0);
    }
  });
});

describe('what the validator catches', () => {
  const good: ComfyApiGraph = {
    '1': { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
    '2': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 0] } },
    '3': { class_type: 'CreateVideo', inputs: { images: ['2', 0], fps: 24 } },
  };

  it('passes a graph that is right', () => {
    expect(validateGraph(good)).toEqual([]);
  });

  it('catches an input name that does not exist', () => {
    // The expensive typo: accepted by every other test, rejected by ComfyUI
    // after the user has waited.
    const bad = { ...good, '3': { class_type: 'CreateVideo', inputs: { images: ['2', 0], frame_rate: 24 } } };
    const problems = validateGraph(bad as ComfyApiGraph);
    expect(problems.some((p) => p.input === 'frame_rate')).toBe(true);
  });

  it('catches a missing required input', () => {
    const bad = { ...good, '3': { class_type: 'CreateVideo', inputs: { images: ['2', 0] } } };
    expect(validateGraph(bad as ComfyApiGraph)[0]!.message).toMatch(/required input "fps"/);
  });

  it('catches a link to a node that is not there', () => {
    const bad = { ...good, '2': { class_type: 'VAEDecode', inputs: { samples: ['99', 0], vae: ['1', 0] } } };
    expect(validateGraph(bad as ComfyApiGraph)[0]!.message).toMatch(/does not exist/);
  });

  it('catches a value outside the node’s declared range', () => {
    const bad = { ...good, '3': { class_type: 'CreateVideo', inputs: { images: ['2', 0], fps: 500 } } };
    expect(validateGraph(bad as ComfyApiGraph)[0]!.message).toMatch(/above the maximum of 120/);
  });

  it('catches an enum value ComfyUI would refuse', () => {
    const bad: ComfyApiGraph = {
      '1': { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5.safetensors', type: 'wan2.2' } },
    };
    expect(validateGraph(bad)[0]!.message).toMatch(/is not one of/);
  });
});

describe('what it deliberately will not judge', () => {
  it('says nothing about which files are installed', () => {
    // A graph naming a file the backend lacks is a readiness question, and
    // readiness answers it properly with a download attached.
    const graph: ComfyApiGraph = {
      '1': { class_type: 'VAELoader', inputs: { vae_name: 'nothing-has-this.safetensors' } },
    };
    expect(validateGraph(graph)).toEqual([]);
  });

  it('will not reject a sampler from an enum it only partly captured', () => {
    // `KSampler.sampler_name` has 45 entries and the fixture kept ten.
    // Judging against a partial list would reject perfectly valid samplers.
    const graph: ComfyApiGraph = {
      '1': {
        class_type: 'KSampler',
        inputs: {
          model: ['1', 0], seed: 0, steps: 20, cfg: 5, sampler_name: 'res_multistep',
          scheduler: 'simple', positive: ['1', 0], negative: ['1', 0], latent_image: ['1', 0], denoise: 1,
        },
      },
    };
    expect(validateGraph(graph)).toEqual([]);
  });

  it('skips a class nobody has captured yet rather than failing it', () => {
    // Otherwise adding a template would mean capturing every node in it before
    // the suite would go green — a safety net that behaves like a blocker.
    const graph: ComfyApiGraph = {
      '1': { class_type: 'SomeNodeNobodyHasCapturedYet', inputs: { whatever: 1 } },
    };
    expect(validateGraph(graph)).toEqual([]);
    expect(coverageOf(graph).unknown).toEqual(['SomeNodeNobodyHasCapturedYet']);
  });
});
