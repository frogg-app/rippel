import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { RippleBackdrop } from './RippleBackdrop';
import { RippleField } from './ripple-field';
import styles from './surface.module.css';

/**
 * The sign-in transition: the card sinks into the water, then the app rises
 * out of it.
 *
 *   idle      nothing happening
 *   sinking   signed in; the card is going under. The auth routes hold off
 *             their redirect until this ends, or the card would vanish mid-sink.
 *   rising    the app has routed in and is surfacing, with the same water
 *             drawn over it and fading away
 *
 * The water is one RippleField for the whole app, so the canvas that draws it
 * over the rising app carries on exactly the waves the sign-in page started.
 */
export type SurfacePhase = 'idle' | 'sinking' | 'rising';

/** Durations, in ms. */
export const SINK_MS = 950;
export const RISE_MS = 1400;
/** A beat of bare water between the card going under and the app rising. */
export const RISE_DELAY_MS = 300;
/** Strength of the swell the app sends out as it rises. */
const SWELL = 1.6;
/** How far the card shrinks going under, and the app grows coming up. */
const SINK_SCALE = 0.85;
const RISE_SCALE = 0.79;
/** Fraction of the rise by which the mask, tint and filter have all come off. */
const SETTLED = 0.75;
/** Opacity of the teal colour layer over the app as it starts to rise. */
const RISE_TINT = 0.7;
/** How far below its place the app starts (px). */
const RISE_DROP = 40;
/** Strength of the failure wave, relative to the outline wave's base. */
const FAIL_WAVE = 1.4;
const SHAKE_MS = 420;
/**
 * The water over the rising app starts to fade this many ms into the rise,
 * over this long, on a curve that tails off softly; its waves calm down
 * alongside. It is gone (≈ 90% of the rise) before the app settles.
 */
const WATER_FADE_AT = 60;
const WATER_FADE_MS = 1200;
const WATER_FADE_EASE = 'cubic-bezier(0.33, 0, 0.15, 1)';
/** Strength of the sign-in wave, relative to the outline wave's base. */
export const SIGN_IN_WAVE = 2.4;

let phase: SurfacePhase = 'idle';
let water: RippleField | null = null;
const listeners = new Set<() => void>();

export const surface = {
  get phase() {
    return phase;
  },
  set(next: SurfacePhase) {
    if (next === phase) return;
    phase = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** The app's one body of water, made on first use. */
  water(): RippleField {
    water ??= new RippleField(1, 1, performance.now());
    return water;
  },
};

export function useSurfacePhase(): SurfacePhase {
  return useSyncExternalStore(
    surface.subscribe,
    () => phase,
    () => 'idle',
  );
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

const SINK_FILTER = 'rippel-sink';
const RISE_FILTER = 'rippel-rise';

/**
 * Sink an element: fade, shrink a little, and blur and warp it as if seen
 * through the surface. Resolves when it has gone under. The Web Animations
 * API rather than CSS, so the reduced-motion fade still runs (the global
 * reduced-motion rule flattens every CSS animation to nothing).
 */
export async function sink(element: HTMLElement, goingUnder?: () => void): Promise<void> {
  // No animation support (old browsers, jsdom): just go.
  if (typeof element.animate !== 'function') return;
  if (prefersReducedMotion()) {
    await element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }).finished;
    return;
  }
  goingUnder?.();
  const going = element.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0.85, transform: `translateY(4px) scale(${(1 + SINK_SCALE) / 2})`, offset: 0.5 },
      { opacity: 0, transform: `translateY(10px) scale(${SINK_SCALE})` },
    ],
    { duration: SINK_MS, easing: 'cubic-bezier(0.45, 0, 0.7, 0.4)', fill: 'forwards' },
  );
  // The warp builds slowly (eased in), so the card goes under deliberately.
  warp(element, SINK_FILTER, { scale: [0, 18], blur: [0, 7] }, going, 0, SINK_MS, 'in');
  await going.finished;
}

/**
 * A failed sign-in: shake the card side to side and send a moderate wave off
 * its outline. With reduced motion, nothing: the error says it.
 */
export function fail(element: HTMLElement) {
  if (typeof element.animate !== 'function' || prefersReducedMotion()) return;
  element.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-7px)', offset: 0.12 },
      { transform: 'translateX(6px)', offset: 0.27 },
      { transform: 'translateX(-4px)', offset: 0.42 },
      { transform: 'translateX(2.5px)', offset: 0.58 },
      { transform: 'translateX(-1px)', offset: 0.75 },
      { transform: 'translateX(0)' },
    ],
    { duration: SHAKE_MS, easing: 'ease-out' },
  );
  const water = surface.water();
  const now = performance.now();
  // This also resets the centre drop timer.
  water.outlineWave(now, FAIL_WAVE);
}

/**
 * The reverse: surface an element out of the water, after `delay` ms of bare
 * water. It grows up from below, is revealed from the water line up (a
 * gradient mask, so its lower part stays under longest), and sheds a teal
 * tint, dimness, the warp and the blur as it clears.
 *
 * Everything is clocked by the one transform animation (the warp reads its
 * current time), and every effect reaches exactly its resting value before
 * that animation ends: the mask, tint and filter by 75%, the transform by
 * 92%. So the last frames are already the settled screen, and nothing snaps
 * when the effects are taken off. Returns that animation.
 */
function rise(element: HTMLElement, shine: HTMLElement | null, tint: HTMLElement | null, delay: number): Animation {
  const timing = { delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' as const };
  const main = element.animate(
    [
      { opacity: 0, transform: `translateY(${RISE_DROP}px) scale(${RISE_SCALE})` },
      { opacity: 1, offset: 0.35 },
      { opacity: 1, transform: 'none', offset: 0.92 },
      { opacity: 1, transform: 'none' },
    ],
    { ...timing, duration: RISE_MS },
  );
  // The water line: black (shown) above, clear (still under) below, sliding
  // down so the top surfaces first. Sized so that at the end the element sees
  // only solid black: fully shown before the mask comes off.
  const line = 'linear-gradient(to bottom, #000 0%, #000 48%, rgba(0,0,0,0.35) 56%, transparent 66%)';
  const mask = (y: string) => ({
    maskImage: line,
    webkitMaskImage: line,
    maskSize: '100% 210%',
    webkitMaskSize: '100% 210%',
    maskPosition: `0 ${y}`,
    webkitMaskPosition: `0 ${y}`,
  });
  element.animate([mask('100%'), mask('0%')] as Keyframe[], { ...timing, duration: RISE_MS * SETTLED });
  // The water's colour over it, draining off as it surfaces.
  tint?.animate([{ opacity: RISE_TINT }, { opacity: 0 }], { ...timing, duration: RISE_MS * SETTLED * 0.9, fill: 'both' });
  // Warp, blur and dimness, on the same clock.
  warp(element, RISE_FILTER, { scale: [22, 0], blur: [9, 0] }, main, delay, RISE_MS * SETTLED, 'out', (e) =>
    e >= 1 ? '' : `brightness(${(0.55 + 0.45 * e).toFixed(4)})`,
  );
  // The surface breaking: a soft highlight across the top as it clears.
  shine?.animate(
    [
      { opacity: 0, transform: 'translateX(-60%)' },
      { opacity: 1, offset: 0.4 },
      { opacity: 0, transform: 'translateX(60%)' },
    ],
    { duration: RISE_MS * 0.55, delay: delay + RISE_MS * 0.12, easing: 'ease-out', fill: 'both' },
  );
  return main;
}

/**
 * Drive one of the SVG filters below: displacement (the ripple warp) and
 * blur, eased in (building) or out (settling), clocked by `clock` (from `from`
 * ms of its time, over `ms`) so it stays in step with the element's other
 * animations even if they are slowed or paused. The filter is attached only
 * while it is doing something; a settling warp takes it off on the same frame
 * it reaches rest, so the element is never left re-rasterised through an
 * identity filter.
 */
function warp(
  element: HTMLElement,
  id: string,
  to: { scale: [number, number]; blur: [number, number] },
  clock: Animation,
  from: number,
  ms: number,
  ease: 'in' | 'out',
  extra?: (eased: number) => string,
) {
  const map = document.querySelector<SVGFEDisplacementMapElement>(`#${id} feDisplacementMap`);
  const blur = document.querySelector<SVGFEGaussianBlurElement>(`#${id} feGaussianBlur`);
  if (!map || !blur) return;
  const settles = to.scale[1] === 0 && to.blur[1] === 0;
  const step = () => {
    if (clock.playState === 'idle') return; // cancelled
    const time = Number(clock.currentTime ?? 0);
    const t = Math.min(1, Math.max(0, (time - from) / ms));
    const e = ease === 'in' ? t * t : 1 - Math.pow(1 - t, 3);
    if (settles && t >= 1) {
      element.style.filter = '';
      return;
    }
    map.setAttribute('scale', String(to.scale[0] + (to.scale[1] - to.scale[0]) * e));
    blur.setAttribute('stdDeviation', String(to.blur[0] + (to.blur[1] - to.blur[0]) * e));
    element.style.filter = `url(#${id}) ${extra?.(e) ?? ''}`.trim();
    if (t < 1 && clock.playState !== 'finished') requestAnimationFrame(step);
  };
  step();
}

/**
 * Wraps the routes. Holds the warp filters, lifts the app in when the phase
 * turns to rising, and draws the shared water over it while it settles.
 */
export function SurfaceStage({ children }: { children: ReactNode }) {
  const current = useSurfacePhase();
  const stageRef = useRef<HTMLDivElement>(null);
  const waterRef = useRef<HTMLDivElement>(null);
  const shineRef = useRef<HTMLDivElement>(null);
  const tintRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (current !== 'rising') return;
    const stage = stageRef.current;
    const overlay = waterRef.current;
    if (!stage || typeof stage.animate !== 'function') {
      surface.set('idle');
      return;
    }
    // The sunk card's filter must not leak onto the new screen.
    stage.style.filter = '';
    if (prefersReducedMotion()) {
      const fade = stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 });
      void fade.finished.then(() => surface.set('idle'), () => {});
      return () => fade.cancel();
    }
    const main = rise(stage, shineRef.current, tintRef.current, RISE_DELAY_MS);
    const fadeAt = RISE_DELAY_MS + WATER_FADE_AT;
    const fade = overlay?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: WATER_FADE_MS,
      delay: fadeAt,
      easing: WATER_FADE_EASE,
      fill: 'forwards',
    });
    // As it starts up, the app sends a broad swell out from where it rises;
    // and the waves die down as the overlay fades, rather than being cut.
    const swell = window.setTimeout(() => surface.water().swell(performance.now(), SWELL), RISE_DELAY_MS);
    const calm = window.setTimeout(() => surface.water().calm(performance.now(), WATER_FADE_MS), fadeAt);
    // Only once the rise and the fade have both finished (so everything that
    // goes away is already invisible) does the stage drop back to idle and
    // unmount the overlay, under-layer and tint.
    void Promise.all([main.finished, fade?.finished]).then(() => surface.set('idle'), () => {});
    return () => {
      window.clearTimeout(swell);
      window.clearTimeout(calm);
      main.cancel();
      fade?.cancel();
    };
  }, [current]);

  return (
    <>
      {/* Behind the rising app, the app shell's own resting background, so
          wherever the app is still see-through it shows what will be there
          when it has settled, and nothing changes when this goes. */}
      {current === 'rising' ? <div className={styles.under} aria-hidden /> : null}
      <div ref={stageRef} className={styles.stage}>
        {children}
        {current === 'rising' ? (
          <>
            <div ref={tintRef} className={styles.tint} aria-hidden />
            <div ref={shineRef} className={styles.shine} aria-hidden />
          </>
        ) : null}
      </div>
      {current === 'rising' && !prefersReducedMotion() ? (
        <div ref={waterRef} className={styles.water} aria-hidden>
          <RippleBackdrop className={styles.canvas} water={surface.water()} interactive={false} />
        </div>
      ) : null}
      <svg className={styles.defs} aria-hidden>
        {[SINK_FILTER, RISE_FILTER].map((id) => (
          <filter key={id} id={id} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.008 0.016"
              numOctaves={1}
              seed={id === SINK_FILTER ? 3 : 7}
            />
            <feDisplacementMap in="SourceGraphic" scale={0} xChannelSelector="R" yChannelSelector="G" />
            <feGaussianBlur stdDeviation={0} />
          </filter>
        ))}
      </svg>
    </>
  );
}
