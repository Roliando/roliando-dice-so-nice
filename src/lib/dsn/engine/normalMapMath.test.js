import { describe, it, expect } from 'vitest';
import { normalesDeRelieve } from './normalMapMath.js';

// Referencia: el bucle por pixel original, tal cual (incluida la pasada vertical en el propio
// buffer de las dos primeras pasadas del desenfoque).
function referencia(red, w, h, strength) {
  const raw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = red[i] / 255.0;
  const tmp = new Float32Array(w * h);
  let src = raw, dst = tmp;
  for (let pass = 0; pass < 3; pass++) {
    const mid = (pass === 2) ? new Float32Array(w * h) : dst;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const l = x > 0 ? src[y * w + x - 1] : src[y * w + x];
      const c = src[y * w + x];
      const r = x < w - 1 ? src[y * w + x + 1] : src[y * w + x];
      mid[y * w + x] = (l + 2 * c + r) * 0.25;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = y > 0 ? mid[(y - 1) * w + x] : mid[y * w + x];
      const c = mid[y * w + x];
      const b = y < h - 1 ? mid[(y + 1) * w + x] : mid[y * w + x];
      dst[y * w + x] = (t + 2 * c + b) * 0.25;
    }
    src = dst;
    dst = (src === tmp) ? raw : tmp;
  }
  const heights = src;
  const out = new Uint8ClampedArray(w * h * 4);
  const sample = (x, y) => { if (x < 0) x = 0; else if (x >= w) x = w - 1; if (y < 0) y = 0; else if (y >= h) y = h - 1; return heights[y * w + x]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const tl = sample(x - 1, y - 1), t = sample(x, y - 1), tr = sample(x + 1, y - 1);
    const l = sample(x - 1, y), r = sample(x + 1, y);
    const bl = sample(x - 1, y + 1), b = sample(x, y + 1), br = sample(x + 1, y + 1);
    const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
    const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
    let nx = -gx * strength, ny = -gy * strength, nz = 1.0;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= len; ny /= len; nz /= len;
    const idx = (y * w + x) * 4;
    out[idx] = (nx * 0.5 + 0.5) * 255; out[idx + 1] = (ny * 0.5 + 0.5) * 255; out[idx + 2] = (nz * 0.5 + 0.5) * 255; out[idx + 3] = 255;
  }
  return out;
}

describe('normalesDeRelieve', () => {
  for (const [w, h] of [[8, 8], [37, 53], [128, 128]]) {
    it(`es identico al bucle original (${w}x${h})`, () => {
      const red = new Uint8Array(w * h); let s = 987654321;
      for (let i = 0; i < red.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; red[i] = (s >> 8) & 255; }
      expect(Buffer.from(normalesDeRelieve(red, w, h, 1.5))).toEqual(Buffer.from(referencia(red, w, h, 1.5)));
    });
  }
});
