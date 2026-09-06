import { useEffect, useState } from 'react';
import {
  EPILOGUE_INK,
  LOCKUP_GAP,
  LOCKUP_SCALE,
  MARK_ART,
  MARK_INK,
  MARK_TILT,
  SMALL_CUT_BELOW,
  type MarkCut,
} from './mark-art';

/**
 * The rippel identity, in one place. Everything that draws the mark or the
 * name goes through here — the shell header, the sign-in card, the splash, the
 * favicon. Never re-typeset the word next to the mark by hand.
 *
 * The rule from the brand spec is *measure ink, never boxes*:
 *
 *  - The artwork fills only 58x69 of its 120x120 viewBox, so a mark "at 60px"
 *    would draw about 34px of visible ink and a third of any gap you set would
 *    be invisible padding. Both components take an **ink height** and trim the
 *    dead padding off with a negative offset.
 *  - Font metrics lie the same way, so the word's ink comes from the
 *    rasteriser for the exact string at the exact size, not from declared
 *    ascenders.
 *  - Both parts are then placed from one origin (the top of the text box at
 *    line-height 1) and absolutely positioned. They are never baseline-aligned:
 *    Chrome ignores margin-bottom when it synthesises the baseline of a
 *    replaced flex item, and the container's line-box strut pushes an
 *    inline-block child down while an absolutely-positioned sibling stays put.
 *    Both failures are silent and worth several pixels at small sizes.
 */

function pickCut(inkHeight: number, cut?: MarkCut): MarkCut {
  return cut ?? (inkHeight < SMALL_CUT_BELOW ? 'small' : 'fine');
}

/** The svg element's own size and the offsets that trim it back to its ink. */
function markGeometry(inkHeight: number, cut: MarkCut) {
  const ink = MARK_INK[cut];
  const box = (inkHeight * 120) / (ink.y1 - ink.y0);
  const k = box / 120;
  return { box, inkWidth: (ink.x1 - ink.x0) * k, trimLeft: ink.x0 * k, trimTop: ink.y0 * k };
}

function MarkSvg({ inkHeight, cut, style }: { inkHeight: number; cut: MarkCut; style: React.CSSProperties }) {
  const { box } = markGeometry(inkHeight, cut);
  return (
    <svg width={box} height={box} viewBox="0 0 120 120" style={style} aria-hidden focusable="false">
      <g transform={`rotate(${MARK_TILT} 60 60)`}>
        {MARK_ART[cut].map((path) => (
          <path key={path.fill} d={path.d} fill={path.fill} />
        ))}
      </g>
    </svg>
  );
}

/**
 * The mark alone, trimmed to its ink on every side — for the places too tight
 * for the lockup. `size` is ink height in pixels, not a box: 26px here draws
 * 26px of visible crescent.
 */
export function Mark({
  size = 26,
  cut,
  title,
}: {
  size?: number;
  cut?: MarkCut;
  title?: string;
}) {
  const chosen = pickCut(size, cut);
  const { inkWidth, trimLeft, trimTop } = markGeometry(size, chosen);
  return (
    <span
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{
        display: 'inline-block',
        position: 'relative',
        flexShrink: 0,
        width: inkWidth,
        height: size,
      }}
    >
      <MarkSvg
        inkHeight={size}
        cut={chosen}
        style={{ position: 'absolute', left: -trimLeft, top: -trimTop, display: 'block' }}
      />
    </span>
  );
}

type WordInk = { asc: number; desc: number; fbAsc: number; fbDesc: number };

let ctx: CanvasRenderingContext2D | null | undefined;

/** The word's ink, from the rasteriser — falling back to the measured Epilogue
 *  ratios wherever canvas metrics are unavailable (jsdom, a blocked canvas). */
function measureWord(px: number): WordInk {
  if (ctx === undefined) {
    try {
      ctx = document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
  }
  if (ctx) {
    ctx.font = `300 ${px}px 'Epilogue', sans-serif`;
    const t = ctx.measureText('rippel');
    if (t && t.actualBoundingBoxAscent) {
      return {
        asc: t.actualBoundingBoxAscent,
        desc: t.actualBoundingBoxDescent,
        fbAsc: t.fontBoundingBoxAscent,
        fbDesc: t.fontBoundingBoxDescent,
      };
    }
  }
  return {
    asc: px * EPILOGUE_INK.asc,
    desc: px * EPILOGUE_INK.desc,
    fbAsc: px * EPILOGUE_INK.fbAsc,
    fbDesc: px * EPILOGUE_INK.fbDesc,
  };
}

/** Re-measure once the webfont has actually loaded; before that the metrics
 *  are the fallback face's and the mark would sit a pixel or two off. */
function useWordInk(px: number): WordInk {
  const [, bump] = useState(0);
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (!fonts?.ready) return;
    let live = true;
    void fonts.ready.then(() => {
      if (live) bump((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);
  return measureWord(px);
}

/**
 * The full lockup: mark plus the name, ink-centred. `size` is the type size in
 * pixels — 19px in the app header, larger on the sign-in card.
 *
 * The name is lowercase everywhere, including at the start of a sentence. That
 * is deliberate, not a typo to be helpfully corrected.
 */
export function Lockup({ size = 19, className }: { size?: number; className?: string }) {
  const m = useWordInk(size);
  const inkHeight = m.asc + m.desc;
  const markHeight = inkHeight * LOCKUP_SCALE;
  const cut = pickCut(markHeight);
  const { inkWidth, trimLeft, trimTop } = markGeometry(markHeight, cut);

  // One origin: the top of the text box at line-height 1.
  const half = (size - (m.fbAsc + m.fbDesc)) / 2;
  const inkTop = half + m.fbAsc - m.asc;
  const markTop = inkTop + (inkHeight - markHeight) / 2;

  return (
    <span
      className={className}
      style={{
        display: 'inline-block',
        position: 'relative',
        lineHeight: 1,
        fontSize: 0,
        paddingLeft: inkWidth + LOCKUP_GAP * size,
      }}
    >
      <MarkSvg
        inkHeight={markHeight}
        cut={cut}
        style={{ position: 'absolute', left: -trimLeft, top: markTop - trimTop, display: 'block' }}
      />
      <span
        style={{
          display: 'block',
          lineHeight: 1,
          fontFamily: 'var(--font-display)',
          fontWeight: 300,
          letterSpacing: '0.005em',
          fontSize: size,
          color: 'var(--text)',
          whiteSpace: 'nowrap',
        }}
      >
        rippel
      </span>
    </span>
  );
}
