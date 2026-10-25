import { describe, expect, it } from 'vitest';
import { installForEntry } from './CatalogueGrid';
import { installsByFilename } from './catalogue';
import { makeEntry, makeInstall } from './testing';

describe('installForEntry', () => {
  const official = makeEntry({ ref: 'hugging-face:stabilityai/svd-xt', filename: 'svd_xt.safetensors' });
  const reupload = makeEntry({ ref: 'civitai:123', filename: 'svd_xt.safetensors' });

  it('gives an install only to the entry it was started from, not every entry sharing its filename', () => {
    const index = installsByFilename([makeInstall({ filename: 'svd_xt.safetensors', catalogueRef: official.ref })]);
    expect(installForEntry(index, official)).not.toBeNull();
    expect(installForEntry(index, reupload)).toBeNull();
  });

  it('finds its own install behind a newer one for another entry', () => {
    const index = installsByFilename([
      makeInstall({ id: 'theirs', filename: 'svd_xt.safetensors', catalogueRef: reupload.ref }),
      makeInstall({ id: 'mine', filename: 'svd_xt.safetensors', catalogueRef: official.ref }),
    ]);
    expect(installForEntry(index, official)?.id).toBe('mine');
  });

  it('still matches an older install with no ref by filename', () => {
    const index = installsByFilename([makeInstall({ filename: 'svd_xt.safetensors', catalogueRef: null })]);
    expect(installForEntry(index, reupload)).not.toBeNull();
  });
});
