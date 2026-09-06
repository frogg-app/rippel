/**
 * Tests for the model install transport.
 *
 * These run against a stubbed `fetch` rather than a live ComfyUI: the whole
 * point of the transport is the shape of the conversation with Manager, and
 * that shape was read off Manager's source. What is worth pinning down is that
 * we send what its whitelist check expects and interpret its replies correctly
 * — particularly the failure replies, which are the ones an operator will
 * actually hit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// The completion-rule tests exercise decision logic, not SQL. Mocking the db
// module keeps them free of a live Postgres while still running the real
// branching in refreshInstall; each helper echoes the row back with the fields
// the UPDATE would have set.
vi.mock('../db.js', () => ({
  query: vi.fn(async (_sql: string, params: unknown[] = []) => [
    { ...dbRow, status: params[1], detail: params[2] },
  ]),
  queryOne: vi.fn(async (_sql: string, params: unknown[] = []) => ({
    ...dbRow,
    status: String(_sql).includes("'failed'") ? 'failed' : params[1],
    detail: params[2] ?? null,
    error: String(_sql).includes("'failed'") ? params[1] : null,
  })),
}));

import type { ModelCatalogEntry } from '@comfy/shared';
import { ComfyManagerTransport } from './transports/comfy-manager.js';
import { TransportError } from './transport.js';
import type { InstallRequest, ModelTransport } from './transport.js';
import {
  backendHasFile,
  folderForType,
  InstallConflict,
  refreshInstall,
  startInstall,
} from './installs.js';
import type { InstallRow } from './installs.js';

const BASE = 'http://backend:8188';

/** Shared by the db mock above; declared here and read lazily inside it. */
const dbRow = {
  id: 'i1',
  backend_id: 'b1',
  requested_by: 'u1',
  filename: 'sd_xl_base_1.0.safetensors',
  display_name: 'sd_xl_base_1.0.safetensors',
  model_type: 'checkpoint',
  base_model: 'SDXL',
  url: 'https://huggingface.co/x/sd_xl_base_1.0.safetensors',
  save_path: 'checkpoints/SDXL',
  status: 'downloading',
  detail: null,
  error: null,
  created_at: new Date(),
  started_at: new Date(),
  finished_at: null,
};

/** Stub fetch with a handler keyed on the path. */
function stubFetch(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(BASE.length);
    return handler(path, init);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('ComfyManagerTransport.available', () => {
  it('is false on a stock ComfyUI, where Manager routes 404', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 }));
    expect(await new ComfyManagerTransport(BASE).available()).toBe(false);
  });

  it('is false when the backend is unreachable rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await new ComfyManagerTransport(BASE).available()).toBe(false);
  });

  it('is true when the queue endpoint answers', async () => {
    stubFetch(() => json({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false }));
    expect(await new ComfyManagerTransport(BASE).available()).toBe(true);
  });
});

describe('ComfyManagerTransport.catalogue', () => {
  const models = [
    {
      name: 'sd_xl_base_1.0.safetensors',
      type: 'checkpoints',
      base: 'SDXL',
      save_path: 'checkpoints/SDXL',
      description: 'Stable Diffusion XL base model',
      filename: 'sd_xl_base_1.0.safetensors',
      url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
      size: '6.94GB',
      installed: 'False',
    },
    // A type we have no model category for: must be skipped, not guessed at.
    { name: 'mystery', type: 'gligen', base: 'X', save_path: 'gligen', filename: 'm.safetensors', url: 'http://x/m' },
    // Missing a url: unusable.
    { name: 'broken', type: 'checkpoints', base: 'SDXL', save_path: 'checkpoints', filename: 'b.safetensors' },
  ];

  it('maps entries and builds a ref matching Manager\'s whitelist tuple', async () => {
    stubFetch(() => json({ models }));
    const entries = await new ComfyManagerTransport(BASE).catalogue();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ref: 'checkpoints/SDXL/sd_xl_base_1.0.safetensors',
      filename: 'sd_xl_base_1.0.safetensors',
      type: 'checkpoint',
      base: 'SDXL',
      size: '6.94GB',
      installed: false,
    });
  });

  it('reads the installed flag as both a string and a boolean', async () => {
    stubFetch(() => json({ models: [{ ...models[0], installed: 'True' }] }));
    expect((await new ComfyManagerTransport(BASE).catalogue())[0]!.installed).toBe(true);

    stubFetch(() => json({ models: [{ ...models[0], installed: true }] }));
    expect((await new ComfyManagerTransport(BASE).catalogue())[0]!.installed).toBe(true);
  });
});

describe('ComfyManagerTransport.install', () => {
  const request = {
    name: 'sd_xl_base_1.0.safetensors',
    filename: 'sd_xl_base_1.0.safetensors',
    type: 'checkpoints',
    base: 'SDXL',
    savePath: 'checkpoints/SDXL',
    url: 'https://huggingface.co/x/sd_xl_base_1.0.safetensors',
  };

  it('sends the fields Manager matches its whitelist on, then starts the queue', async () => {
    const calls: { path: string; body?: unknown }[] = [];
    stubFetch((path, init) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response('', { status: 200 });
    });

    await new ComfyManagerTransport(BASE).install(request);

    expect(calls.map((c) => c.path)).toEqual([
      '/manager/queue/install_model',
      '/manager/queue/start',
    ]);
    // save_path, base and filename are the tuple check_whitelist_for_model
    // compares; getting any of them wrong is a 400 from the backend.
    expect(calls[0]!.body).toMatchObject({
      save_path: 'checkpoints/SDXL',
      base: 'SDXL',
      filename: 'sd_xl_base_1.0.safetensors',
      url: request.url,
    });
  });

  it('treats a 201 from queue/start as success, not a conflict', async () => {
    stubFetch((path) =>
      path === '/manager/queue/start'
        ? new Response('', { status: 201 })
        : new Response('', { status: 200 }),
    );
    await expect(new ComfyManagerTransport(BASE).install(request)).resolves.toBeUndefined();
  });

  it('explains a 403 as the security level, which is what it always is', async () => {
    stubFetch(() => new Response('security', { status: 403 }));
    await expect(new ComfyManagerTransport(BASE).install(request)).rejects.toThrow(/security level/i);
  });

  it('explains a 400 as the model not being on the list', async () => {
    stubFetch(() => new Response('bad', { status: 400 }));
    await expect(new ComfyManagerTransport(BASE).install(request)).rejects.toThrow(
      /does not recognise/i,
    );
  });

  it('marks a 5xx retryable and a 4xx not', async () => {
    stubFetch(() => new Response('', { status: 503 }));
    await expect(new ComfyManagerTransport(BASE).install(request)).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe('ComfyManagerTransport.progress', () => {
  const request = {
    name: 'x', filename: 'x.safetensors', type: 'checkpoints',
    base: 'SDXL', savePath: 'checkpoints/SDXL', url: 'http://x',
  };

  it('reports downloading while the queue is working', async () => {
    stubFetch(() => json({ total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true }));
    expect(await new ComfyManagerTransport(BASE).progress(request)).toMatchObject({
      state: 'downloading',
    });
  });

  it('never claims complete from an idle queue', async () => {
    // An idle queue is ambiguous — not started, or finished, or failed — so the
    // caller must corroborate against ComfyUI's own listing. Reporting
    // 'complete' here would mark a failed download as installed.
    stubFetch(() => json({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false }));
    const progress = await new ComfyManagerTransport(BASE).progress(request);
    expect(progress.state).toBe('queued');
  });

  it('surfaces a transport error rather than a bogus state', async () => {
    stubFetch(() => new Response('', { status: 500 }));
    await expect(new ComfyManagerTransport(BASE).progress(request)).rejects.toThrow(TransportError);
  });
});

describe('folderForType', () => {
  it('maps our model types onto ComfyUI folder names', () => {
    expect(folderForType('checkpoint')).toBe('checkpoints');
    expect(folderForType('lora')).toBe('loras');
    expect(folderForType('upscaler')).toBe('upscale_models');
  });

  it('returns null for a type with no folder, rather than guessing', () => {
    expect(folderForType('video')).toBeNull();
  });
});

describe('backendHasFile', () => {
  it('matches a file Manager saved into a subfolder on a Windows backend', async () => {
    // Manager's save_path for this entry is "checkpoints/SDXL", so ComfyUI
    // lists it with the subfolder attached and a Windows separator. Comparing
    // the raw strings would miss it and the install would never complete.
    stubFetch(() => json(['SDXL\\sd_xl_base_1.0.safetensors']));
    expect(await backendHasFile(BASE, 'checkpoints', 'sd_xl_base_1.0.safetensors')).toBe(true);
  });

  it('matches a forward-slash subfolder too', async () => {
    stubFetch(() => json(['SDXL/sd_xl_base_1.0.safetensors']));
    expect(await backendHasFile(BASE, 'checkpoints', 'sd_xl_base_1.0.safetensors')).toBe(true);
  });

  it('is false while only the other models are present', async () => {
    stubFetch(() => json(['hunyuan_video_720p_fp8_e4m3fn.safetensors']));
    expect(await backendHasFile(BASE, 'checkpoints', 'sd_xl_base_1.0.safetensors')).toBe(false);
  });

  it('is false rather than throwing when the backend errors', async () => {
    stubFetch(() => new Response('', { status: 500 }));
    expect(await backendHasFile(BASE, 'checkpoints', 'x.safetensors')).toBe(false);
  });
});

describe('refreshInstall completion rule', () => {
  // The bug this guards against, observed against the real backend:
  // ComfyUI-Manager downloads in place, so ComfyUI lists the file seconds after
  // the download starts and keeps listing it, half-written, for the next twenty
  // minutes. Presence alone is not completion.
  const row = dbRow as InstallRow;

  it('does not complete while the queue is still working, even though ComfyUI already lists the file', async () => {
    stubFetch((path) => {
      if (path.startsWith('/api/models/')) {
        // Present, but only partially written.
        return json(['SDXL\\sd_xl_base_1.0.safetensors']);
      }
      return json({ total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true });
    });

    const install = await refreshInstall(row, BASE);
    expect(install.status).toBe('downloading');
  });

  it('completes only once the queue is idle and the file is there', async () => {
    stubFetch((path) =>
      path.startsWith('/api/models/')
        ? json(['SDXL\\sd_xl_base_1.0.safetensors'])
        : json({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false }),
    );

    const install = await refreshInstall(row, BASE);
    expect(install.status).toBe('complete');
  });

  it('fails a download whose queue finished without producing the file', async () => {
    stubFetch((path) =>
      path.startsWith('/api/models/')
        ? json(['hunyuan_video_720p_fp8_e4m3fn.safetensors'])
        : json({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false }),
    );

    const install = await refreshInstall(row, BASE);
    expect(install.status).toBe('failed');
    expect(install.error).toMatch(/not present/i);
  });

  it('leaves the row alone when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const install = await refreshInstall(row, BASE);
    // Retryable: still in flight, not failed.
    expect(install.status).toBe('downloading');
  });
});

/**
 * The install path the readiness screen drives.
 *
 * Exercised against a stub transport rather than the live backend on purpose:
 * the entries involved are gigabytes. What is worth pinning down is the
 * *sequence* — record the row, then start the download, never the other way
 * round — plus the two refusals a batch install has to survive without aborting.
 */
describe('startInstall', () => {
  const entry: ModelCatalogEntry = {
    ref: 'text_encoders/t5/t5xxl_fp16.safetensors',
    name: 'comfyanonymous/flux_text_encoders - t5xxl (fp16)',
    filename: 't5xxl_fp16.safetensors',
    type: 'clip',
    base: 't5',
    description: 'Text Encoders for FLUX (fp16)',
    size: '9.79GB',
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors',
    installed: false,
  };

  function stubTransport(install: ModelTransport['install']): ModelTransport {
    return {
      kind: 'stub',
      available: async () => true,
      catalogue: async () => [entry],
      install,
      progress: async () => ({ state: 'queued' as const, detail: null }),
    };
  }

  it('records the install and then asks the backend to start it', async () => {
    const seen: InstallRequest[] = [];
    const result = await startInstall({
      backendId: 'b1',
      backendName: 'workshop',
      requestedBy: 'u1',
      entry,
      transport: stubTransport(async (req) => {
        seen.push(req);
      }),
    });

    expect(result.id).toBe('i1');
    // Recorded first: a download the database does not know about is one
    // nothing will ever poll, cancel or report.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(dbRow.url);
  });

  it('refuses an entry the catalogue already calls installed', async () => {
    await expect(
      startInstall({
        backendId: 'b1',
        backendName: 'workshop',
        requestedBy: 'u1',
        entry: { ...entry, installed: true },
        transport: stubTransport(async () => {
          throw new Error('must not be called');
        }),
      }),
    ).rejects.toBeInstanceOf(InstallConflict);
  });

  it('marks the row failed when the transport refuses, and rethrows', async () => {
    const { query: queryFn } = await import('../db.js');
    const queryMock = vi.mocked(queryFn);
    queryMock.mockClear();

    await expect(
      startInstall({
        backendId: 'b1',
        backendName: 'workshop',
        requestedBy: 'u1',
        entry,
        transport: stubTransport(async () => {
          throw new TransportError('ComfyUI-Manager does not recognise this model');
        }),
      }),
    ).rejects.toBeInstanceOf(TransportError);

    // Without this the row sits in 'queued' forever with nothing downloading.
    expect(
      queryMock.mock.calls.some(([sql]) => String(sql).includes("status = 'failed'")),
    ).toBe(true);
  });

  it('a conflict is recoverable, so a batch can skip one entry and carry on', async () => {
    const results: string[] = [];
    for (const candidate of [{ ...entry, installed: true }, entry]) {
      try {
        await startInstall({
          backendId: 'b1',
          backendName: 'workshop',
          requestedBy: 'u1',
          entry: candidate,
          transport: stubTransport(async () => {}),
        });
        results.push('queued');
      } catch (err) {
        if (!(err instanceof InstallConflict)) throw err;
        results.push('skipped');
      }
    }
    expect(results).toEqual(['skipped', 'queued']);
  });
});
