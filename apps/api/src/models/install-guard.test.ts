/**
 * No path installs a file ComfyUI cannot load.
 *
 * One test per way a download starts, each against the real choke point with
 * only the database, the agent and the header read faked; then a source scan
 * that fails when a new way of recording or sending a download skips the guard.
 */
import Fastify from 'fastify';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => null), transaction: vi.fn() }));
vi.mock('../deploy/agent-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  agentClient: { moveModel: vi.fn(), downloadModel: vi.fn(), task: vi.fn() },
}));
vi.mock('../lib/backend-poller.js', () => ({ pollBackendNow: vi.fn() }));
vi.mock('./installs.js', async (importOriginal) => ({ ...(await importOriginal<object>()), requireTransport: vi.fn() }));

import type { ModelCatalogEntry } from '@comfy/shared';
import { query, queryOne } from '../db.js';
import { agentClient } from '../deploy/agent-client.js';
import { assertInstallable, installGuardDeps, UNLOADABLE_REASON, UnloadableFile } from './install-guard.js';
import { createInstall, dispatchWaitingInstalls, refreshInstall, requireTransport, startInstall, type InstallRow } from './installs.js';
import { planOperation, pollOperation, startOperation } from './operations.js';
import modelInstallRoutes from './routes.js';

const MUINEZ = 'https://huggingface.co/Muinez/ltxvideo-2b-nsfw/resolve/main/model_weights_0306.safetensors';
const GOOD = 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.1.safetensors';

const entry: ModelCatalogEntry = {
  ref: 'checkpoints/model_weights_0306.safetensors',
  name: 'Muinez/ltxvideo-2b-nsfw',
  filename: 'model_weights_0306.safetensors',
  type: 'checkpoint',
  base: 'LTX-Video',
  description: '',
  size: '7.7GB',
  url: MUINEZ,
  installed: false,
} as ModelCatalogEntry;

const layouts = new Map<string, string>();
const layout = vi.fn(async (url: string | null | undefined) => (url && layouts.get(url)) ?? 'unknown');
const original = installGuardDeps.layout;

beforeEach(() => {
  vi.mocked(query).mockReset().mockResolvedValue([] as never);
  vi.mocked(queryOne).mockReset().mockResolvedValue(null as never);
  vi.mocked(agentClient.downloadModel).mockReset();
  layouts.clear();
  layouts.set(MUINEZ, 'diffusers');
  layouts.set(GOOD, 'bundled');
  layout.mockClear();
  installGuardDeps.layout = layout as never;
});
afterEach(() => {
  installGuardDeps.layout = original;
  vi.unstubAllGlobals();
});

const inserts = () =>
  [...vi.mocked(query).mock.calls, ...vi.mocked(queryOne).mock.calls].filter(([sql]) => /INSERT INTO model_(installs|operations)/.test(String(sql)));

const stubTransport = () => ({
  kind: 'stub',
  available: async () => true,
  catalogue: async () => [entry],
  install: vi.fn(async () => {}),
  progress: async () => ({ state: 'complete' as const, detail: null }),
});

async function server() {
  const app = Fastify();
  app.decorate('requireAdmin', async (req: { user?: unknown }) => { req.user = { id: 'admin' }; });
  app.decorate('requireAuth', async () => {});
  await app.register(modelInstallRoutes);
  return app;
}

describe('the policy', () => {
  it('refuses a known-unloadable file and allows a loadable or unknown one', async () => {
    await expect(assertInstallable(MUINEZ)).rejects.toBeInstanceOf(UnloadableFile);
    await expect(assertInstallable(GOOD)).resolves.toBe('bundled');
    await expect(assertInstallable('https://huggingface.co/x/resolve/main/new.safetensors')).resolves.toBe('unknown');
  });

  it('reads an unknown file again at the guard rather than trusting an old failure', async () => {
    await assertInstallable('https://huggingface.co/x/resolve/main/new.safetensors');
    expect(layout.mock.calls[0]![2]).toBeLessThan(10 * 60_000);
  });

  it('does not check or block files with no safetensors header', async () => {
    for (const url of [
      'https://huggingface.co/city96/FLUX.1-dev-gguf/resolve/main/flux1-dev-Q4_K_S.gguf',
      'https://huggingface.co/x/resolve/main/RealESRGAN_x4.pth',
      'https://huggingface.co/x/resolve/main/sd-v1-5.ckpt',
      'https://civitai.com/api/download/models/1234',
    ]) {
      await expect(assertInstallable(url)).resolves.toBe('unknown');
    }
    expect(layout).not.toHaveBeenCalled();
  });

  it('says it in one line', () => {
    expect(UNLOADABLE_REASON).toBe('This file won’t run in ComfyUI.');
  });
});

describe('every install path refuses it', () => {
  it('Discover card Install and the version picker (POST /backends/:id/models)', async () => {
    vi.mocked(queryOne).mockResolvedValue({ id: 'backend', name: 'Desktop', base_url: 'http://desktop:8188' } as never);
    const transport = stubTransport();
    vi.mocked(requireTransport).mockResolvedValue(transport as never);
    const app = await server();
    try {
      const response = await app.inject({ method: 'POST', url: '/backends/backend/models', payload: { ref: entry.ref } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'unloadable', message: UNLOADABLE_REASON });
      expect(transport.install).not.toHaveBeenCalled();
      expect(inserts()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('"Get a version that works" (POST .../working-build), should its build ever turn out unloadable', async () => {
    layout.mockResolvedValue('diffusers');
    vi.mocked(queryOne)
      .mockResolvedValueOnce({ id: 'backend', name: 'Desktop', base_url: 'http://desktop:8188' } as never)
      .mockResolvedValueOnce({ filename: 'model_weights_0306.safetensors', base_model: 'LTX-Video' } as never)
      .mockResolvedValueOnce(null as never);
    const transport = stubTransport();
    vi.mocked(requireTransport).mockResolvedValue(transport as never);
    const app = await server();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/backends/backend/models/00000000-0000-4000-8000-000000000000/working-build',
        payload: {},
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().message).toBe(UNLOADABLE_REASON);
      expect(transport.install).not.toHaveBeenCalled();
      expect(inserts()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('readiness "install part", companions and workflow suggestions (startInstall)', async () => {
    const transport = stubTransport();
    await expect(
      startInstall({ backendId: 'b', backendName: 'Desktop', requestedBy: 'u', entry, transport: transport as never }),
    ).rejects.toThrow(UNLOADABLE_REASON);
    // Companions wait behind another install; refused just the same.
    await expect(
      startInstall({ backendId: 'b', backendName: 'Desktop', requestedBy: 'u', entry, transport: transport as never, after: 'x' }),
    ).rejects.toBeInstanceOf(UnloadableFile);
    expect(transport.install).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(0);
  });

  it('any new caller that records an install directly (createInstall)', async () => {
    await expect(createInstall({ backendId: 'b', requestedBy: 'u', entry })).rejects.toBeInstanceOf(UnloadableFile);
    expect(inserts()).toHaveLength(0);
  });

  it('retries, and parts queued or waiting from before the check existed (dispatchWaitingInstalls)', async () => {
    const row = { id: 'old', backend_id: 'b', base_url: 'http://desktop:8188', filename: entry.filename, url: MUINEZ, save_path: 'checkpoints', model_type: 'checkpoint', status: 'waiting' };
    vi.mocked(query).mockResolvedValueOnce([row] as never);
    vi.mocked(queryOne).mockResolvedValue({ ...row, status: 'queued' } as never);
    const transport = stubTransport();
    vi.mocked(requireTransport).mockResolvedValue(transport as never);
    await dispatchWaitingInstalls();
    expect(transport.install).not.toHaveBeenCalled();
    const failed = vi.mocked(queryOne).mock.calls.find(([sql]) => String(sql).includes("status = 'failed'"));
    expect(failed?.[1]).toEqual(['old', UNLOADABLE_REASON]);
  });

  it('agent downloads, Fix and workflow-library installs (planOperation)', async () => {
    await expect(
      planOperation({
        backendId: 'b',
        actorId: 'u',
        steps: [{ kind: 'download', request: { url: MUINEZ, path: 'checkpoints/model_weights_0306.safetensors', sha256: 'a', sizeBytes: 1 } }],
      }),
    ).rejects.toBeInstanceOf(UnloadableFile);
    expect(inserts()).toHaveLength(0);
  });

  it('a download already planned before the check: never sent to the agent (dispatchStep)', async () => {
    const op = {
      id: 'op', backend_id: 'b', status: 'starting', step_index: 0,
      steps: [{ kind: 'download', request: { url: MUINEZ, path: 'checkpoints/model_weights_0306.safetensors', sha256: 'a', sizeBytes: 1 } }],
    };
    vi.mocked(queryOne).mockResolvedValueOnce(op as never).mockResolvedValueOnce({ ...op, status: 'failed' } as never);
    await startOperation('op');
    expect(agentClient.downloadModel).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), ['op', UNLOADABLE_REASON]);
  });
});

describe('after the download, when the header could not be read before', () => {
  it('fails the install instead of completing it (ComfyUI-Manager and agent installs)', async () => {
    const row = {
      id: 'i', backend_id: 'b', transport_kind: 'stub', filename: 'late.safetensors', url: 'https://huggingface.co/x/resolve/main/late.safetensors',
      save_path: 'checkpoints', model_type: 'checkpoint', status: 'downloading', bytes_total: null, bytes_received: null, created_at: new Date(),
    } as unknown as InstallRow;
    layouts.set(row.url, 'diffusers');
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('/api/models/') ? Response.json(['late.safetensors']) : Response.json({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false })));
    vi.mocked(queryOne).mockImplementation((async (sql: string, params: unknown[]) => ({ ...row, status: String(sql).includes("'failed'") ? 'failed' : params[1], error: params[1] })) as never);
    const install = await refreshInstall(row, 'http://desktop:8188');
    expect(install.status).toBe('failed');
    expect(install.error).toBe(UNLOADABLE_REASON);
  });

  it('fails an agent file operation instead of marking it done', async () => {
    const url = 'https://huggingface.co/x/resolve/main/late.safetensors';
    layouts.set(url, 'diffusers');
    vi.mocked(queryOne).mockResolvedValue({ host: 'desktop', agent_port: 8189, token: 't' } as never);
    vi.mocked(agentClient.task).mockResolvedValue({ task: { id: 'task', status: 'done' } } as never);
    await pollOperation({
      id: 'op', backend_id: 'b', status: 'running', step_index: 0, agent_task_id: 'task',
      steps: [{ kind: 'download', request: { url, path: 'checkpoints/late.safetensors', sha256: 'a', sizeBytes: 1 } }],
    } as never);
    const failed = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes("status='failed'"));
    expect(failed?.[1]?.[3]).toBe(UNLOADABLE_REASON);
  });
});

/**
 * The entry points, enumerated from the source. A new place that writes an
 * install record, plans a file operation, or sends a download straight to a
 * transport or the agent fails here until it goes through the guard.
 */
describe('nothing bypasses the guard', () => {
  const root = join(import.meta.dirname, '..');
  const sources: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) sources.push({ file: path.slice(root.length + 1), text: readFileSync(path, 'utf8') });
    }
  };
  walk(root);
  const where = (pattern: RegExp) => sources.filter((s) => pattern.test(s.text)).map((s) => s.file).sort();

  /** The body of a function, from its declaration to the next top-level one. */
  const body = (file: string, fn: string) => {
    const text = sources.find((s) => s.file === file)!.text;
    const start = text.search(new RegExp(`(async )?function ${fn}\\(`));
    expect(start, `${fn} in ${file}`).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const end = rest.search(/\n(export )?(async )?function |\nexport (const|class) /);
    return rest.slice(0, end < 0 ? undefined : end);
  };

  it('install records are only written by createInstall, which is guarded', () => {
    expect(where(/INSERT INTO model_installs/)).toEqual(['models/installs.ts']);
    expect(body('models/installs.ts', 'createInstall')).toMatch(/INSERT INTO model_installs/);
    expect(body('models/installs.ts', 'createInstall')).toMatch(/await assertInstallable\(/);
  });

  it('transports are only told to download by dispatchInstall, which is guarded', () => {
    expect(where(/\btransport\.install\(/)).toEqual(['models/installs.ts']);
    expect(body('models/installs.ts', 'dispatchInstall')).toMatch(/await assertInstallable\(/);
    expect(body('models/installs.ts', 'dispatchInstall')).toMatch(/transport\.install\(/);
  });

  it('file operations are only planned by planOperation, which is guarded', () => {
    expect(where(/INSERT INTO model_operations/)).toEqual(['models/operations.ts']);
    expect(body('models/operations.ts', 'planOperation')).toMatch(/await assertStepsInstallable\(/);
  });

  it('the agent is only sent downloads by dispatchStep, which is guarded', () => {
    expect(where(/\.downloadModel\(/)).toEqual(['models/operations.ts']);
    expect(body('models/operations.ts', 'dispatchStep')).toMatch(/await assertInstallable\(step\.request\.url\)/);
  });

  it('completed installs and downloads are read again', () => {
    expect(body('models/installs.ts', 'complete')).toMatch(/unloadableAfterDownload\(/);
    expect(body('models/operations.ts', 'pollOperation')).toMatch(/unloadableAfterDownload\(/);
    // Every completion goes through `complete`.
    expect(sources.find((s) => s.file === 'models/installs.ts')!.text.match(/finish\([^)]*'complete'/g)).toHaveLength(1);
  });
});
