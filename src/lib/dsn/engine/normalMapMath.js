// Mapa de normales a partir de un mapa de relieve en grises. Funcion pura (sin DOM) para poder
// correr igual en el hilo principal y en el Worker. El resultado es identico bit a bit al del
// bucle original por pixel: mismas operaciones y mismo orden, solo que sin `sample()` ni
// recortes de borde dentro del bucle (el borde se resuelve replicando la ultima fila/columna).

/** @param {Uint8Array} red canal rojo del relieve (w*h) @returns {Uint8ClampedArray} RGBA w*h*4 */
export function normalesDeRelieve(red, w, h, strength) {
  const n = w * h;
  let cur = new Float32Array(n);
  for (let i = 0; i < n; i++) cur[i] = red[i] / 255.0;

  //desenfoque 1-2-1 separable, 3 pasadas. OJO: en las dos primeras la pasada vertical se
  //hace EN el mismo buffer (lee la fila de arriba ya desenfocada), igual que el original;
  //la tercera va a un buffer aparte. Cambiarlo cambia el resultado.
  const hBlur = (src, dst) => {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const c = src[o + x];
        const l = x > 0 ? src[o + x - 1] : c;
        const r = x < w - 1 ? src[o + x + 1] : c;
        dst[o + x] = (l + 2 * c + r) * 0.25;
      }
    }
  };
  const vBlur = (mid, dst) => {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      const ot = y > 0 ? o - w : o;
      const ob = y < h - 1 ? o + w : o;
      for (let x = 0; x < w; x++) dst[o + x] = (mid[ot + x] + 2 * mid[o + x] + mid[ob + x]) * 0.25;
    }
  };
  const bufA = new Float32Array(n);
  const bufM = new Float32Array(n);
  hBlur(cur, bufA); vBlur(bufA, bufA);
  hBlur(bufA, cur); vBlur(cur, cur);
  hBlur(cur, bufM); vBlur(bufM, bufA);
  cur = bufA;

  //Sobel con borde replicado: rejilla con un pixel de margen
  const pw = w + 2;
  const pad = new Float32Array(pw * (h + 2));
  for (let y = 0; y < h; y++) {
    const po = (y + 1) * pw;
    pad[po] = cur[y * w];
    pad.set(cur.subarray(y * w, y * w + w), po + 1);
    pad[po + w + 1] = cur[y * w + w - 1];
  }
  pad.copyWithin(0, pw, 2 * pw);
  pad.copyWithin((h + 1) * pw, h * pw, (h + 1) * pw);

  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) {
    const rt = y * pw;
    const rm = rt + pw;
    const rb = rm + pw;
    let idx = y * w * 4;
    for (let x = 0; x < w; x++) {
      const tl = pad[rt + x], t = pad[rt + x + 1], tr = pad[rt + x + 2];
      const l = pad[rm + x], r = pad[rm + x + 2];
      const bl = pad[rb + x], b = pad[rb + x + 1], br = pad[rb + x + 2];
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -gx * strength;
      let ny = -gy * strength;
      let nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;
      out[idx] = (nx * 0.5 + 0.5) * 255;
      out[idx + 1] = (ny * 0.5 + 0.5) * 255;
      out[idx + 2] = (nz * 0.5 + 0.5) * 255;
      out[idx + 3] = 255;
      idx += 4;
    }
  }
  return out;
}
