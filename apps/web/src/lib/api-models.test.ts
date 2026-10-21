import { afterEach, expect, it, vi } from 'vitest';
import { modelsApi } from './api-models';
afterEach(() => vi.unstubAllGlobals());
it('preserves the busy-machine explanation when retrying an install', async () => {
  const message = 'This machine is already installing a model. Wait for it to finish, then try again.';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'conflict', message }, { status: 409 })));
  await expect(modelsApi.install('backend', 'checkpoints/svd.safetensors')).rejects.toMatchObject({ status: 409, message });
});
it('explains a gateway failure even when the response is not JSON', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })));
  await expect(modelsApi.install('backend', 'checkpoints/svd.safetensors')).rejects.toMatchObject({
    status: 502, message: 'The rippel server could not complete the request. Try again shortly.',
  });
});
