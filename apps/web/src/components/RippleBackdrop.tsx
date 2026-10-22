import { useEffect, useRef, type RefObject } from 'react';
import { RippleField, RIPPLE } from './ripple-field';

/**
 * The sign-in screen's water: drops at the old cadence, one wherever you click
 * that is not a control, and a wake behind a fast cursor, all in one wave
 * simulation (see ripple-field.ts). This file only draws it: the summed height
 * is lit from the upper left, so slopes read as faint highlights and shadows.
 *
 * WebGL where it exists, Canvas2D otherwise. With reduced motion asked for,
 * nothing is drawn at all.
 */

/** Opacity of the lit and shaded slopes. */
const FIELD_LIGHT = 0.11;
const FIELD_SHADE = 0.08;
/** Slope gain before the soft clip; higher reads as stronger water. */
const SLOPE_GAIN = 0.6;
/** The accent, rgb(156, 207, 216). */
const MIST = [156, 207, 216] as const;

/** Elements that keep their clicks: a ripple there would fight the control. */
const CONTROLS = 'input, textarea, select, button, a, label, [role="button"]';

export function RippleBackdrop({
  className,
  shape,
  water: shared,
  interactive = true,
}: {
  className?: string;
  /** The panel whose outline the sign-in waves go out from. */
  shape?: RefObject<HTMLElement | null>;
  /**
   * Water to draw instead of a fresh one. Sharing it lets a later canvas
   * carry on the same waves, which is how the sign-in transition keeps the
   * water on screen across the route change.
   */
  water?: RippleField;
  /** Whether clicks and the cursor disturb it. */
  interactive?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // The listeners go on the canvas's container, since the canvas itself
    // sits under the card and takes no pointer events.
    const host = canvas.parentElement ?? document.body;

    const water = shared ?? new RippleField(1, 1, performance.now());
    const renderer = createGlRenderer(canvas) ?? createCanvas2dRenderer(canvas);
    if (!renderer) return;

    if (shape) {
      water.outline = () => {
        const panel = shape.current;
        if (!panel) return null;
        const box = panel.getBoundingClientRect();
        const origin = canvas.getBoundingClientRect();
        return {
          x: box.left - origin.left,
          y: box.top - origin.top,
          width: box.width,
          height: box.height,
          radius: parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0,
        };
      };
    }

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      water.resize(box.width, box.height);
      renderer.resize(box.width, box.height);
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(canvas);

    const local = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top] as const;
    };
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(CONTROLS)) return;
      const [x, y] = local(event);
      water.click(x, y, performance.now());
    };
    const onMove = (event: PointerEvent) => {
      const [x, y] = local(event);
      water.move(x, y, event.timeStamp || performance.now());
    };
    const onLeave = () => water.leave();
    if (interactive) {
      host.addEventListener('pointerdown', onDown);
      host.addEventListener('pointermove', onMove);
      host.addEventListener('pointerleave', onLeave);
    }

    let idle = false;
    let frame = requestAnimationFrame(function draw(now) {
      water.tick(now);
      // Nothing moving and already cleared: skip drawing entirely.
      const still = water.quiet();
      if (!(still && idle)) renderer.draw(water);
      idle = still;
      frame = requestAnimationFrame(draw);
    });

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      renderer.dispose();
    };
  }, [shape, shared, interactive]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}

interface Renderer {
  resize(width: number, height: number): void;
  draw(water: RippleField): void;
  dispose(): void;
}

/**
 * The slope of the height towards a light at the upper left,
 * soft-clipped to ±1. Done on the CPU in float: differencing 8-bit heights on
 * the GPU bands visibly. Differenced over two cells, which also filters out
 * grid-scale noise.
 */
function slopes(water: RippleField, write: (i: number, slope: number) => void) {
  const h = water.water.cur;
  const w = water.water.cols;
  const n = h.length;
  for (let i = 0; i < n; i++) {
    const x = i % w;
    let s = 0;
    if (x > 1 && x < w - 2 && i >= 2 * w && i < n - 2 * w) {
      const l = i - 2;
      const r = i + 2;
      const u = i - 2 * w;
      const d = i + 2 * w;
      s = (h[l]! - h[r]! + h[u]! - h[d]!) * SLOPE_GAIN;
    }
    write(i, s / (1 + Math.abs(s)));
  }
}

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform vec2 u_size;    // CSS pixels
uniform vec2 u_cells;   // grid columns, rows
uniform sampler2D u_slope;
const float CELL = ${RIPPLE.cell.toFixed(1)};
const vec3 MIST = vec3(${MIST.map((v) => (v / 255).toFixed(4)).join(', ')});
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  float slope = texture2D(u_slope, (p / CELL + 0.5) / u_cells).r * 2.0 - 1.0;
  float a = max(slope, 0.0) * ${FIELD_LIGHT.toFixed(3)};
  float shade = max(-slope, 0.0) * ${FIELD_SHADE.toFixed(3)};
  // Mist highlights over a little darkening, premultiplied.
  gl_FragColor = vec4(MIST * a, a + shade);
}
`;

function createGlRenderer(canvas: HTMLCanvasElement): Renderer | null {
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, alpha: true });
  } catch {
    return null;
  }
  if (!gl) return null;
  const g = gl;

  const compile = (type: number, source: string) => {
    const shader = g.createShader(type)!;
    g.shaderSource(shader, source);
    g.compileShader(shader);
    return g.getShaderParameter(shader, g.COMPILE_STATUS) ? shader : null;
  };
  const vs = compile(g.VERTEX_SHADER, VERTEX);
  const fs = compile(g.FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return null;
  const program = g.createProgram()!;
  g.attachShader(program, vs);
  g.attachShader(program, fs);
  g.linkProgram(program);
  if (!g.getProgramParameter(program, g.LINK_STATUS)) return null;
  g.useProgram(program);

  const buffer = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, buffer);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
  const pos = g.getAttribLocation(program, 'a_pos');
  g.enableVertexAttribArray(pos);
  g.vertexAttribPointer(pos, 2, g.FLOAT, false, 0, 0);

  // One byte per cell, linearly filtered up to size: plenty for something
  // this faint, and needs no float-texture extension.
  const texture = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, texture);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  g.pixelStorei(g.UNPACK_ALIGNMENT, 1);

  const uSize = g.getUniformLocation(program, 'u_size');
  const uCells = g.getUniformLocation(program, 'u_cells');
  g.uniform1i(g.getUniformLocation(program, 'u_slope'), 0);
  let bytes = new Uint8Array(0);

  return {
    resize(width, height) {
      // CSS-pixel resolution: the water is soft, so device pixels buy nothing.
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      g.viewport(0, 0, canvas.width, canvas.height);
      g.uniform2f(uSize, canvas.width, canvas.height);
    },
    draw(water) {
      const { cols, rows } = water.water;
      if (bytes.length !== cols * rows) bytes = new Uint8Array(cols * rows);
      slopes(water, (i, s) => (bytes[i] = Math.round((s + 1) * 127.5)));
      g.texImage2D(g.TEXTURE_2D, 0, g.LUMINANCE, cols, rows, 0, g.LUMINANCE, g.UNSIGNED_BYTE, bytes);
      g.uniform2f(uCells, cols, rows);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      g.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/** The fallback: the same lit slopes as a tiny image the browser smooths up to size. */
function createCanvas2dRenderer(canvas: HTMLCanvasElement): Renderer | null {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    return null;
  }
  const small = document.createElement('canvas');
  const sc = small.getContext('2d');
  if (!ctx || !sc) return null;
  const c = ctx;
  let image: ImageData | null = null;

  return {
    resize(width, height) {
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
    },
    draw(water) {
      const { cols, rows } = water.water;
      if (!image || image.width !== cols || image.height !== rows) {
        small.width = cols;
        small.height = rows;
        image = sc.createImageData(cols, rows);
      }
      const data = image.data;
      slopes(water, (i, s) => {
        const o = i * 4;
        data[o] = s > 0 ? MIST[0] : 0;
        data[o + 1] = s > 0 ? MIST[1] : 0;
        data[o + 2] = s > 0 ? MIST[2] : 0;
        data[o + 3] = Math.round(Math.abs(s) * (s > 0 ? FIELD_LIGHT : FIELD_SHADE) * 255);
      });
      sc.putImageData(image, 0, 0);
      const cell = RIPPLE.cell;
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.imageSmoothingEnabled = true;
      c.drawImage(small, -cell / 2, -cell / 2, cols * cell, rows * cell);
    },
    dispose() {},
  };
}
