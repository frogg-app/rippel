/**
 * Tests for the two pieces of the orchestrator that interpret somebody else's
 * data: ComfyUI's /history entries and our own event fan-out.
 *
 * These are worth pinning because the history format is undocumented, was read
 * off a running server, and a misreading is silent — the job does not error, it
 * just sits at the wrong status or reports the wrong outcome. The scheduling
 * loop around them is deliberately not unit-tested here: it is mostly database
 * state, and it was verified end to end against the real backend.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readHistory } from './collect.js';
import { clearSubscribers, publish, subscribe, subscriberCount } from './events.js';

const BASE = 'http://backend:8188';
const PROMPT = 'p-1';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  clearSubscribers();
});

describe('readHistory', () => {
  it('treats a missing entry as pending, not as failure', async () => {
    // ComfyUI only writes a history entry once execution ends, so "absent" is
    // the normal state of a job that is still running.
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    expect(await readHistory(BASE, PROMPT)).toEqual({ state: 'pending' });
  });

  it('treats a non-200 as pending rather than inventing an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    expect(await readHistory(BASE, PROMPT)).toEqual({ state: 'pending' });
  });

  it('collects outputs across every save node', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({
        [PROMPT]: {
          status: { status_str: 'success', completed: true },
          outputs: {
            '9': { images: [{ filename: 'a.png', subfolder: 'x', type: 'output' }] },
            '12': { images: [{ filename: 'b.png', subfolder: 'x', type: 'output' }] },
          },
        },
      }),
    ));

    const outcome = await readHistory(BASE, PROMPT);
    expect(outcome.state).toBe('success');
    expect(outcome.state === 'success' && outcome.outputs.map((o) => o.filename)).toEqual([
      'a.png',
      'b.png',
    ]);
  });

  it('ignores temp outputs, which are live previews rather than results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({
        [PROMPT]: {
          status: { status_str: 'success' },
          outputs: {
            '9': {
              images: [
                { filename: 'preview.png', subfolder: '', type: 'temp' },
                { filename: 'real.png', subfolder: '', type: 'output' },
              ],
            },
          },
        },
      }),
    ));

    const outcome = await readHistory(BASE, PROMPT);
    expect(outcome.state === 'success' && outcome.outputs.map((o) => o.filename)).toEqual([
      'real.png',
    ]);
  });

  it('collects video outputs, which ComfyUI reports under gifs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({
        [PROMPT]: {
          status: { status_str: 'success' },
          outputs: { '9': { gifs: [{ filename: 'clip.webp', subfolder: '', type: 'output' }] } },
        },
      }),
    ));

    const outcome = await readHistory(BASE, PROMPT);
    expect(outcome.state === 'success' && outcome.outputs).toHaveLength(1);
  });

  it('digs the real reason out of an execution_error message', async () => {
    // The status says only "error"; the useful part is in the message list, and
    // without it the user gets "it failed" and nothing to act on. This is the
    // exact shape the real backend produced when its VAE kernel faulted.
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({
        [PROMPT]: {
          status: {
            status_str: 'error',
            completed: false,
            messages: [
              ['execution_start', { prompt_id: PROMPT }],
              [
                'execution_error',
                { node_type: 'VAEDecode', exception_message: 'CUDA error: invalid kernel file' },
              ],
            ],
          },
        },
      }),
    ));

    const outcome = await readHistory(BASE, PROMPT);
    expect(outcome.state).toBe('error');
    expect(outcome.state === 'error' && outcome.message).toMatch(
      /VAEDecode failed: CUDA error: invalid kernel file/,
    );
  });

  it('still reports an error when the message list is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ [PROMPT]: { status: { status_str: 'error' } } })));
    expect((await readHistory(BASE, PROMPT)).state).toBe('error');
  });
});

describe('the event bus', () => {
  const A = 'user-a';
  const B = 'user-b';

  it('delivers only to the user the event belongs to', () => {
    const toA: string[] = [];
    const toB: string[] = [];
    subscribe(A, (e) => toA.push(e.type));
    subscribe(B, (e) => toB.push(e.type));

    publish(A, { type: 'job.failed', jobId: 'j1', error: 'nope' });

    expect(toA).toEqual(['job.failed']);
    expect(toB).toEqual([]);
  });

  it('keeps delivering when one subscriber throws', () => {
    // One broken socket must not stop the others being told.
    const delivered: string[] = [];
    subscribe(A, () => {
      throw new Error('this socket is gone');
    });
    subscribe(A, (e) => delivered.push(e.type));

    expect(() => publish(A, { type: 'job.failed', jobId: 'j1', error: 'x' })).not.toThrow();
    expect(delivered).toEqual(['job.failed']);
  });

  it('forgets a user entirely once their last tab goes away', () => {
    const off1 = subscribe(A, () => {});
    const off2 = subscribe(A, () => {});
    expect(subscriberCount(A)).toBe(2);
    off1();
    off2();
    expect(subscriberCount(A)).toBe(0);
  });

  it('publishing to nobody is harmless', () => {
    expect(() => publish('nobody', { type: 'job.failed', jobId: 'j', error: 'x' })).not.toThrow();
  });
});
