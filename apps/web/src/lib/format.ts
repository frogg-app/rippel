import type { Backend } from '@comfy/shared';

const GB = 1024 * 1024 * 1024;

/** One decimal place, so `18.2/36.5 GB` lines up in the mono face. */
export function gb(bytes: number): string {
  return (bytes / GB).toFixed(1);
}

export interface MemoryReading {
  /**
   * e.g. "18.2/36.5 GB", or just the total when the backend has not told us
   * how much is free. The number only — the caller adds the word that says
   * what kind of number it is.
   */
  text: string;
  /**
   * Why that number is what it is. The figure ComfyUI reports is a usable
   * *budget*, not the card's physical size — ROCm and unified-memory systems
   * pool host RAM into it, so a 16 GB card can report 36 GB (see the comment on
   * `Backend.vramTotal`). Labelling it "VRAM installed" would be a lie, so the
   * pill shows the number and this sentence explains it on hover.
   */
  title: string;
  /** Whether an operator has overridden the reported figure. */
  isOperatorBudget: boolean;
}

/**
 * Turn a backend's memory fields into something honest to show in the pill.
 * Returns null when the backend has never reported memory (offline, or polled
 * before it answered) — the caller should show nothing rather than "0.0 GB".
 */
export function memoryReading(backend: Backend): MemoryReading | null {
  // An admin-set limit wins: it exists precisely because the reported total was
  // misleading on this machine.
  if (backend.vramLimitMb !== null) {
    const total = backend.vramLimitMb * 1024 * 1024;
    const used = backend.vramFree === null ? null : Math.max(0, total - backend.vramFree);
    return {
      text: used === null ? `${gb(total)} GB` : `${gb(used)}/${gb(total)} GB`,
      title: `Memory budget set for ${backend.name} by an administrator (${backend.vramLimitMb} MB).`,
      isOperatorBudget: true,
    };
  }

  if (backend.vramTotal === null) return null;

  const used = backend.vramFree === null ? null : Math.max(0, backend.vramTotal - backend.vramFree);
  return {
    text: used === null ? `${gb(backend.vramTotal)} GB` : `${gb(used)}/${gb(backend.vramTotal)} GB`,
    title:
      'Memory as reported by the backend — a usable budget, not the size of the card. ' +
      'ROCm and unified-memory systems pool host RAM into this figure.',
    isOperatorBudget: false,
  };
}

/** "2 in queue" / "1 in queue". */
export function queueLabel(depth: number): string {
  return `${depth} in queue`;
}

/** Initial for the avatar chip: display name first, then the email. */
export function initial(name: string | null, email: string): string {
  const source = name?.trim() || email;
  return (source[0] ?? '?').toUpperCase();
}
