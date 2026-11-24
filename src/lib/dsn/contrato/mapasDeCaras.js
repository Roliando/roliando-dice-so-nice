/**
 * faceGeometry — geometría EXACTA de las caras de los dados DSN (G1, PLAN-EDITOR-DADOS).
 *
 * El motor pinta todas las caras de un dado en UN atlas de tiles de 256px
 * (DiceFactory.createMaterials): la cara de valor V vive en el tile `edgeOffset+(V-1)`
 * y los UVs de la geometría real (DICE_MODELS, chamfered) apuntan DENTRO de ese tile.
 * De ahí sacamos, por cara:
 *   - el POLÍGONO UV en coords del tile (0..256) = la forma exacta visible del lienzo
 *     256² que el Estudio pinta (lo de fuera se pierde en el dado);
 *   - el polígono 3D (mismos vértices) → DESPLIEGUE 2D (la red del dado, BFS por aristas
 *     adyacentes con colocación exacta y anti-solape);
 *   - la AFÍN red↔tile por cara (mínimos cuadrados sobre los vértices) para rebanar un
 *     dibujo continuo pintado sobre la red en texturas por-cara (y componer de vuelta).
 *
 * Solo matemáticas (sin DOM) → testeable en vitest/node. Las caras adyacentes NO comparten
 * vértices (hueco del chamfer): la adyacencia se detecta por aristas antiparalelas cercanas
 * y la red las SUELDA (arista sobre arista) para que el dibujo continúe de cara a cara.
 */
import { DICE_MODELS } from '../engine/DiceModels.js';

// Layout estándar del atlas por FORMA (réplica exacta de DiceFactory.createMaterials con
// las presets estándar): labelsLen = labels tras registerFaces ('' de canto incluidos).
// d2/d10 llevan UN tile de canto; el resto DOS. ts = pow2ceil(sqrt(labelsTotal)*256).
const SHAPE_LAYOUT = {
  d2: { sides: 2, labelsLen: 3, edgeOffset: 1 },
  d4: { sides: 4, labelsLen: 6, edgeOffset: 2 }, // row-0: [fondo, placeholder, t1..t4]
  d6: { sides: 6, labelsLen: 8, edgeOffset: 2 },
  d8: { sides: 8, labelsLen: 10, edgeOffset: 2 },
  d10: { sides: 10, labelsLen: 11, edgeOffset: 1 },
  d12: { sides: 12, labelsLen: 14, edgeOffset: 2 },
  d20: { sides: 20, labelsLen: 22, edgeOffset: 2 },
};
const TILE = 256;

// Caras editables por-cara en el Estudio. En el d4 el arte va al canal de FONDO del
// motor (debajo de sus números de esquina). El d100 usa la geometría del d10 con caras
// que VALEN 10..100 (getFaceMap las re-clava).
export function shapeForSides(sides) {
  return { 2: 'd2', 4: 'd4', 6: 'd6', 8: 'd8', 10: 'd10', 12: 'd12', 20: 'd20', 100: 'd10' }[sides] || null;
}

function layoutOf(shape) {
  const L = SHAPE_LAYOUT[shape];
  if (!L) return null;
  const labelsTotal = L.labelsLen; // presets estándar: sin herencia (d3/d5/d7/df no entran aquí)
  const perLine = Math.ceil(Math.sqrt(labelsTotal));
  const ts = Math.pow(2, Math.ceil(Math.log(Math.sqrt(labelsTotal) * TILE) / Math.log(2)));
  return { ...L, perLine, ts };
}

// ── vectores ────────────────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist3 = (a, b) => len3(sub(a, b));

// ── extracción por cara ─────────────────────────────────────────────────────
// Clasifica cada triángulo por el tile donde cae el centroide de sus UVs; los tiles de
// cara (índice ≥ edgeOffset) dan el valor; el chamfer cae en tiles de canto y se descarta.
function extractFaces(shape) {
  const geo = DICE_MODELS[shape]?.data;
  const L = layoutOf(shape);
  if (!geo || !L) return null;
  const pos = geo.attributes.position.array;
  const uv = geo.attributes.uv.array;
  const idx = geo.index.array;
  const tilesPerRow = L.ts / TILE; // columnas de 256 que caben (la rejilla usa perLine de ellas)

  const faces = new Map(); // value → { tris: [ [i,i,i] ], tileX, tileY }
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const cu = (uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3;
    const cv = (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3;
    const col = Math.floor(cu * tilesPerRow);
    const row = Math.floor(cv * tilesPerRow);
    if (col >= L.perLine) continue; // fuera de la rejilla de labels
    const tileIdx = row * L.perLine + col;
    const value = tileIdx - L.edgeOffset + 1;
    if (value < 1 || value > L.sides) continue; // canto / blank / sobrante
    let f = faces.get(value);
    if (!f) { f = { tris: [], tileX: col * TILE, tileY: row * TILE }; faces.set(value, f); }
    f.tris.push([a, b, c]);
  }

  // Por cara: dedupe vértices por posición (copias por-cara son bit-idénticas; cuantizamos
  // por si acaso) y bucle FRONTERA ordenado (aristas dirigidas que aparecen una sola vez).
  const out = new Map();
  for (const [value, f] of faces) {
    const keyOf = (i) => `${Math.round(pos[i * 3] * 500)},${Math.round(pos[i * 3 + 1] * 500)},${Math.round(pos[i * 3 + 2] * 500)}`;
    const vert = new Map(); // key → { p:[xyz], uv:[tile-local px] }
    const seen = new Map(); // "k1|k2" no-dirigida → count
    const dir = new Map();  // k1 → k2 (dirigida, según winding)
    for (const [a, b, c] of f.tris) {
      for (const [i, j] of [[a, b], [b, c], [c, a]]) {
        const ki = keyOf(i), kj = keyOf(j);
        if (ki === kj) continue;
        if (!vert.has(ki)) vert.set(ki, { p: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], uv: [(uv[i * 2] * L.ts) - f.tileX, (uv[i * 2 + 1] * L.ts) - f.tileY] });
        if (!vert.has(kj)) vert.set(kj, { p: [pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]], uv: [(uv[j * 2] * L.ts) - f.tileX, (uv[j * 2 + 1] * L.ts) - f.tileY] });
        const und = ki < kj ? `${ki}|${kj}` : `${kj}|${ki}`;
        seen.set(und, (seen.get(und) || 0) + 1);
        dir.set(`${ki}>${kj}`, [ki, kj]);
      }
    }
    const next = new Map();
    for (const [und, count] of seen) {
      if (count !== 1) continue; // interior
      const [k1, k2] = und.split('|');
      if (dir.has(`${k1}>${k2}`)) next.set(k1, k2);
      else next.set(k2, k1);
    }
    if (!next.size) continue;
    const start = next.keys().next().value;
    const loop = [start];
    for (let k = next.get(start); k && k !== start && loop.length <= next.size + 1; k = next.get(k)) loop.push(k);
    if (loop.length < 3) continue;
    out.set(value, {
      keys: loop,
      p3: loop.map((k) => vert.get(k).p),
      uvT: loop.map((k) => vert.get(k).uv), // px dentro del tile 256²
    });
  }
  return { faces: out, layout: L };
}

// ── despliegue (red) ────────────────────────────────────────────────────────
// Coords locales 2D de una cara: proyección sobre su plano (base ortonormal consistente
// con la normal EXTERIOR — el dado está centrado en el origen).
function localCoords(face) {
  const c = face.p3.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / face.p3.length);
  let n = [0, 0, 0];
  for (let i = 0; i < face.p3.length; i++) { // Newell
    const p = face.p3[i], q = face.p3[(i + 1) % face.p3.length];
    n = [n[0] + (p[1] - q[1]) * (p[2] + q[2]), n[1] + (p[2] - q[2]) * (p[0] + q[0]), n[2] + (p[0] - q[0]) * (p[1] + q[1])];
  }
  n = norm3(n);
  if (dot3(n, c) < 0) n = [-n[0], -n[1], -n[2]]; // exterior
  const e1 = norm3(sub(face.p3[0], c));
  const e2 = norm3(cross(n, e1));
  return face.p3.map((p) => { const d = sub(p, c); return [dot3(d, e1), dot3(d, e2)]; });
}

// Adyacencia entre caras por aristas casi-coincidentes (el chamfer las separa un poco):
// direcciones antiparalelas + extremos emparejados a < 35% del largo de arista.
function buildAdjacency(faces) {
  const edgesOf = (f) => f.keys.map((_, i) => ({ i, a: f.p3[i], b: f.p3[(i + 1) % f.p3.length] }));
  const adj = new Map(); // value → [{ other, myEdge:[i,i2], theirEdge:[j,j2] }]
  const vals = [...faces.keys()];
  for (const v of vals) adj.set(v, []);
  for (let x = 0; x < vals.length; x++) {
    for (let y = x + 1; y < vals.length; y++) {
      const A = faces.get(vals[x]), B = faces.get(vals[y]);
      let best = null;
      for (const ea of edgesOf(A)) {
        const la = dist3(ea.a, ea.b);
        for (const eb of edgesOf(B)) {
          const lb = dist3(eb.a, eb.b);
          // Umbral estricto: la pareja real dista ~2×hueco-de-chamfer (muy poco);
          // dos aristas que solo COMPARTEN UN VÉRTICE suman ~1 largo de arista.
          const tol = 0.35 * Math.min(la, lb);
          // La arista de B recorre en sentido contrario (winding exterior consistente).
          const d1 = dist3(ea.a, eb.b) + dist3(ea.b, eb.a);
          const d2 = dist3(ea.a, eb.a) + dist3(ea.b, eb.b);
          const d = Math.min(d1, d2);
          if (d < tol && (!best || d < best.d)) {
            best = { d, myEdge: ea.i, theirEdge: eb.i, swapped: d2 < d1 };
          }
        }
      }
      if (best) {
        adj.get(vals[x]).push({ other: vals[y], edge: best.myEdge, otherEdge: best.theirEdge, swapped: best.swapped });
        adj.get(vals[y]).push({ other: vals[x], edge: best.theirEdge, otherEdge: best.myEdge, swapped: best.swapped });
      }
    }
  }
  return adj;
}

// SAT para polígonos convexos (encogidos un 2% para tolerar la soldadura de aristas).
function polysOverlap(P, Q) {
  const shrink = (poly) => {
    const c = poly.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((v) => v / poly.length);
    return poly.map((p) => [c[0] + (p[0] - c[0]) * 0.96, c[1] + (p[1] - c[1]) * 0.96]);
  };
  const A = shrink(P), B = shrink(Q);
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ax = -(q[1] - p[1]), ay = q[0] - p[0];
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const v of A) { const d = v[0] * ax + v[1] * ay; if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const v of B) { const d = v[0] * ax + v[1] * ay; if (d < minB) minB = d; if (d > maxB) maxB = d; }
      if (maxA < minB || maxB < minA) return false; // eje separador
    }
  }
  return true;
}

// Similaridad (rotación+escala+traslación, SIN reflexión) que lleva l0→n0 y l1→n1.
function similarityFrom(l0, l1, n0, n1) {
  const dlx = l1[0] - l0[0], dly = l1[1] - l0[1];
  const dnx = n1[0] - n0[0], dny = n1[1] - n0[1];
  const den = dlx * dlx + dly * dly || 1;
  const sr = (dnx * dlx + dny * dly) / den;
  const si = (dny * dlx - dnx * dly) / den;
  const tx = n0[0] - (sr * l0[0] - si * l0[1]);
  const ty = n0[1] - (si * l0[0] + sr * l0[1]);
  return (p) => [sr * p[0] - si * p[1] + tx, si * p[0] + sr * p[1] + ty];
}

const side2 = (a, b, p) => Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
const centroid2 = (poly) => poly.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((v) => v / poly.length);

// Despliega todas las caras: BFS soldando aristas; el vecino cae al OTRO lado de la arista
// compartida (si no, se refleja su base local). Anti-solape con reintentos por otro padre.
function unfold(faces, adj) {
  const local = new Map();
  for (const [v, f] of faces) local.set(v, localCoords(f));
  const net = new Map(); // value → poly red
  const vals = [...faces.keys()].sort((a, b) => a - b);

  const placeComponent = (root, offsetX) => {
    const L0 = local.get(root);
    net.set(root, L0.map((p) => [p[0] + offsetX, p[1]]));
    const queue = [root];
    const tries = new Map();
    while (queue.length) {
      const cur = queue.shift();
      for (const link of adj.get(cur) || []) {
        if (net.has(link.other)) continue;
        const A = faces.get(cur), B = faces.get(link.other);
        const nA = net.get(cur);
        const i0 = link.edge, i1 = (link.edge + 1) % A.p3.length;
        const j0 = link.otherEdge, j1 = (link.otherEdge + 1) % B.p3.length;
        // extremos emparejados: sin swap, a↔b' (antiparalelas); con swap, a↔a'.
        const [m0, m1] = link.swapped ? [j0, j1] : [j1, j0];
        const lB = local.get(link.other);
        let cand = null;
        for (const flip of [false, true]) {
          const lb = flip ? lB.map((p) => [p[0], -p[1]]) : lB;
          const S = similarityFrom(lb[m0], lb[m1], nA[i0], nA[i1]);
          const poly = lb.map(S);
          // debe caer al lado CONTRARIO de la arista que el centro de la cara padre
          const sParent = side2(nA[i0], nA[i1], centroid2(nA));
          const sChild = side2(nA[i0], nA[i1], centroid2(poly));
          if (sChild !== 0 && sChild !== sParent) { cand = poly; break; }
        }
        if (!cand) continue;
        let collide = false;
        for (const [ov, opoly] of net) { if (ov !== cur && polysOverlap(cand, opoly)) { collide = true; break; } }
        if (collide) {
          const t = (tries.get(link.other) || 0) + 1;
          tries.set(link.other, t);
          if (t < 4) continue; // que lo intente otro padre más tarde
        }
        net.set(link.other, cand);
        queue.push(link.other);
      }
      // si la cola se vació pero quedan caras del componente sin colocar, re-sembrar
      if (!queue.length) {
        for (const v of vals) {
          if (net.has(v)) continue;
          const anyPlaced = (adj.get(v) || []).find((l) => net.has(l.other));
          if (anyPlaced) { queue.push(anyPlaced.other); break; }
        }
      }
    }
  };

  let prevMaxX = null;
  for (const v of vals) {
    if (net.has(v)) continue;
    const before = new Set(net.keys());
    placeComponent(v, 0); // componente nuevo (d2: segunda moneda) — se coloca crudo…
    const placedNow = [...net.keys()].filter((k) => !before.has(k));
    let cMinX = Infinity, cMaxX = -Infinity;
    for (const k of placedNow) for (const p of net.get(k)) { if (p[0] < cMinX) cMinX = p[0]; if (p[0] > cMaxX) cMaxX = p[0]; }
    if (prevMaxX != null) {
      // …y se DESPLAZA entero a la derecha del anterior (con hueco relativo al tamaño)
      const gap = (cMaxX - cMinX) * 0.18 + 1;
      const dx = prevMaxX + gap - cMinX;
      for (const k of placedNow) net.set(k, net.get(k).map((p) => [p[0] + dx, p[1]]));
      prevMaxX = prevMaxX + gap + (cMaxX - cMinX);
    } else {
      prevMaxX = cMaxX;
    }
  }
  return net;
}

// Afín 2D (6 dof) por mínimos cuadrados: src[i] → dst[i]. Devuelve [a,b,c,d,e,f] con
// x' = a·x + b·y + c ; y' = d·x + e·y + f. (Resuelve 2 sistemas 3×3 idénticos en diseño.)
function affineLSQ(src, dst) {
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = src.length;
  let bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    sxx += x * x; sxy += x * y; sx += x; syy += y * y; sy += y;
    bx0 += x * u; bx1 += y * u; bx2 += u;
    by0 += x * v; by1 += y * v; by2 += v;
  }
  // matriz normal simétrica M = [[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]]
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const solve3 = (b) => {
    const m = M.map((r) => r.slice());
    const v = b.slice();
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
      [m[col], m[piv]] = [m[piv], m[col]]; [v[col], v[piv]] = [v[piv], v[col]];
      const d = m[col][col] || 1e-12;
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const k = m[r][col] / d;
        for (let cc = col; cc < 3; cc++) m[r][cc] -= k * m[col][cc];
        v[r] -= k * v[col];
      }
    }
    return [v[0] / (m[0][0] || 1e-12), v[1] / (m[1][1] || 1e-12), v[2] / (m[2][2] || 1e-12)];
  };
  const [a, b, c] = solve3([bx0, bx1, bx2]);
  const [d, e, f] = solve3([by0, by1, by2]);
  return [a, b, c, d, e, f];
}
export const applyAffine = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2], M[3] * p[0] + M[4] * p[1] + M[5]];
export function invertAffine(M) {
  const [a, b, c, d, e, f] = M;
  const det = a * e - b * d || 1e-12;
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}

// ── API pública ─────────────────────────────────────────────────────────────
const cache = new Map();

/**
 * Mapa de caras de un dado (cacheado por forma):
 * { shape, sides, net:{w,h}, faces: { [valor]: { uvPolyTile (px 0..256, y-abajo),
 *   netPoly (px de red), netToTile, tileToNet, residual } } } — o null si la forma
 * no se soporta (d4/d100) o la geometría no cuadra.
 */
export function getFaceMap(sides) {
  // d100: misma lámina/tiles que el d10, pero las caras VALEN 10..100 (paso 10) — las
  // claves de perFace y del motor son valores de cara, no posiciones.
  if (sides === 100) {
    if (cache.has('d100')) return cache.get('d100');
    const base = getFaceMap(10);
    let out = null;
    if (base) {
      const faces = {};
      for (const [v, f] of Object.entries(base.faces)) faces[Number(v) * 10] = f;
      out = { ...base, sides: 100, faces };
    }
    cache.set('d100', out);
    return out;
  }
  const shape = shapeForSides(sides);
  if (!shape) return null;
  if (cache.has(shape)) return cache.get(shape);
  let result = null;
  try {
    const ex = extractFaces(shape);
    if (ex && ex.faces.size === ex.layout.sides) {
      const adj = buildAdjacency(ex.faces);
      const net = unfold(ex.faces, adj);
      // normaliza la red: margen 12px, escala → cara ≈ 240px de arista (cap 2048 total)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, edgeSum = 0, edgeN = 0;
      for (const poly of net.values()) {
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i], q = poly[(i + 1) % poly.length];
          edgeSum += Math.hypot(q[0] - p[0], q[1] - p[1]); edgeN++;
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        }
      }
      const avgEdge = edgeSum / Math.max(1, edgeN);
      let s = 240 / Math.max(1e-6, avgEdge);
      const M = 12;
      if ((maxX - minX) * s + 2 * M > 2048) s = (2048 - 2 * M) / (maxX - minX);
      if ((maxY - minY) * s + 2 * M > 2048) s = Math.min(s, (2048 - 2 * M) / (maxY - minY));
      const faces = {};
      let bad = false;
      for (const [v, f] of ex.faces) {
        // OJO: volteo vertical (maxY - y). El despliegue vive en Y-ARRIBA (matemática,
        // base exterior n×e1) y el tile/canvas en Y-ABAJO: sin el volteo, netToTile
        // llevaría una REFLEXIÓN y lo pintado en la red saldría EN ESPEJO en el dado.
        const netPoly = net.get(v)?.map((p) => [(p[0] - minX) * s + M, (maxY - p[1]) * s + M]);
        if (!netPoly) { bad = true; break; }
        const netToTile = affineLSQ(netPoly, f.uvT);
        let residual = 0;
        for (let i = 0; i < netPoly.length; i++) {
          const q = applyAffine(netToTile, netPoly[i]);
          residual = Math.max(residual, Math.hypot(q[0] - f.uvT[i][0], q[1] - f.uvT[i][1]));
        }
        faces[v] = {
          uvPolyTile: f.uvT,
          netPoly,
          netToTile,
          tileToNet: invertAffine(netToTile),
          residual,
        };
      }
      if (!bad) {
        result = {
          shape, sides: ex.layout.sides,
          net: { w: Math.ceil((maxX - minX) * s + 2 * M), h: Math.ceil((maxY - minY) * s + 2 * M) },
          faces,
        };
      }
    }
  } catch (e) {
    // Nunca rompemos el Estudio por geometría: sin mapa se cae a la rejilla clásica.
    console.warn('[faceGeometry]', shape, e);
    result = null;
  }
  cache.set(shape, result);
  return result;
}
