/**
 * Where "Find one" goes from the Create screen.
 *
 * Every dead end on this screen — no model for this mode, no style add-on for
 * this model — ends in a link to Models → Discover, already filtered to what
 * was missing. The URL is built with Discover's own `writeDiscover`, so these
 * links mean exactly what the filter chips there mean and cannot drift from
 * its grammar.
 *
 * They open on Discover's intent chips (Make images, Make video, Style
 * add-ons), which judge an entry by what it can actually do on this machine
 * rather than by a task tag its model page may not carry yet. The family, when
 * known, is a visible, removable tag chip.
 */
import { DEFAULT_DISCOVER, tagKey, writeDiscover } from '../models/discover';
import type { Intent } from '../models/intents';
import type { CreateMode } from './mode';

const INTENT: Record<CreateMode, Intent> = { image: 'images', video: 'video' };

function discoverHref(state: Partial<typeof DEFAULT_DISCOVER>): string {
  const params = writeDiscover(new URLSearchParams({ tab: 'discover' }), {
    ...DEFAULT_DISCOVER,
    ...state,
  });
  return `/models?${params.toString()}`;
}

/** Models that make pictures, or videos. */
export function findModelsHref(mode: CreateMode): string {
  return discoverHref({ intent: INTENT[mode], type: null });
}

/** Style add-ons, for this family when we know it. */
export function findStylesHref(family: string | null): string {
  return discoverHref({
    intent: 'styles',
    include: family ? [tagKey('base', family)] : [],
  });
}
