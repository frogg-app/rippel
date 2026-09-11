import { expect, it, vi } from 'vitest';
import { verifiedFile } from './download-metadata.js';
const file = { name: 'model.safetensors', directory: 'vae', url: 'https://huggingface.co/a/b/resolve/main/model.safetensors', paths: [] };
it('uses publisher SHA-256 and actual linked size without following a redirect', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302,
    headers: { 'x-linked-etag': `"${'a'.repeat(64)}"`, 'x-linked-size': '123', location: 'https://untrusted.example/file' } }));
  expect(await verifiedFile(file, fetchMock)).toMatchObject({ sha256: 'a'.repeat(64), sizeBytes: 123 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'HEAD', redirect: 'manual' });
});
it('refuses non-SHA-256 etags, missing sizes and unapproved source URLs', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { headers: { etag: 'a'.repeat(40), 'content-length': '123' } }));
  await expect(verifiedFile(file, fetchMock)).rejects.toThrow('SHA-256');
  for (const url of ['http://huggingface.co/file', 'https://huggingface.co.evil.test/file', 'https://user@huggingface.co/file', 'https://civitai.com/file']) {
    await expect(verifiedFile({ ...file, url }, fetchMock)).rejects.toThrow();
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
