/**
 * The memory profile that applies to jobs on one backend.
 *
 * The profile is stored on the *deployment* — the machine rippel manages —
 * while a job is dispatched to a *backend*, the ComfyUI registration. The two
 * are one row apart, and keeping them apart is deliberate: a backend can be a
 * ComfyUI nobody deployed (an address an operator typed in), and such a backend
 * has no agent, no launch flags under our control, and therefore no profile.
 *
 * Returns null for exactly that case, which callers read as "change nothing".
 * That is not a fallback to `balanced`: balanced means "we asked for a reserve"
 * and null means "we have no say here", and rewriting a graph on the strength
 * of a profile we never applied to the machine would be the worse mistake.
 */

import type { MemoryProfile, Uuid } from '@comfy/shared';
import { queryOne } from '../db.js';
import type { OffloadSettings } from '../workflows/offload.js';

export async function memoryProfileForBackend(
  backendId: Uuid,
): Promise<OffloadSettings | null> {
  const row = await queryOne<{ memory_profile: MemoryProfile; cpu_vae: boolean }>(
    'SELECT memory_profile, cpu_vae FROM deployments WHERE backend_id = $1',
    [backendId],
  );
  if (!row) return null;
  return { profile: row.memory_profile, cpuVae: row.cpu_vae };
}
