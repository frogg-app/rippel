/**
 * Where "Find one" goes from the Create screen.
 *
 * Every dead end on this screen — no model for this mode, no style add-on for
 * this model — ends in a link to Models → Discover, already filtered to what
 * was missing. The URL is built with Discover's own `writeDiscover`, so these
 * links mean exactly what the filter chips there mean and cannot drift from
 * its grammar.
 *
 * Discover has no "intent" parameter, so the intent is spelled as a task tag
 * (HuggingFace's own `text-to-video`) or a type. Both are visible, removable
 * chips once Discover opens, which matters: a catalogue entry whose metadata
 * has not been swept carries no task tag, and someone who lands on an empty
 * list must be able to see why and clear it.
 */
import { DEFAULT_DISCOVER, tagKey, writeDiscover } from '../models/discover';
import type { CreateMode } from './mode';

const TASK: Record<CreateMode, string> = { image: 'text-to-image', video: 'text-to-video' };

function discoverHref(state: Partial<typeof DEFAULT_DISCOVER>): string {
  const params = writeDiscover(new URLSearchParams({ tab: 'discover' }), {
    ...DEFAULT_DISCOVER,
    ...state,
  });
  return `/models?${params.toString()}`;
}

/** Models that make pictures, or videos. */
export function findModelsHref(mode: CreateMode): string {
  return discoverHref({ include: [tagKey('task', TASK[mode])], type: null });
}

/** Style add-ons, for this family when we know it. */
export function findStylesHref(family: string | null): string {
  return discoverHref({
    type: 'lora',
    include: family ? [tagKey('base', family)] : [],
  });
}
