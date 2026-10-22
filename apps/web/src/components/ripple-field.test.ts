import { describe, expect, it } from 'vitest';
import { RIPPLE, RippleField, WaveField, outlinePoints } from './ripple-field';

/** A seeded generator, so the schedule is reproducible. */
function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** Ticks the schedule only (tiny grid), returning every drop made. */
function schedule(seed: number, until: number) {
  const field = new RippleField(100, 80, 0, seeded(seed));
  for (let t = 0; t < until; t += 16) field.tick(t);
  return field.log;
}

describe('RippleField schedule', () => {
  it('spaces centre drops by a random gap within range', () => {
    const main = schedule(7, 600_000)
      .filter((d) => d.x === 50 && d.amp > RIPPLE.dropAmp * RIPPLE.doubleAmp * RIPPLE.reach[1])
      .map((d) => d.at);
    const gaps = main.slice(1).map((b, i) => b - main[i]!);
    // Strays take a turn now and then, so allow for a skipped beat.
    const single = gaps.filter((g) => g < RIPPLE.gap[0] * 2);
    expect(single.length).toBeGreaterThan(50);
    for (const g of single) {
      expect(g).toBeGreaterThanOrEqual(RIPPLE.gap[0] - 1);
      expect(g).toBeLessThanOrEqual(RIPPLE.gap[1] + 1);
    }
  });

  it('adds only occasional quick doubles and strays', () => {
    const drops = schedule(11, 300_000);
    const strays = drops.filter((d) => d.x !== 50);
    expect(strays.length).toBeGreaterThan(0);
    expect(strays.length).toBeLessThan(drops.length * 0.2);
    const centre = drops.filter((d) => d.x === 50);
    const quick = centre.slice(1).filter((d, i) => d.at - centre[i]!.at <= RIPPLE.doubleDelay[1]);
    expect(quick.length).toBeGreaterThan(0);
    expect(quick.length).toBeLessThan(centre.length * 0.2);
    for (const d of quick) expect(d.at - centre[centre.indexOf(d) - 1]!.at).toBeGreaterThanOrEqual(RIPPLE.doubleDelay[0]);
  });

  it('varies each drop’s thickness within range', () => {
    for (const d of schedule(5, 60_000)) {
      expect(d.sigma).toBeGreaterThanOrEqual(RIPPLE.dropSigma * RIPPLE.thickness[0]);
      expect(d.sigma).toBeLessThanOrEqual(RIPPLE.dropSigma * RIPPLE.thickness[1]);
    }
  });
});

describe('RippleField simulation', () => {
  it('leaves a wake only when the cursor moves fast', () => {
    const run = (pxPerMs: number) => {
      const f = new RippleField(600, 400, 0, () => 0.99);
      for (let t = 0; t < 280; t += 16) {
        f.move(50 + t * pxPerMs, 200, t);
        f.tick(t);
      }
      return f.water.quiet();
    };
    expect(run(0.2)).toBe(true);
    expect(run(1)).toBe(false);
  });

  it('puts clicks and the wake into the same water', () => {
    const f = new RippleField(600, 400, 0, () => 0.99);
    f.click(100, 100, 0);
    f.tick(20);
    expect(f.water.quiet()).toBe(false);
  });
});

describe('WaveField', () => {
  it('spreads an impulse outwards as a ring and settles', () => {
    const f = new WaveField(60, 60, RIPPLE.c2, RIPPLE.damping);
    f.impulse(30, 30, 1, RIPPLE.dropSigma, true);
    for (let i = 0; i < 60; i++) f.step();
    // Sixty steps at ~0.7 cells each: the crest has moved off the centre.
    const ring = Math.max(...[...Array(25).keys()].map((r) => Math.abs(f.cur[30 * 60 + 30 + r]!)));
    expect(ring).toBeGreaterThan(Math.abs(f.cur[30 * 60 + 30]!));
    for (let i = 0; i < 3000; i++) f.step();
    expect(f.quiet()).toBe(true);
  });

  it('is linear, so two sources superpose (interference)', () => {
    const one = new WaveField(40, 40);
    const two = new WaveField(40, 40);
    const both = new WaveField(40, 40);
    one.impulse(12, 20, 1);
    two.impulse(28, 20, 1);
    both.impulse(12, 20, 1);
    both.impulse(28, 20, 1);
    for (let i = 0; i < 12; i++) [one, two, both].forEach((f) => f.step());
    const i = 20 * 40 + 20;
    expect(both.cur[i]!).toBeCloseTo(one.cur[i]! + two.cur[i]!, 5);
  });
});

describe('outline drops', () => {
  const card = { x: 200, y: 100, width: 200, height: 160, radius: 20 };

  it('traces the rounded rectangle just outside the card', () => {
    const points = outlinePoints(card, 5, 3);
    for (const [x, y] of points) {
      // Distance from the grown rounded rectangle is ~0.
      const r = 25;
      const dx = Math.abs(x - 300) - (100 + 5 - r);
      const dy = Math.abs(y - 180) - (80 + 5 - r);
      const sdf = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
      expect(sdf).toBeCloseTo(0, 5);
    }
    // Roughly evenly spaced around the whole perimeter.
    const perimeter = 2 * (160 + 120) + 2 * Math.PI * 25;
    expect(points.length).toBeGreaterThan(perimeter / 3 - 8);
    expect(points.length).toBeLessThan(perimeter / 3 + 8);
  });

  it('sends an outline wave on demand and resets the centre timer', () => {
    const f = new RippleField(600, 400, 0, () => 0.5);
    expect(f.outlineWave(100)).toBe(false); // no card known yet
    f.outline = () => card;
    f.tick(320); // the first centre drop (a plain ring) lands at 300ms
    const centreAt = f.log.length;
    expect(f.outlineWave(1000)).toBe(true);
    f.tick(1020);
    const at = (x: number, y: number) => Math.abs(f.water.cur[Math.round(y / 6) * f.water.cols + Math.round(x / 6)]!);
    expect(at(300, 95)).toBeGreaterThan(0.01); // just above the top edge
    // No centre drop until a full gap after the wave.
    for (let t = 1036; t < 1000 + RIPPLE.gap[0] - 20; t += 16) f.tick(t);
    expect(f.log.length).toBe(centreAt + 1);
  });

  it('scales the outline wave by strength', () => {
    const f = new RippleField(600, 400, 0, () => 0.5);
    f.outline = () => card;
    f.outlineWave(1000);
    f.outlineWave(1100, 2.4);
    const [base, signIn] = f.log.filter((d) => d.outline);
    expect(signIn!.amp).toBeCloseTo(base!.amp * 2.4);
  });

  it('keeps centre drops circular from the middle', () => {
    const f = new RippleField(600, 400, 0, () => 0.5);
    f.outline = () => card;
    f.tick(320);
    const at = (x: number, y: number) => Math.abs(f.water.cur[Math.round(y / 6) * f.water.cols + Math.round(x / 6)]!);
    expect(at(300, 200)).toBeGreaterThan(1);
    expect(at(300, 95)).toBeLessThan(1e-6);
  });
});

describe('rise helpers', () => {
  const energy = (f: RippleField) => f.water.cur.reduce((a, v) => a + v * v, 0);

  it('sends a swell from a centred rectangle, not the card', () => {
    const f = new RippleField(600, 400, 0, () => 0.5);
    f.tick(0);
    f.swell(10);
    f.tick(30);
    const at = (x: number, y: number) => Math.abs(f.water.cur[Math.round(y / 6) * f.water.cols + Math.round(x / 6)]!);
    // 55% of 600×400 centred: its top edge is at y = 90.
    expect(at(300, 90)).toBeGreaterThan(0.01);
  });

  it('calms the water to stillness and holds off new drops meanwhile', () => {
    const calmed = new RippleField(600, 400, 0, () => 0.5);
    const free = new RippleField(600, 400, 0, () => 0.5);
    for (const f of [calmed, free]) {
      f.click(300, 200, 0);
      f.tick(16);
    }
    calmed.calm(16, 1500);
    const drops = calmed.log.length;
    for (let t = 32; t <= 1500; t += 16) {
      calmed.tick(t);
      free.tick(t);
    }
    expect(energy(calmed)).toBeLessThan(energy(free) * 0.05);
    expect(calmed.log.length).toBe(drops);
  });
});
