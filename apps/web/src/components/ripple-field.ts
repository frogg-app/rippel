/**
 * The water behind the sign-in card, minus any drawing.
 *
 * Everything is a damped wave equation on a coarse grid. Drops (at the centre,
 * now and then elsewhere, and wherever you click) are impulses into it, and a
 * fast cursor is a moving source, which spreads into a trailing wake.
 *
 * Ripples and the wake share one grid, at one wave speed and damping, so
 * they run through the same water: where a ring meets the wake, or another
 * ring, their crests add and a crest on a trough cancels.
 *
 * Everything here is pure and clocked by the caller, so it can be tested
 * without a canvas or a real clock.
 */

/** Tuning. Lengths are CSS pixels, times milliseconds. */
export const RIPPLE = {
  /** Grid cell size, in CSS pixels, shared by both grids. */
  cell: 6,
  /** Width (cells) of the absorbing border, and the extra damping at its edge. */
  edgeBand: 12,
  edgeDamping: 0.2,

  /** The one grid: c² is the squared wave speed (0.5 ≈ 250px/s, the fastest stable). */
  c2: 0.5,
  /** Per-step damping: half-life ≈ 0.4s, so a ring is gone well before the next drop. */
  damping: 0.972,

  /** The wake appears only above this cursor speed (px/s), rising to full at twice it. */
  wakeSpeed: 450,
  wakeAmp: 0.35,
  /** Width (σ, in cells) of each wake impulse. */
  wakeSigma: Math.SQRT2,

  /** A centre drop: strength, and its width (σ, in cells), which is the ring's thickness. */
  dropAmp: 30,
  dropSigma: 1.0,
  /** Random factors per drop: thickness (σ), and strength, which sets how far it stays visible. */
  thickness: [0.7, 1.6] as const,
  reach: [0.7, 1.3] as const,

  /**
   * Random gap between centre drops. With a half-life of ≈ 0.4s a ring has
   * mostly faded before the next lands.
   */
  gap: [2500, 4500] as const,
  /** Occasional quick double pulse: a weaker drop 200–400ms after the first. */
  doubleChance: 0.12,
  doubleDelay: [200, 400] as const,
  doubleAmp: 0.6,
  /** Occasional stray drop elsewhere: weaker, so it fades sooner. */
  strayChance: 0.1,
  strayAmp: [0.35, 0.55] as const,
  /**
   * Signing in (or failing to) sends a wave out from the card's outline: a
   * thin line of impulses this far outside its edge (px), spaced
   * `outlineSpacing` px apart, of this base strength. The front starts as the
   * card's rounded rectangle and rounds off as it spreads. It resets the
   * centre timer.
   */
  outlineOffset: 5,
  outlineSpacing: 3,
  outlineAmp: 0.0095,
  outlineSigma: 0.85,
  /** Width (σ, cells) of the swell the app sends out as it rises: broad and soft. */
  swellSigma: 2.2,
  /** Extra per-step decay at the height of a calm (see RippleField.calm). */
  calmRate: 0.035,
  /**
   * Extra damping under the card (ramped in over `maskRamp` cells from its
   * edge) for `maskFor` ms after an outline wave. Whatever of the wave heads
   * inward would otherwise converge and focus into blobs; this soaks it up,
   * then lifts so centre drops are not swallowed.
   */
  maskDamping: 0.7,
  maskRamp: 5,
  maskFor: 2500,
  /** A click, relative to a centre drop. */
  clickAmp: 0.8,
} as const;

/**
 * A damped 2D wave equation (explicit, two buffers). `c2` is the squared wave
 * speed in cells per step; 0.5 is the stable limit and the fastest.
 */
export class WaveField {
  cur: Float32Array;
  prev: Float32Array;
  /**
   * Per-cell damping. It falls off over a border band so waves soak away at
   * the screen's edge instead of bouncing back off the grid's.
   */
  private damp: Float32Array;
  private baseDamp: Float32Array;
  private maskKey = '';

  constructor(
    public cols: number,
    public rows: number,
    public c2 = 0.5,
    damping = 0.965,
  ) {
    this.cur = new Float32Array(cols * rows);
    this.prev = new Float32Array(cols * rows);
    this.damp = new Float32Array(cols * rows);
    const band = RIPPLE.edgeBand;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const edge = Math.min(x, y, cols - 1 - x, rows - 1 - y);
        const t = Math.max(0, (band - edge) / band);
        this.damp[y * cols + x] = damping * (1 - RIPPLE.edgeDamping * t * t);
      }
    }
    this.baseDamp = this.damp.slice();
  }

  /**
   * Damp a rectangle (in cells) much harder, or nothing with null. Cheap to
   * call often: it only rebuilds when the rectangle changes.
   */
  mask(rect: { x0: number; y0: number; x1: number; y1: number } | null) {
    const key = rect ? `${rect.x0},${rect.y0},${rect.x1},${rect.y1}` : '';
    if (key === this.maskKey) return;
    this.maskKey = key;
    this.damp.set(this.baseDamp);
    if (!rect) return;
    // Graded from nothing at the rectangle's edge to full depth `maskRamp`
    // cells in: a hard step in damping reflects waves, a ramp soaks them up.
    const ramp = RIPPLE.maskRamp;
    for (let y = Math.max(0, rect.y0); y <= Math.min(this.rows - 1, rect.y1); y++) {
      for (let x = Math.max(0, rect.x0); x <= Math.min(this.cols - 1, rect.x1); x++) {
        const depth = Math.min(x - rect.x0, rect.x1 - x, y - rect.y0, rect.y1 - y) + 1;
        const t = Math.min(1, depth / ramp);
        this.damp[y * this.cols + x]! *= 1 - (1 - RIPPLE.maskDamping) * t * t;
      }
    }
  }


  /**
   * Add a soft Gaussian bump of `amp`, `sigma` cells wide, at a cell position.
   * `atRest` puts it in both buffers, so it spreads as one clean ring; without
   * it the bump is also a kick, which suits a moving source. `prevOnly` writes
   * just the previous step, for giving a front a direction of travel.
   */
  impulse(cx: number, cy: number, amp: number, sigma = Math.SQRT2, atRest = false, prevOnly = false) {
    // Kept soft (σ above a cell): sharper impulses excite grid-scale ripples,
    // which read as stripes rather than water.
    const reach = Math.ceil(sigma * 2);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const k = 1 / (2 * sigma * sigma);
    for (let y = y0 - reach + 1; y <= y0 + reach; y++) {
      for (let x = x0 - reach + 1; x <= x0 + reach; x++) {
        if (x < 1 || y < 1 || x >= this.cols - 1 || y >= this.rows - 1) continue;
        const v = amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) * k);
        if (!prevOnly) this.cur[y * this.cols + x]! += v;
        if (atRest || prevOnly) this.prev[y * this.cols + x]! += v;
      }
    }
  }

  step() {
    const { cols, rows, cur, prev, c2, damp } = this;
    const self = 2 - 4 * c2;
    // Written into `prev`, which then becomes current: no allocation per step.
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        const around = cur[i - 1]! + cur[i + 1]! + cur[i - cols]! + cur[i + cols]!;
        prev[i] = (self * cur[i]! + c2 * around - prev[i]!) * damp[i]!;
      }
    }
    this.prev = cur;
    this.cur = prev;
  }

  /** Whether anything is still moving enough to be worth drawing. */
  quiet(): boolean {
    for (let i = 0; i < this.cur.length; i++) if (Math.abs(this.cur[i]!) > 0.004) return false;
    return true;
  }
}

/** The card's box, in the field's CSS pixel coordinates. */
export interface Outline {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

/** Points every `spacing` px along a rounded rectangle grown by `offset`. */
export function outlinePoints(o: Outline, offset: number, spacing: number): [number, number][] {
  const r = Math.min(o.radius, o.width / 2, o.height / 2) + offset;
  const x0 = o.x - offset + r;
  const x1 = o.x + o.width + offset - r;
  const y0 = o.y - offset + r;
  const y1 = o.y + o.height + offset - r;
  const points: [number, number][] = [];
  const line = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / spacing));
    for (let i = 0; i < n; i++) points.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]);
  };
  const arc = (cx: number, cy: number, from: number) => {
    const n = Math.max(1, Math.round((r * Math.PI) / 2 / spacing));
    for (let i = 0; i < n; i++) {
      const a = from + ((Math.PI / 2) * i) / n;
      points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  // Clockwise from the top-left corner's end, in screen coordinates.
  line(x0, y0 - r, x1, y0 - r);
  arc(x1, y0, -Math.PI / 2);
  line(x1 + r, y0, x1 + r, y1);
  arc(x1, y1, 0);
  line(x1, y1 + r, x0, y1 + r);
  arc(x0, y1, Math.PI / 2);
  line(x0 - r, y1, x0 - r, y0);
  arc(x0, y0, Math.PI);
  return points;
}

/** A drop, landed or waiting to (double pulses are scheduled a moment ahead). */
export interface Drop {
  x: number;
  y: number;
  at: number;
  amp: number;
  sigma: number;
  /** A wave from the card's outline rather than a point. */
  outline?: boolean;
  /** For a swell: the rounded rectangle to start from, instead of the card. */
  shape?: Outline;
}

/**
 * How far the mask's edge sits inside the card's (px). Negative would reach
 * past it; the wave starts `outlineOffset` outside, so the mask stays clear of
 * that line and only the ramped inner part damps hard.
 */
const MASK_MARGIN = -2;

type Random = () => number;
const between = (r: Random, [lo, hi]: readonly [number, number]) => lo + (hi - lo) * r();

/**
 * Owns the grid and decides when the ambient drops fall. The caller ticks
 * it with its own clock and feeds it clicks and pointer moves.
 */
export class RippleField {
  water!: WaveField;
  /** Recent drops, newest last; kept for tests and debugging. */
  log: Drop[] = [];
  private pending: Drop[] = [];
  private nextDrop: number;
  private lastStep: number;
  private maskUntil = -Infinity;
  /** A calming window: waves are eased out to nothing over it (see `calm`). */
  private calmFrom = 0;
  private calmUntil = -Infinity;
  private pointer: { x: number; y: number; at: number } | null = null;
  /**
   * Where the card is, asked for when an outline wave lands (so it is right
   * after resizes and the card's entrance). Without it there are no outline
   * waves.
   */
  outline: (() => Outline | null) | null = null;
  /** Cursor path since the last step, waiting to be fed in as the wake. */
  private path: { x: number; y: number; speed: number }[] = [];

  constructor(
    public width: number,
    public height: number,
    now: number,
    private random: Random = Math.random,
  ) {
    this.makeFields();
    // The first ring comes almost at once, so the page never looks still.
    this.nextDrop = now + 300;
    this.lastStep = now;
  }

  private makeFields() {
    const cols = Math.max(3, Math.ceil(this.width / RIPPLE.cell) + 1);
    const rows = Math.max(3, Math.ceil(this.height / RIPPLE.cell) + 1);
    this.water = new WaveField(cols, rows, RIPPLE.c2, RIPPLE.damping);
  }

  resize(width: number, height: number) {
    // A new canvas taking over the same water (as across the sign-in
    // transition) reports the same size; keep the waves rather than wipe them.
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.makeFields();
  }

  /** Whether the water is still, so drawing can pause. */
  quiet(): boolean {
    return this.pending.length === 0 && this.water.quiet();
  }

  /** Queue a drop with its own random thickness and reach. */
  private drop(x: number, y: number, at: number, amp: number) {
    const r = this.random;
    const d: Drop = {
      x,
      y,
      at,
      amp: amp * RIPPLE.dropAmp * between(r, RIPPLE.reach),
      sigma: RIPPLE.dropSigma * between(r, RIPPLE.thickness),
    };
    this.pending.push(d);
    this.log.push(d);
    if (this.log.length > 500) this.log.splice(0, 250);
  }

  /** Advance to `now`: schedule ambient drops, land due ones, step at 60Hz. */
  tick(now: number) {
    // After a hidden tab comes back, do not replay every drop it missed.
    if (now - this.nextDrop > RIPPLE.gap[1]) this.nextDrop = now;
    while (now >= this.nextDrop) {
      this.ambient(this.nextDrop);
      this.nextDrop += between(this.random, RIPPLE.gap);
    }

    // Fixed 60Hz steps keep the wave speed independent of the display rate;
    // capped so a stalled tab does not spin through hundreds at once.
    const steps = Math.min(4, Math.floor((now - this.lastStep) / (1000 / 60)));
    if (steps === 0) return;
    this.lastStep = steps === 4 ? now : this.lastStep + steps * (1000 / 60);
    this.feed(now);
    for (let i = 0; i < steps; i++) this.water.step();
    if (now < this.calmUntil) this.settle(now, steps);
  }

  private feed(now: number) {
    const cell = RIPPLE.cell;
    const due = this.pending.filter((d) => d.at <= now);
    this.pending = this.pending.filter((d) => d.at > now);
    const card = due.some((d) => d.outline) || now < this.maskUntil ? (this.outline?.() ?? null) : null;
    // Keep the water under the card still just after an outline wave.
    this.water.mask(
      card && now < this.maskUntil
        ? {
            // The card plus a margin, stopping short of the line the wave
            // starts on; the ramp keeps the mask's own edge gentle.
            x0: Math.floor((card.x + MASK_MARGIN) / cell),
            y0: Math.floor((card.y + MASK_MARGIN) / cell),
            x1: Math.ceil((card.x + card.width - MASK_MARGIN) / cell),
            y1: Math.ceil((card.y + card.height - MASK_MARGIN) / cell),
          }
        : null,
    );
    for (const d of due) {
      if (d.outline) {
        const from = d.shape ?? card;
        if (!from) continue;
        // One-sided: the front now, and where it was a step ago (one step's
        // travel further in). That gives it outward velocity, so nearly all of
        // it heads out rather than half collapsing inward under the card.
        const travel = Math.sqrt(RIPPLE.c2) * cell;
        for (const [x, y] of outlinePoints(from, RIPPLE.outlineOffset, RIPPLE.outlineSpacing)) {
          this.water.impulse(x / cell, y / cell, d.amp, d.sigma);
        }
        for (const [x, y] of outlinePoints(from, RIPPLE.outlineOffset - travel, RIPPLE.outlineSpacing)) {
          this.water.impulse(x / cell, y / cell, d.amp, d.sigma, false, true);
        }
      } else {
        this.water.impulse(d.x / cell, d.y / cell, d.amp, d.sigma, true);
      }
    }

    // The wake: the cursor is a moving source, but only when moving fast.
    for (const p of this.path) {
      const strength = Math.min(1, (p.speed - RIPPLE.wakeSpeed) / RIPPLE.wakeSpeed);
      if (strength > 0) this.water.impulse(p.x / cell, p.y / cell, RIPPLE.wakeAmp * strength, RIPPLE.wakeSigma);
    }
    this.path = [];
  }

  private ambient(at: number) {
    const r = this.random;
    // Never open with a stray: the first thing seen should be the centre ring.
    const first = this.log.length === 0;
    if (!first && r() < RIPPLE.strayChance) {
      this.drop(r() * this.width, r() * this.height, at, between(r, RIPPLE.strayAmp));
      return;
    }
    const x = this.width / 2;
    const y = this.height / 2;
    this.drop(x, y, at, 1);
    if (r() < RIPPLE.doubleChance) this.drop(x, y, at + between(r, RIPPLE.doubleDelay), RIPPLE.doubleAmp);
  }

  /**
   * Send one wave out from the card's outline, `strength` times the base.
   * Returns whether it went (it needs to know where the card is).
   */
  outlineWave(now: number, strength = 1): boolean {
    if (!this.outline) return false;
    this.maskUntil = now + RIPPLE.maskFor;
    // The next centre drop waits a full fresh gap, so the two do not pile up.
    this.nextDrop = now + between(this.random, RIPPLE.gap);
    const d: Drop = {
      x: this.width / 2,
      y: this.height / 2,
      at: now,
      amp: RIPPLE.dropAmp * RIPPLE.outlineAmp * strength,
      sigma: RIPPLE.outlineSigma,
      outline: true,
    };
    this.pending.push(d);
    this.log.push(d);
    return true;
  }

  /**
   * Calm the water to stillness over `ms`: no new ambient drops, and every
   * wave scaled down a little more each step (more as it goes on), so the
   * surface settles rather than being cut off. Scaling both buffers alike
   * shrinks the waves without changing their motion.
   */
  calm(now: number, ms: number) {
    this.calmFrom = now;
    this.calmUntil = now + ms;
    this.nextDrop = Math.max(this.nextDrop, this.calmUntil + RIPPLE.gap[0]);
  }

  private settle(now: number, steps: number) {
    const t = (now - this.calmFrom) / (this.calmUntil - this.calmFrom);
    const f = Math.pow(1 - RIPPLE.calmRate * Math.min(1, t * 1.5), steps);
    const { cur, prev } = this.water;
    for (let i = 0; i < cur.length; i++) {
      cur[i]! *= f;
      prev[i]! *= f;
    }
  }

  /**
   * A broad, soft swell from a centred rounded rectangle `fraction` of the
   * water's size: what the app sends out as it surfaces. Resets the centre
   * timer like the card's waves.
   */
  swell(now: number, strength = 1, fraction = 0.55) {
    const width = this.width * fraction;
    const height = this.height * fraction;
    this.nextDrop = now + between(this.random, RIPPLE.gap);
    const d: Drop = {
      x: this.width / 2,
      y: this.height / 2,
      at: now,
      amp: RIPPLE.dropAmp * RIPPLE.outlineAmp * strength,
      sigma: RIPPLE.swellSigma,
      outline: true,
      shape: {
        x: (this.width - width) / 2,
        y: (this.height - height) / 2,
        width,
        height,
        radius: Math.min(width, height) * 0.2,
      },
    };
    this.pending.push(d);
    this.log.push(d);
  }

  click(x: number, y: number, now: number) {
    this.drop(x, y, now, RIPPLE.clickAmp);
  }

  /** The pointer moved; long jumps are filled in so the wake stays continuous. */
  move(x: number, y: number, now: number) {
    const last = this.pointer;
    this.pointer = { x, y, at: now };
    if (!last || now <= last.at) return;
    const dist = Math.hypot(x - last.x, y - last.y);
    const speed = (dist / (now - last.at)) * 1000;
    const n = Math.min(32, Math.ceil(dist / RIPPLE.cell));
    for (let i = 1; i <= n; i++) {
      this.path.push({ x: last.x + ((x - last.x) * i) / n, y: last.y + ((y - last.y) * i) / n, speed });
    }
  }

  /** The pointer left; the next move starts a fresh path. */
  leave() {
    this.pointer = null;
  }
}
