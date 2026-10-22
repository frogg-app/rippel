/**
 * Files no ComfyUI loader reads, marked before install: the Muinez LTX file
 * shape (a diffusers transformer beside a loadable build in the same repo).
 */
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogueCard } from './CatalogueCard';
import { groupEntries } from './cardFacts';
import { compareBest } from './discover';
import { worksHere } from './intents';
import { makeEntry } from './testing';
import { layoutDeps, requestLayouts, resetLayouts, useWithLayouts } from './weightsLayouts';

const MUINEZ = 'https://huggingface.co/Muinez/ltxvideo-2b-nsfw/resolve/main/model_weights_0306.safetensors';
const ready = makeEntry({ name: 'ready', url: 'https://huggingface.co/a/b/resolve/main/ok.safetensors' });
const broken = makeEntry({ ...ready, name: 'broken', ref: 'x/model_weights_0306.safetensors', url: MUINEZ, weightsLayout: 'diffusers' });

afterEach(() => resetLayouts());

describe('a file ComfyUI cannot load', () => {
  it('fails "Works on this machine" and sorts after the rest', () => {
    expect(worksHere(broken)).toBe(false);
    expect([broken, ready].sort(compareBest)[0]).toBe(ready);
  });

  it('is not the face of a repo that has a loadable file', () => {
    const [group] = groupEntries([broken, { ...ready, reference: broken.reference, info: broken.info, type: broken.type }]);
    expect(group!.primary.weightsLayout).toBeUndefined();
  });

  it('shows the pill and a disabled Install with the reason on hover', () => {
    render(<CatalogueCard entry={broken} install={null} starting={false} canInstall onInstall={vi.fn()} failure={null} now={Date.now()} />);
    expect(screen.getByText('Won’t run in ComfyUI')).toBeInTheDocument();
    const install = screen.getByRole('button', { name: /Install/ });
    expect(install).toBeDisabled();
    expect(install.parentElement).toHaveAttribute('title', expect.stringMatching(/diffusers format/));
  });
});

describe('the layout store', () => {
  it('asks once per URL, in one batch, and lays answers over the entries', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (urls: string[]) => Object.fromEntries(urls.map((url) => [url, url === MUINEZ ? 'diffusers' : 'bundled'] as const)));
    layoutDeps.fetch = fetch;
    const plain = { ...broken, weightsLayout: undefined };
    const { result } = renderHook(() => useWithLayouts([plain, ready]));
    requestLayouts([MUINEZ, ready.url, MUINEZ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    vi.useRealTimers();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toEqual([MUINEZ, ready.url]);
    expect(result.current[0]!.weightsLayout).toBe('diffusers');
    requestLayouts([MUINEZ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
