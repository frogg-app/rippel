/**
 * Where a floating panel goes when it hangs off a trigger.
 *
 * Shared by the dropdown and the extra-styles picker because both have the
 * same three problems and there should be one answer to each:
 *
 *  - an ancestor with `overflow: hidden` must not clip it, which is why the
 *    caller portals the panel to <body> and this returns *viewport*
 *    coordinates for `position: fixed`;
 *  - it must not run off the bottom of the screen, so it flips above the
 *    trigger when below genuinely cannot hold it and clamps its height to the
 *    space that exists either way;
 *  - it must survive a narrow window, so its width is clamped to the viewport
 *    and its left edge is pushed back inside.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface AnchoredPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  /** True when the panel was flipped above the trigger. */
  up: boolean;
}

export interface AnchorOptions {
  /** Tallest the panel may be, space permitting. */
  maxHeight?: number;
  /** Below this, "below the trigger" counts as no room at all. */
  minHeight?: number;
  /** Narrowest the panel may be, regardless of the trigger's width. */
  minWidth?: number;
  /** Fixed width, ignoring the trigger's. */
  width?: number;
  align?: 'start' | 'end';
  /** Gap between trigger and panel. */
  offset?: number;
}

const VIEWPORT_MARGIN = 8;
/** How much roomier the far side must be before the panel flips to it. */
const FLIP_MARGIN = 48;

export function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: AnchorOptions = {},
): AnchoredPosition | null {
  const {
    maxHeight: maxHeightCap = 320,
    minHeight = 120,
    minWidth = 168,
    width: fixedWidth,
    align = 'start',
    offset = 4,
  } = options;

  const [position, setPosition] = useState<AnchoredPosition | null>(null);
  // Options arrive as a fresh object every render; hold them in a ref so the
  // measure callback is stable and the scroll listener is bound once.
  const settings = useRef({ maxHeightCap, minHeight, minWidth, fixedWidth, align, offset });
  settings.current = { maxHeightCap, minHeight, minWidth, fixedWidth, align, offset };

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const config = settings.current;
    const rect = anchor.getBoundingClientRect();
    const viewportH = window.innerHeight || 0;
    const viewportW = window.innerWidth || 0;

    const below = viewportH - rect.bottom - VIEWPORT_MARGIN - config.offset;
    const above = rect.top - VIEWPORT_MARGIN - config.offset;
    // Which side to open on.
    //
    // Below, unless below cannot show the whole panel and above can show
    // meaningfully more of it. The first version only flipped when below was
    // unusable, which left a trigger low in a long panel opening downward into
    // a 240px slot — scrolling a four-row list — while 600px sat unused
    // overhead. The 48px margin is hysteresis: flipping for a few pixels'
    // gain is more jarring than a scrollbar.
    const cramped = below < config.maxHeightCap;
    const up = (below < config.minHeight || cramped) && above > below + FLIP_MARGIN;
    const space = Math.max(up ? above : below, config.minHeight);
    const maxHeight = Math.min(config.maxHeightCap, space);

    const wanted = config.fixedWidth ?? Math.max(rect.width, config.minWidth);
    const width = Math.min(wanted, Math.max(viewportW - VIEWPORT_MARGIN * 2, 120));

    let left = config.align === 'end' ? rect.right - width : rect.left;
    left = Math.min(left, viewportW - width - VIEWPORT_MARGIN);
    left = Math.max(left, VIEWPORT_MARGIN);

    const top = up
      ? Math.max(rect.top - maxHeight - config.offset, VIEWPORT_MARGIN)
      : rect.bottom + config.offset;

    setPosition((current) =>
      current &&
      current.top === top &&
      current.left === left &&
      current.width === width &&
      current.maxHeight === maxHeight &&
      current.up === up
        ? current
        : { top, left, width, maxHeight, up },
    );
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onChange = () => measure();
    // Capture, so scrolling any ancestor pane moves the panel with its trigger.
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  }, [open, measure]);

  return position;
}

/** Close when a pointer goes down outside every one of `refs`. */
export function useDismissOnOutside(
  active: boolean,
  refs: RefObject<HTMLElement | null>[],
  onDismiss: () => void,
) {
  const held = useRef({ refs, onDismiss });
  held.current = { refs, onDismiss };

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (held.current.refs.some((ref) => ref.current?.contains(target))) return;
      held.current.onDismiss();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [active]);
}
