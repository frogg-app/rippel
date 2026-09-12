/**
 * How hard a machine should try to fit a job in its graphics memory.
 *
 * ## The problem this exists for
 *
 * A 16 GB card cannot hold a 14B video model. It can still *run* one, slowly,
 * if ComfyUI is told to keep the weights in system RAM and stream them onto the
 * card a layer at a time. The difference between "this model is impossible
 * here" and "this model takes four minutes instead of one" is a launch flag,
 * and until now rippel had no way to set it: `comfyArgs` existed on the agent
 * and nothing ever wrote to it.
 *
 * That is the whole point. The reference machine has 16 GB of VRAM and 64 GB of
 * system RAM, and the second number is the one that decides what is possible.
 *
 * ## Why a profile rather than a flag box
 *
 * Exposing raw ComfyUI arguments would be simpler to build and worse to own:
 * they change between versions, several of them are mutually exclusive, and a
 * typo produces a ComfyUI that will not start with no clue as to why. A closed
 * set of four means the panel can describe the trade in a sentence, and the
 * only thing a person has to decide is how much slowness they will accept.
 *
 * ## The flags
 *
 * Long-standing ComfyUI arguments, and `--cpu-vae` is the one the reference box
 * was already being launched with by hand before any of this existed.
 *
 * **Unverified against a live `main.py --help`** — the reference backend has
 * been unreachable throughout this change, and `MODELS_PLAN.md`'s ground rules
 * ask for that check. `profileArgs` is therefore written so the check is one
 * table to read, and a wrong flag is recoverable: the agent keeps the previous
 * `comfyArgs` until a restart succeeds, and the panel shows the ComfyUI log.
 */

import type { MemoryProfile } from '@comfy/shared';

/** What each profile asks ComfyUI to do, and what it costs. */
export interface ProfileSpec {
  id: MemoryProfile;
  label: string;
  /** One sentence for the panel: what it does, and what it costs. */
  blurb: string;
  args: readonly string[];
}

export const MEMORY_PROFILES: readonly ProfileSpec[] = [
  {
    id: 'fast',
    label: 'Fast',
    blurb: 'Keep everything on the card. Fastest, and fails outright on a model that will not fit.',
    args: [],
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb:
      'Hold a gigabyte back so the desktop and the browser do not push a job over the edge. The default.',
    // Reserving a little is what stops the *other* things on a desktop — a
    // compositor, a browser with hardware acceleration — turning a job that
    // fits in isolation into one that does not.
    args: ['--reserve-vram', '1'],
  },
  {
    id: 'low-vram',
    label: 'Low VRAM',
    blurb: 'Stream the model from system memory a layer at a time. Slower, and runs much bigger models.',
    args: ['--lowvram'],
  },
  {
    id: 'minimal-vram',
    label: 'Minimal VRAM',
    blurb: 'Keep almost nothing on the card. Very slow, and runs anything that fits in system memory.',
    args: ['--novram'],
  },
];

export const DEFAULT_PROFILE: MemoryProfile = 'balanced';

export function specFor(profile: MemoryProfile): ProfileSpec {
  return MEMORY_PROFILES.find((spec) => spec.id === profile) ?? MEMORY_PROFILES[1]!;
}

/**
 * The `comfyArgs` string for a profile, plus the VAE choice.
 *
 * `--cpu-vae` is separate from the profile because it is a different trade.
 * Decoding on the CPU is slow in a way the profiles are not — it is the last
 * stage, it is one big allocation, and on a card that is merely *tight* rather
 * than too small, moving only the decode off it is often the whole fix. So it
 * is its own switch and can be combined with any profile.
 *
 * Built as a whole string rather than merged into whatever was there before.
 * Merging would mean parsing arguments we did not write and guessing which of
 * them we are allowed to remove; this way what rippel set is exactly what
 * rippel can describe, and anything an operator added by hand they can add to
 * the config file the agent reads.
 */
export function profileArgs(profile: MemoryProfile, cpuVae: boolean): string {
  const args = [...specFor(profile).args];
  if (cpuVae) args.push('--cpu-vae');
  return args.join(' ');
}
