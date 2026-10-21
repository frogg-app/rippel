/** Only publisher metadata supplies checksums. A 40-character Git object ID
 * is not a file SHA-256 and must never be passed to the agent as one. */
import type { WorkflowFile } from '../library/workflows/manifest.js';
export async function verifiedFile(file: WorkflowFile, fetchImpl: typeof fetch = fetch): Promise<WorkflowFile & { sha256: string; sizeBytes: number }> {
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['huggingface.co', 'civitai.com'].includes(url.hostname)) throw new Error(`Unsupported download source for ${file.name}.`);
  if (file.sha256 && /^[a-f0-9]{64}$/i.test(file.sha256) && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes! > 0) {
    return { ...file, sha256: file.sha256, sizeBytes: file.sizeBytes! };
  }
  if (url.hostname !== 'huggingface.co') throw new Error(`No verified checksum and size are available for ${file.name}.`);
  const response = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) throw new Error(`Access to ${file.name} requires permission on Hugging Face. Authenticated model downloads are not supported yet.`);
  if (response.status >= 400) throw new Error(`Publisher metadata for ${file.name} returned HTTP ${response.status}.`);
  const sha256 = (response.headers.get('x-linked-etag') ?? response.headers.get('etag') ?? '').replace(/^"|"$/g, '');
  const sizeBytes = Number(response.headers.get('x-linked-size') ?? (response.ok ? response.headers.get('content-length') : null));
  if (!/^[a-f0-9]{64}$/i.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Publisher did not supply a file SHA-256 and size for ${file.name}.`);
  }
  return { ...file, sha256, sizeBytes };
}
