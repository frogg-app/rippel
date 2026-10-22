import { describe, expect, it } from 'vitest';
import { authorOf, fitOf, groupEntries, installedSource, parseSize, shortName } from './cardFacts';
import { BACKEND_ID, makeEntry, makeInstall, makeModel, makeRunnability } from './testing';

const GB = 1e9;

describe('card facts', () => {
  it('titles an entry by its repo short name, with the owner apart', () => {
    const workflowRow = makeEntry({ name: 'ESRGAN · RealESRGAN_x2.pth' });
    expect(shortName(workflowRow)).toBe('Real-ESRGAN');
    expect(authorOf(workflowRow)).toBe('ai-forever');
    const local = makeEntry({ name: 'SDXL · x.safetensors', ref: 'checkpoints/x.safetensors', reference: null, info: null });
    expect(shortName(local)).toBe('SDXL');
    expect(authorOf(local)).toBeNull();
  });

  it('reads the catalogue size strings', () => {
    expect(parseSize('6.94GB')).toBe(6.94 * GB);
    expect(parseSize('335 MB')).toBe(335e6);
    expect(parseSize('1GiB')).toBe(1024 ** 3);
    expect(parseSize(null)).toBeNull();
  });

  it('judges size against memory, and leaves blocking verdicts in words', () => {
    const ready = { type: 'checkpoint' as const, runnability: makeRunnability({ status: 'ready' }) };
    expect(fitOf(ready, 7 * GB, 16 * GB, 'Model')).toMatchObject({ label: '7.00 GB · fits', tone: 'good' });
    expect(fitOf(ready, 15 * GB, 16 * GB, 'Model').tone).toBe('soft');
    expect(fitOf(ready, 24 * GB, 16 * GB, 'Model')).toMatchObject({ tone: 'bad' });
    expect(fitOf(ready, 24 * GB, 16 * GB, 'Model').label).toMatch(/too big$/);
    const none = { type: 'checkpoint' as const, runnability: makeRunnability({ status: 'no-workflow' }) };
    expect(fitOf(none, null, 16 * GB, 'Model')).toMatchObject({ label: 'Not supported yet', tone: 'warn' });
  });

  it('groups files from one repo and type into one card, installed first', () => {
    const a = makeEntry({ ref: 'a', filename: 'a.safetensors' });
    const b = makeEntry({ ref: 'b', filename: 'b.safetensors', installed: true });
    const vae = makeEntry({ ref: 'v', type: 'vae' });
    const other = makeEntry({ ref: 'o', reference: 'https://huggingface.co/x/y', info: null });
    const groups = groupEntries([a, b, vae, other]);
    expect(groups.map((group) => group.entries.map((entry) => entry.ref))).toEqual([['b', 'a'], ['v'], ['o']]);
  });
});

describe('installedSource', () => {
  const model = makeModel();
  it('is exact for a file rippel installed, from the download URL', () => {
    const install = makeInstall({ status: 'complete', backendId: BACKEND_ID });
    expect(installedSource(model, { referenceUrl: 'https://huggingface.co/someone/else' }, [install])).toEqual({
      url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0',
      how: 'install',
    });
  });
  it('falls back to the filename match, then to nothing', () => {
    const failed = makeInstall({ status: 'failed', backendId: BACKEND_ID });
    expect(installedSource(model, { referenceUrl: 'https://huggingface.co/a/b' }, [failed])).toEqual({ url: 'https://huggingface.co/a/b', how: 'filename' });
    expect(installedSource(model, null, [])).toEqual({ url: null, how: null });
  });
});
