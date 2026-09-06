/**
 * Reading a finished prompt out of a backend and storing what it produced.
 *
 * `/history/<promptId>` is the authority on whether a job succeeded and what it
 * made. The socket tells us *when* to look; this decides what actually
 * happened. That split matters because the socket is lossy — a dropped
 * connection or a restarted API loses frames, and nothing about the job's real
 * outcome should depend on having seen them.
 */

import type { Asset } from '@comfy/shared';
import type { ComfyOutputRef } from '../lib/comfy.js';
import { fetchAndPersist } from '../storage/persist.js';

export type HistoryOutcome =
  | { state: 'pending' }
  | { state: 'success'; outputs: ComfyOutputRef[] }
  | { state: 'error'; message: string };

interface HistoryEntry {
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: [string, Record<string, unknown>][];
  };
  outputs?: Record<string, { images?: ComfyOutputRef[]; gifs?: ComfyOutputRef[] }>;
}

/**
 * What became of one prompt.
 *
 * A prompt id absent from /history is `pending` rather than an error: ComfyUI
 * only records an entry once execution finishes, so "not there" is the normal
 * state of a job that is still running — and also, unhelpfully, of a job the
 * backend forgot across its own restart. The caller distinguishes those by
 * elapsed time, not by this function.
 */
export async function readHistory(
  baseUrl: string,
  promptId: string,
): Promise<HistoryOutcome> {
  const res = await fetch(`${baseUrl}/history/${promptId}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { state: 'pending' };

  const body = (await res.json()) as Record<string, HistoryEntry>;
  const entry = body[promptId];
  if (!entry) return { state: 'pending' };

  const status = entry.status?.status_str;

  if (status === 'error') {
    // The useful detail is buried in the message list rather than the status
    // itself; without it the user gets "it failed" and nothing to act on.
    const error = entry.status?.messages?.find((m) => m[0] === 'execution_error')?.[1];
    const nodeType = error?.['node_type'];
    const message = error?.['exception_message'];
    return {
      state: 'error',
      message:
        typeof message === 'string'
          ? `${typeof nodeType === 'string' ? nodeType : 'A node'} failed: ${message}`
          : 'The backend reported the workflow failed.',
    };
  }

  if (status !== 'success') return { state: 'pending' };

  // Outputs are keyed by node id; a template may have more than one save node,
  // and video templates report under `gifs` rather than `images`.
  const outputs: ComfyOutputRef[] = [];
  for (const node of Object.values(entry.outputs ?? {})) {
    for (const ref of [...(node.images ?? []), ...(node.gifs ?? [])]) {
      // Live previews land in `temp` and are not results.
      if (ref.type && ref.type !== 'output') continue;
      outputs.push(ref);
    }
  }

  return { state: 'success', outputs };
}

/**
 * Pull every output of a finished job into our own storage.
 *
 * `fetchAndPersist` is idempotent per (jobId, filename), so running this twice
 * — which reconciliation after a restart will do — downloads nothing the second
 * time and returns the rows already recorded.
 */
export async function collectOutputs(params: {
  userId: string;
  jobId: string;
  backendUrl: string;
  outputs: ComfyOutputRef[];
  /**
   * Called before each download, 1-based, so the caller can say "Storing 2 of
   * 4". Reported before rather than after: the interesting part is what is
   * happening now, and the last file's several seconds would otherwise be
   * announced only once they were over.
   */
  onAsset?: (index: number, total: number) => void;
}): Promise<Asset[]> {
  const assets: Asset[] = [];

  // Sequential on purpose: these are multi-megabyte files off a machine that is
  // probably already starting the next job, and there is nothing to be gained
  // by making its disk seek for four of them at once.
  for (const [index, source] of params.outputs.entries()) {
    params.onAsset?.(index + 1, params.outputs.length);
    assets.push(
      await fetchAndPersist({
        userId: params.userId,
        jobId: params.jobId,
        backendUrl: params.backendUrl,
        source,
      }),
    );
  }

  return assets;
}
