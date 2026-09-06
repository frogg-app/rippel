/**
 * Reading a model page.
 *
 * The fixtures are trimmed copies of what huggingface.co actually returned for
 * these repos on 2026-09-06. What is worth pinning is the *choosing*: which of
 * a repo's images becomes the preview, and which references we refuse to follow
 * at all. Both are places where a plausible-looking wrong answer — a shields.io
 * badge, or a picture of somebody else's model — is worse than no picture.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { previewIdFor } from './metadata.js';
import {
  fetchSourceFacts,
  parseReference,
  sourceKeyOf,
  UnsupportedSource,
} from './metadata-sources.js';

afterEach(() => vi.unstubAllGlobals());

/** Answer the two URLs a HuggingFace lookup makes, and nothing else. */
function stubHuggingFace(model: unknown, readme: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/api/models/')) {
        return new Response(JSON.stringify(model), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.endsWith('README.md')) {
        return readme === null ? new Response('nope', { status: 404 }) : new Response(readme);
      }
      throw new Error(`unexpected fetch: ${href}`);
    }),
  );
}

describe('parseReference', () => {
  it('reads a HuggingFace repo out of a model page URL', () => {
    expect(parseReference('https://huggingface.co/stabilityai/sdxl-turbo')).toEqual({
      kind: 'huggingface',
      repo: 'stabilityai/sdxl-turbo',
    });
  });

  it('tolerates the trailing slash the catalogue really carries', () => {
    expect(parseReference('https://huggingface.co/Kim2091/AnimeSharp/')).toEqual({
      kind: 'huggingface',
      repo: 'Kim2091/AnimeSharp',
    });
  });

  it('recognises Civitai, so it can be refused explicitly rather than silently', () => {
    expect(parseReference('https://civitai.com/models/8765/theovercomer8s-contrast-fix')).toEqual({
      kind: 'civitai',
      id: '8765',
    });
  });

  it('has no opinion about a GitHub project page or a missing reference', () => {
    expect(parseReference('https://github.com/madebyollin/taesd')).toBeNull();
    expect(parseReference(null)).toBeNull();
  });
});

describe('previewIdFor', () => {
  it('is stable, and contains nothing that needs escaping in a URL', () => {
    const id = previewIdFor('hf:stabilityai/stable-diffusion-xl-base-1.0');
    expect(id).toMatch(/^[0-9a-f]{20}$/);
    expect(previewIdFor('hf:stabilityai/stable-diffusion-xl-base-1.0')).toBe(id);
    expect(previewIdFor('hf:other/repo')).not.toBe(id);
  });
});

describe('fetchSourceFacts', () => {
  it('refuses Civitai rather than pretending to try', async () => {
    await expect(fetchSourceFacts({ kind: 'civitai', id: '8765' })).rejects.toBeInstanceOf(
      UnsupportedSource,
    );
  });

  it('takes the licence, the counts and the card image', async () => {
    stubHuggingFace(
      {
        downloads: 1_767_210,
        likes: 8113,
        pipeline_tag: 'text-to-image',
        cardData: { license: 'openrail++' },
        siblings: [{ rfilename: '01.png' }, { rfilename: 'sd_xl_base_1.0.safetensors' }],
      },
      '# SDXL\n![sample](comparison.png)\n',
    );

    const facts = await fetchSourceFacts({ kind: 'huggingface', repo: 'stabilityai/sdxl' });
    expect(facts.license).toBe('openrail++');
    expect(facts.downloads).toBe(1_767_210);
    expect(facts.likes).toBe(8113);
    expect(facts.pipelineTag).toBe('text-to-image');
    expect(facts.imageCandidates[0]).toBe(
      'https://huggingface.co/stabilityai/sdxl/resolve/main/comparison.png',
    );
    // The repo's own image files come after the card's, never instead of them.
    expect(facts.imageCandidates).toContain(
      'https://huggingface.co/stabilityai/sdxl/resolve/main/01.png',
    );
  });

  it('throws away badges, logos and architecture diagrams', async () => {
    stubHuggingFace(
      { siblings: [{ rfilename: 'assets/brand.png' }, { rfilename: 'pipeline.png' }] },
      '![](https://img.shields.io/static/v1?label=Code&message=Github)\n![](assets/logo.png)\n',
    );
    const facts = await fetchSourceFacts({ kind: 'huggingface', repo: 'some/repo' });
    expect(facts.imageCandidates).toEqual([]);
  });

  it('prefers a sample over the control image a ControlNet card opens with', async () => {
    stubHuggingFace(
      { siblings: [] },
      '![](./canny.jpg)\n![](./demo_0.jpg)\n',
    );
    const facts = await fetchSourceFacts({ kind: 'huggingface', repo: 'InstantX/SD3-Canny' });
    expect(facts.imageCandidates[0]).toContain('demo_0.jpg');
  });

  it('follows one declared parent, and refuses to choose between fourteen', async () => {
    stubHuggingFace({ cardData: { base_model: 'black-forest-labs/FLUX.1-dev' } }, null);
    const one = await fetchSourceFacts({ kind: 'huggingface', repo: 'city96/FLUX.1-dev-gguf' });
    expect(one.derivedFrom).toEqual({ kind: 'huggingface', repo: 'black-forest-labs/FLUX.1-dev' });

    stubHuggingFace({ cardData: { base_model: ['Wan-AI/Wan2.1-T2V-14B', 'Wan-AI/Wan2.1-VACE-14B'] } }, null);
    const many = await fetchSourceFacts({ kind: 'huggingface', repo: 'Comfy-Org/Wan_2.1' });
    expect(many.derivedFrom).toBeNull();
  });

  it('survives a repo with no model card at all', async () => {
    stubHuggingFace({ siblings: [{ rfilename: 'model.safetensors' }] }, null);
    const facts = await fetchSourceFacts({ kind: 'huggingface', repo: 'someone/weights-only' });
    expect(facts.imageCandidates).toEqual([]);
    expect(facts.license).toBeNull();
  });
});

describe('sourceKeyOf', () => {
  it('collapses every file in a repo onto one cache row', () => {
    expect(sourceKeyOf({ kind: 'huggingface', repo: 'city96/FLUX.1-dev-gguf' })).toBe(
      'hf:city96/FLUX.1-dev-gguf',
    );
  });
});
