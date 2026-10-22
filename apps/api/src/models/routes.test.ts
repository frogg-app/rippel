import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./metadata.js', () => ({ withCatalogueInfo: vi.fn(), previewBytes: vi.fn() }));
vi.mock('../orchestrator/preflight.js', () => ({ objectInfoFor: vi.fn() }));
vi.mock('../db.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() }));
vi.mock('./installs.js', async () => ({ ...await vi.importActual('./installs.js'), requireTransport: vi.fn(), startInstall: vi.fn() }));
import { queryOne } from '../db.js';
import { requireTransport, startInstall } from './installs.js';
import { TransportBusy, TransportError } from './transport.js';
import modelInstallRoutes from './routes.js';
afterEach(() => vi.resetAllMocks());
it.each([
  [new TransportBusy('Wait for the current download to finish.'), 409, 'conflict'],
  [new TransportError('The agent is unreachable.'), 502, 'backend_error'],
] as const)('preserves the install refusal message for %s', async (error, status, code) => {
  const server = Fastify();
  server.decorate('requireAdmin', async (req: { user?: unknown }) => { req.user = { id: 'admin' }; });
  server.decorate('requireAuth', async () => {});
  await server.register(modelInstallRoutes);
  vi.mocked(queryOne).mockResolvedValue({ id: 'backend', name: 'Desktop', base_url: 'http://desktop:8188' });
  vi.mocked(requireTransport).mockResolvedValue({ catalogue: async () => [{ ref: 'checkpoints/svd.safetensors' }] } as never);
  vi.mocked(startInstall).mockRejectedValue(error);
  try {
    const response = await server.inject({ method: 'POST', url: '/backends/backend/models', payload: { ref: 'checkpoints/svd.safetensors' } });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: code, message: error.message });
  } finally { await server.close(); }
});

it('merges cached Hugging Face discoveries into the normal catalogue without fetching the Hub', async () => {
  const { huggingFaceEntry } = await import('./hugging-face-catalogue.js');
  const { withCatalogueInfo } = await import('./metadata.js');
  const { objectInfoFor } = await import('../orchestrator/preflight.js');
  vi.mocked(withCatalogueInfo).mockImplementation(async entries => ({ entries, pending: 0 }));
  vi.mocked(objectInfoFor).mockResolvedValue({});
  const model = huggingFaceEntry({ id: 'krea/Krea-2-Turbo', pipeline_tag: 'text-to-image', gated: 'auto' });
  vi.mocked(queryOne).mockResolvedValueOnce({ id: 'backend', name: 'Desktop', base_url: 'http://desktop:8188' }).mockResolvedValueOnce({ entries: [model] });
  vi.mocked(requireTransport).mockResolvedValue({ catalogue: async () => [] } as never);
  const server = Fastify();
  server.decorate('requireAdmin', async () => {});
  server.decorate('requireAuth', async () => {});
  await server.register(modelInstallRoutes);
  try {
    const response = await server.inject('/backends/backend/catalogue');
    expect(response.statusCode).toBe(200);
    expect(response.json().entries[0]).toMatchObject({ name: 'krea/Krea-2-Turbo', installBlockedReason: expect.stringContaining('Access required'), runnability: { status: 'unknown', backendId: 'backend' } });
  } finally { await server.close(); }
});

it('does not turn a discovered repository into an arbitrary install URL', async () => {
  vi.mocked(queryOne).mockResolvedValue({ id: 'backend', name: 'Desktop', base_url: 'http://desktop:8188' });
  vi.mocked(requireTransport).mockResolvedValue({ catalogue: async () => [] } as never);
  const server = Fastify();
  server.decorate('requireAdmin', async () => {});
  server.decorate('requireAuth', async () => {});
  await server.register(modelInstallRoutes);
  try {
    const response = await server.inject({ method: 'POST', url: '/backends/backend/models', payload: { ref: 'hugging-face:krea/Krea-2-Turbo' } });
    expect(response.statusCode).toBe(400);
    expect(startInstall).not.toHaveBeenCalled();
  } finally { await server.close(); }
});

async function serverWithGgufRepo(transportKind: string) {
  const { huggingFaceEntry } = await import('./hugging-face-catalogue.js');
  const { objectInfoFor } = await import('../orchestrator/preflight.js');
  vi.mocked(objectInfoFor).mockResolvedValue({});
  const model = huggingFaceEntry({
    id: 'city96/FLUX.1-dev-gguf',
    pipeline_tag: 'text-to-image',
    siblings: ['flux1-dev-Q8_0.gguf', 'flux1-dev-Q4_K_S.gguf'].map((rfilename) => ({ rfilename })),
  });
  vi.mocked(queryOne)
    .mockResolvedValueOnce({ id: 'backend', name: 'Desktop', base_url: 'http://desktop:8188', vram_total: '12000000000', vram_limit_mb: null })
    .mockResolvedValueOnce({ entries: [model] });
  vi.mocked(requireTransport).mockResolvedValue({ kind: transportKind, catalogue: async () => [] } as never);
  vi.mocked(startInstall).mockResolvedValue({ id: 'install' } as never);
  const server = Fastify();
  server.decorate('requireAdmin', async (req: { user?: unknown }) => { req.user = { id: 'admin' }; });
  server.decorate('requireAuth', async () => {});
  await server.register(modelInstallRoutes);
  return server;
}

it('installs the version of a Hugging Face model somebody chose, on an agent machine', async () => {
  const server = await serverWithGgufRepo('rippel-agent');
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/backends/backend/models',
      payload: { ref: 'hugging-face:city96/FLUX.1-dev-gguf', variant: 'flux1-dev-Q4_K_S.gguf' },
    });
    expect(response.statusCode).toBe(202);
    expect(vi.mocked(startInstall).mock.calls[0]![0].entry).toMatchObject({
      filename: 'flux1-dev-Q4_K_S.gguf',
      url: 'https://huggingface.co/city96/FLUX.1-dev-gguf/resolve/main/flux1-dev-Q4_K_S.gguf',
      savePath: 'diffusion_models',
    });
  } finally { await server.close(); }
});

it('refuses a Hugging Face install where only ComfyUI-Manager can download', async () => {
  const server = await serverWithGgufRepo('comfyui-manager');
  try {
    const response = await server.inject({ method: 'POST', url: '/backends/backend/models', payload: { ref: 'hugging-face:city96/FLUX.1-dev-gguf' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('rippel agent');
    expect(startInstall).not.toHaveBeenCalled();
  } finally { await server.close(); }
});

it('lists a model\'s versions with sizes and recommends the one that fits', async () => {
  const server = await serverWithGgufRepo('rippel-agent');
  const fetchMock = vi.fn(async () =>
    Response.json([
      { type: 'file', path: 'flux1-dev-Q8_0.gguf', size: 135, lfs: { oid: 'aa', size: 12.7e9 } },
      { type: 'file', path: 'flux1-dev-Q4_K_S.gguf', size: 135, lfs: { oid: 'bb', size: 6.8e9 } },
    ]),
  );
  vi.stubGlobal('fetch', fetchMock);
  try {
    const response = await server.inject('/backends/backend/catalogue/variants?ref=hugging-face:city96/FLUX.1-dev-gguf');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.memoryBytes).toBe(12e9);
    // 12.7 GB does not fit a 12 GB card; the Q4 does.
    expect(body.variants).toEqual([
      expect.objectContaining({ filename: 'flux1-dev-Q8_0.gguf', sizeBytes: 12.7e9, sha256: 'aa', recommended: false }),
      expect.objectContaining({ filename: 'flux1-dev-Q4_K_S.gguf', sizeBytes: 6.8e9, recommended: true }),
    ]);
  } finally {
    vi.unstubAllGlobals();
    await server.close();
  }
});
