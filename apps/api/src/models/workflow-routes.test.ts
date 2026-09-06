/**
 * The workflows-per-model routes, against a fake database and a fixture
 * `/object_info` shaped like the reference box: the LTX-Video file in
 * `diffusion_models/`, the Hunyuan file in `checkpoints/`, no text encoders
 * and no VAE beyond `pixel_space`.
 *
 * What is worth pinning: that the per-template verdicts differ where the
 * templates differ (the two LTX graphs give opposite answers about the same
 * file), that a pin is honoured and validated, and that removal is honest
 * about the file it could not delete.
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ModelRemoval, ModelWorkflows } from '@comfy/shared';
import type { ObjectInfo } from '../lib/comfy.js';
import {
  BackendFileDeletionUnsupported,
  describeTemplate,
  makeWorkflowRoutes,
  templateSummary,
  type WorkflowDb,
} from './workflow-routes.js';
import { findTemplateById } from '../workflows/registry.js';

const BACKEND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LTX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HUNYUAN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SDXL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const NODE_CLASSES = [
  'BasicGuider',
  'BasicScheduler',
  'CLIPTextEncode',
  'EmptyHunyuanLatentVideo',
  'EmptyLTXVLatentVideo',
  'EmptyLatentImage',
  'FluxGuidance',
  'KSampler',
  'KSamplerSelect',
  'LTXVConditioning',
  'LTXVImgToVideo',
  'LTXVPreprocess',
  'LTXVScheduler',
  'LoadImage',
  'ModelSamplingSD3',
  'RandomNoise',
  'SamplerCustom',
  'SamplerCustomAdvanced',
  'SaveImage',
  'SaveWEBM',
  'VAEDecode',
  'VAEDecodeTiled',
  'VAEEncode',
];

function liveInfo(): ObjectInfo {
  const info: ObjectInfo = {
    CheckpointLoaderSimple: {
      input: {
        required: {
          ckpt_name: [['SDXL\\sd_xl_base_1.0.safetensors', 'hunyuan_video_720p_fp8_e4m3fn.safetensors'], {}],
        },
      },
    },
    UNETLoader: { input: { required: { unet_name: [['ltx-video-2b-v0.9.1.safetensors'], {}] } } },
    CLIPLoader: { input: { required: { clip_name: [[], {}] } } },
    DualCLIPLoader: { input: { required: { clip_name1: [[], {}], clip_name2: [[], {}] } } },
    VAELoader: { input: { required: { vae_name: [['pixel_space'], {}] } } },
  };
  for (const nodeClass of NODE_CLASSES) info[nodeClass] = { input: { required: {} } };
  return info;
}

interface Tables {
  models: Array<{ id: string; display_name: string; filename: string; base_model: string | null; type: string; backend_ids: string[] }>;
  backends: Array<{ id: string; name: string; base_url: string; status: string }>;
  pins: Array<{ model_id: string; capability: string; template_id: string }>;
}

function fakeDb(t: Tables): WorkflowDb {
  const query = (async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM models m')) {
      return t.models.filter((m) => m.id === params[0]);
    }
    if (sql.startsWith('SELECT capability, template_id FROM model_workflows')) {
      return t.pins.filter((p) => p.model_id === params[0]);
    }
    if (sql.startsWith('SELECT template_id FROM model_workflows')) {
      return t.pins.filter((p) => p.model_id === params[0] && p.capability === params[1]);
    }
    if (sql.includes('FROM backends') && sql.includes('= ANY')) {
      const ids = params[0] as string[];
      const rows = t.backends.filter((b) => ids.includes(b.id));
      return sql.includes("status = 'online'") ? rows.filter((b) => b.status === 'online') : rows;
    }
    if (sql.includes('FROM backends WHERE id = $1')) {
      return t.backends.filter((b) => b.id === params[0]);
    }
    if (sql.startsWith('DELETE FROM model_workflows')) {
      t.pins = t.pins.filter((p) => !(p.model_id === params[0] && p.capability === params[1]));
      return [];
    }
    if (sql.startsWith('INSERT INTO model_workflows')) {
      const [model_id, capability, template_id] = params as [string, string, string];
      t.pins = t.pins.filter((p) => !(p.model_id === model_id && p.capability === capability));
      t.pins.push({ model_id, capability, template_id });
      return [];
    }
    if (sql.startsWith('DELETE FROM models')) {
      t.models = t.models.filter((m) => m.id !== params[0]);
      return [];
    }
    throw new Error(`unexpected sql: ${sql}`);
  }) as WorkflowDb['query'];
  return {
    query,
    queryOne: (async (sql: string, params?: unknown[]) => (await query(sql, params))[0] ?? null) as WorkflowDb['queryOne'],
  };
}

function tables(): Tables {
  return {
    models: [
      { id: LTX, display_name: 'LTX Video 2b', filename: 'ltx-video-2b-v0.9.1.safetensors', base_model: 'ltx-video', type: 'checkpoint', backend_ids: [BACKEND] },
      { id: HUNYUAN, display_name: 'Hunyuan Video 720p', filename: 'hunyuan_video_720p_fp8_e4m3fn.safetensors', base_model: 'hunyuan-video', type: 'checkpoint', backend_ids: [BACKEND] },
      { id: SDXL, display_name: 'SDXL Base', filename: 'SDXL\\sd_xl_base_1.0.safetensors', base_model: 'sdxl', type: 'checkpoint', backend_ids: [BACKEND] },
    ],
    backends: [{ id: BACKEND, name: 'desktop-6900xt', base_url: 'http://backend:8188', status: 'online' }],
    pins: [],
  };
}

async function server(as: { id: string; role: 'admin' | 'user' } | null, t = tables(), deps: Parameters<typeof makeWorkflowRoutes>[0] = {}) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    req.user = as as never;
  });
  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) await reply.code(401).send({ error: 'unauthorized' });
  });
  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    if (req.user.role !== 'admin') await reply.code(403).send({ error: 'forbidden' });
  });
  await app.register(
    makeWorkflowRoutes({ db: fakeDb(t), objectInfoFor: async () => liveInfo(), ...deps }),
  );
  return { app, t };
}

const admin = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' as const };
const user = { id: '22222222-2222-4222-8222-222222222222', role: 'user' as const };

describe('template summaries', () => {
  it('say where each graph loads the model from', () => {
    expect(templateSummary(findTemplateById('txt2vid-ltxv')!).loaderFolder).toBe('checkpoints');
    const dm = templateSummary(findTemplateById('txt2vid-ltxv-dm')!);
    expect(dm.loaderFolder).toBe('diffusion_models');
    // Graph order, and JSON puts integer-like node ids in ascending order.
    expect(dm.loaderFolders).toEqual(['diffusion_models', 'text_encoders', 'vae']);
    expect(dm.requires.map((r) => r.label)).toEqual(['T5 text encoder', 'LTX-Video VAE']);
  });

  it('describe a generic graph as a guess and a specific one as authored', () => {
    expect(describeTemplate(findTemplateById('txt2img-sd-generic')!)).toContain('best guess');
    expect(describeTemplate(findTemplateById('txt2vid-hunyuan')!)).toContain('written for hunyuan-video');
    expect(describeTemplate(findTemplateById('txt2vid-hunyuan')!)).toContain('diffusion_models/');
  });
});

describe('GET /workflows/templates', () => {
  it('lists every template and needs a session', async () => {
    const { app } = await server(user);
    const res = await app.inject({ method: 'GET', url: '/workflows/templates' });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { templates: { id: string }[] }).templates.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['txt2img-sdxl', 'txt2vid-ltxv', 'txt2vid-ltxv-dm', 'img2vid-ltxv-dm', 'txt2vid-hunyuan']));
    const anon = await server(null);
    expect((await anon.app.inject({ method: 'GET', url: '/workflows/templates' })).statusCode).toBe(401);
  });
});

describe('GET /models/:id/workflows', () => {
  it('judges the LTX file by each graph separately, and knows which is automatic', async () => {
    const { app } = await server(user);
    const res = await app.inject({ method: 'GET', url: `/models/${LTX}/workflows` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ModelWorkflows;
    expect(body.model.folder).toBe('diffusion_models');
    expect(body.backend?.name).toBe('desktop-6900xt');

    const byId = Object.fromEntries(body.options.map((o) => [o.template.id, o]));
    // The checkpoints graph cannot see a file in diffusion_models…
    expect(byId['txt2vid-ltxv']!.verdict.status).toBe('wrong-folder');
    expect(byId['txt2vid-ltxv']!.automatic).toBe(false);
    // …the diffusion_models graph can, and names what it still needs.
    expect(byId['txt2vid-ltxv-dm']!.verdict.status).toBe('needs-companion');
    expect(byId['txt2vid-ltxv-dm']!.verdict.missing.map((m) => m.loader).sort()).toEqual(['CLIPLoader', 'VAELoader']);
    expect(byId['txt2vid-ltxv-dm']!.automatic).toBe(true);
    expect(byId['img2vid-ltxv-dm']!.automatic).toBe(true);
    expect(body.assigned).toEqual({});
  });

  it('tells the Hunyuan file it is in the wrong folder for its only graph', async () => {
    const { app } = await server(user);
    const body = (await app.inject({ method: 'GET', url: `/models/${HUNYUAN}/workflows` })).json() as ModelWorkflows;
    expect(body.model.folder).toBe('checkpoints');
    expect(body.options.map((o) => o.template.id)).toEqual(['txt2vid-hunyuan']);
    expect(body.options[0]!.verdict.status).toBe('wrong-folder');
    expect(body.options[0]!.verdict.detail).toContain('needs moving');
  });

  it('404s an unknown model and an unknown backend', async () => {
    const { app } = await server(user);
    expect((await app.inject({ method: 'GET', url: `/models/${BACKEND}/workflows` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/models/${LTX}/workflows?backendId=${LTX}` })).statusCode).toBe(404);
  });
});

describe('PUT /models/:id/workflows', () => {
  it('is admin only', async () => {
    const { app } = await server(user);
    const res = await app.inject({ method: 'PUT', url: `/models/${LTX}/workflows`, payload: { capability: 'txt2vid', templateId: 'txt2vid-ltxv' } });
    expect(res.statusCode).toBe(403);
  });

  it('pins a template, reports it, and unpins with null', async () => {
    const { app } = await server(admin);
    const pin = await app.inject({ method: 'PUT', url: `/models/${LTX}/workflows`, payload: { capability: 'txt2vid', templateId: 'txt2vid-ltxv' } });
    expect(pin.statusCode).toBe(200);
    expect(pin.json()).toEqual({ assigned: { txt2vid: 'txt2vid-ltxv' } });

    const body = (await app.inject({ method: 'GET', url: `/models/${LTX}/workflows` })).json() as ModelWorkflows;
    const pinned = body.options.find((o) => o.template.id === 'txt2vid-ltxv')!;
    expect(pinned.assigned).toBe(true);
    // Automatic is reported as what the rules would pick, unchanged by the pin.
    expect(body.options.find((o) => o.template.id === 'txt2vid-ltxv-dm')!.automatic).toBe(true);

    const unpin = await app.inject({ method: 'PUT', url: `/models/${LTX}/workflows`, payload: { capability: 'txt2vid', templateId: null } });
    expect(unpin.json()).toEqual({ assigned: {} });
  });

  it('refuses a template of the wrong capability or the wrong family', async () => {
    const { app } = await server(admin);
    const wrongKind = await app.inject({ method: 'PUT', url: `/models/${LTX}/workflows`, payload: { capability: 'txt2vid', templateId: 'img2vid-ltxv' } });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json().message).toContain('img2vid template');
    const wrongFamily = await app.inject({ method: 'PUT', url: `/models/${SDXL}/workflows`, payload: { capability: 'txt2vid', templateId: 'txt2vid-ltxv' } });
    expect(wrongFamily.statusCode).toBe(400);
    expect(wrongFamily.json().message).toContain('not written for sdxl');
    const unknown = await app.inject({ method: 'PUT', url: `/models/${LTX}/workflows`, payload: { capability: 'txt2vid', templateId: 'nope' } });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('DELETE /models/:id', () => {
  it('is admin only', async () => {
    const { app } = await server(user);
    expect((await app.inject({ method: 'DELETE', url: `/models/${LTX}` })).statusCode).toBe(403);
  });

  it('removes the record and says the file is still on the backend', async () => {
    const { app, t } = await server(admin);
    const res = await app.inject({ method: 'DELETE', url: `/models/${HUNYUAN}` });
    expect(res.statusCode).toBe(200);
    const { removal } = res.json() as { removal: ModelRemoval };
    expect(removal.removed).toBe(true);
    expect(removal.removedFromDisk).toBe(false);
    expect(removal.note).toContain('desktop-6900xt (checkpoints/hunyuan_video_720p_fp8_e4m3fn.safetensors)');
    expect(removal.note).toContain('list the model again');
    expect(t.models.some((m) => m.id === HUNYUAN)).toBe(false);
  });

  it('reports a clean removal when a backend can delete the file', async () => {
    const deleted: string[] = [];
    const { app } = await server(admin, tables(), {
      deleteBackendFile: async (_url, folder, filename) => {
        deleted.push(`${folder}/${filename}`);
      },
    });
    const { removal } = (await app.inject({ method: 'DELETE', url: `/models/${LTX}` })).json() as { removal: ModelRemoval };
    expect(removal.removedFromDisk).toBe(true);
    expect(removal.note).toBeNull();
    expect(deleted).toEqual(['diffusion_models/ltx-video-2b-v0.9.1.safetensors']);
  });

  it('the default hook refuses, by design', async () => {
    await expect(
      (await import('./workflow-routes.js')).deleteBackendFile('http://x', 'checkpoints', 'a.safetensors', 'box'),
    ).rejects.toBeInstanceOf(BackendFileDeletionUnsupported);
  });
});
