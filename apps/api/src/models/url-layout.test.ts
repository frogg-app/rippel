/** The pre-install header check: which URLs it reads, and what it remembers. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const stored = new Map<string, string>();
vi.mock('../db.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT')) {
      return (params[0] as string[]).filter((url) => stored.has(url)).map((url) => ({ url, layout: stored.get(url) }));
    }
    stored.set(params[0] as string, params[1] as string);
    return [];
  }),
}));

const { layoutForUrl, layoutsForUrls, probeable, resetUrlLayouts, urlLayoutDeps } = await import('./url-layout.js');

const keys = (name: string) =>
  (JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as { keys: string[] }).keys;

const MUINEZ = 'https://huggingface.co/Muinez/ltxvideo-2b-nsfw/resolve/main/model_weights_0306.safetensors';
const LTX = 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.1.safetensors';

describe('url layouts', () => {
  beforeEach(() => {
    stored.clear();
    resetUrlLayouts();
  });

  it('only reads Hugging Face safetensors over https', () => {
    expect(probeable(MUINEZ)).toBe(true);
    expect(probeable('http://huggingface.co/a/b/resolve/main/x.safetensors')).toBe(false);
    expect(probeable('https://example.com/x.safetensors')).toBe(false);
    expect(probeable('https://huggingface.co/a/b/resolve/main/x.gguf')).toBe(false);
  });

  it('calls the Muinez file diffusers before install, and remembers it', async () => {
    const read = vi.fn(async (url: string) => (url === MUINEZ ? keys('ltxv-diffusers-keys.json') : keys('ltxv-single-file-keys.json')));
    urlLayoutDeps.read = read;
    const first = await layoutsForUrls([MUINEZ, LTX]);
    expect(first.get(MUINEZ)).toBe('diffusers');
    expect(first.get(LTX)).toBe('bundled');
    expect(stored.get(MUINEZ)).toBe('diffusers');

    resetUrlLayouts();
    expect(await layoutForUrl(MUINEZ)).toBe('diffusers');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('says unknown, and stores nothing, when the header cannot be read', async () => {
    urlLayoutDeps.read = vi.fn(async () => null);
    expect(await layoutForUrl(MUINEZ)).toBe('unknown');
    expect(stored.size).toBe(0);
  });
});
