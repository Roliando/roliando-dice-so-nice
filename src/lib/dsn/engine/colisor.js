/**
 * colisor — la FORMA DE CHOQUE de un dado importado.
 *
 * Un dado con modelo propio rodaba con la colisión del dado estándar de su tipo (un d20 «de pega»): si el modelo era
 * un cubo alargado, un d20 aplastado o tenía bisel, la física lo trataba como un icosaedro perfecto y el modelo
 * se hundía o flotaba sobre la mesa y asentaba en caras que no eran las suyas. Aquí se saca del propio modelo su
 * CASCO CONVEXO (lo que cannon-es sabe chocar) y se reparte el valor de cada cara del casco entre las del dado
 * estándar por la normal más cercana. Lo que sale rueda como su forma real; si el dado es injusto (una cara más
 * ancha, un lado más pesado) se comporta como tal, y el aviso de justicia del estudio ya lo dice.
 *
 * Matemática pura sobre arrays (three solo aporta el casco): se prueba en node, sin DOM ni motor.
 *
 *   colisorDeModelo(puntos, { forma:'d20' }) → { vertices, faces, values, radio } | null
 *     vertices  [[x,y,z]] en unidades del modelo (el motor las escala como al modelo)
 *     faces     [[i,j,k,…]] polígonos con el antihorarios vistos desde fuera, como pide cannon-es
 *     values    valor del dado de cada cara del casco (el de la normal estándar más cercana)
 */
import { Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { DICE_SHAPE } from './DiceModels.js';

/** Tope de vértices del casco: un dado real tiene decenas; más es coste de choque sin ganancia. */
export const MAX_VERTICES_COLISOR = 64;
/** Dos caras del casco son la misma si sus normales difieren menos de ~1° y sus planos casi coinciden. */
const COS_COPLANAR = Math.cos((1 * Math.PI) / 180);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

/** Casco de una nube de puntos: { vs:[[x,y,z]], tris:[[i,j,k]] } (triángulos con la normal hacia fuera), o null. */
function cascoDe(puntos) {
  if (puntos.length < 4) return null;
  let hull;
  try { hull = new ConvexHull().setFromPoints(puntos.map((p) => new Vector3(p[0], p[1], p[2]))); } catch { return null; }
  const idx = new Map(); const vs = []; const tris = [];
  const id = (pt) => { let i = idx.get(pt); if (i === undefined) { i = vs.length; idx.set(pt, i); vs.push([pt.x, pt.y, pt.z]); } return i; };
  for (const f of hull.faces) {
    const t = []; let e = f.edge;
    do { t.push(id(e.head().point)); e = e.next; } while (e !== f.edge);
    for (let i = 1; i < t.length - 1; i++) tris.push([t[0], t[i], t[i + 1]]);
  }
  return tris.length >= 4 ? { vs, tris } : null;
}

/** Muestreo del punto más lejano: `n` vértices que conservan la silueta del casco. */
function lejanos(vs, n) {
  const c = vs.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((x) => x / vs.length);
  let primero = 0; let mayor = -1;
  vs.forEach((p, i) => { const d = dot(sub(p, c), sub(p, c)); if (d > mayor) { mayor = d; primero = i; } });
  const elegidos = [primero];
  const dist = vs.map((p) => { const d = sub(p, vs[primero]); return dot(d, d); });
  while (elegidos.length < n) {
    let mejor = -1; let md = -1;
    dist.forEach((d, i) => { if (d > md) { md = d; mejor = i; } });
    if (md <= 0) break;
    elegidos.push(mejor);
    vs.forEach((p, i) => { const d = sub(p, vs[mejor]); const q = dot(d, d); if (q < dist[i]) dist[i] = q; });
  }
  return elegidos.map((i) => vs[i]);
}

/** Une los triángulos coplanares del casco en polígonos con sus vértices en orden alrededor de la normal. */
function fusionarCoplanares(vs, tris, radio) {
  const info = tris.map((t) => {
    const n = unit(cross(sub(vs[t[1]], vs[t[0]]), sub(vs[t[2]], vs[t[0]])));
    return { t, n, d: dot(n, vs[t[0]]) };
  });
  const grupos = [];
  for (const f of info) {
    const g = grupos.find((x) => dot(x.n, f.n) >= COS_COPLANAR && Math.abs(x.d - f.d) <= radio * 0.004);
    if (g) g.tris.push(f.t); else grupos.push({ n: f.n, d: f.d, tris: [f.t] });
  }
  return grupos.map((g) => {
    const set = [...new Set(g.tris.flat())];
    const c = set.reduce((s, i) => [s[0] + vs[i][0], s[1] + vs[i][1], s[2] + vs[i][2]], [0, 0, 0]).map((x) => x / set.length);
    // base ortonormal del plano; el ángulo de cada vértice alrededor del centro da el orden (antihorario visto desde fuera)
    const u = unit(cross(Math.abs(g.n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], g.n));
    const w = cross(g.n, u);
    set.sort((a, b) => {
      const pa = sub(vs[a], c); const pb = sub(vs[b], c);
      return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u));
    });
    return { n: g.n, ids: set };
  });
}

/** Las normales (y valores) de las caras del dado estándar de esa forma; el 0 de relleno del motor no cuenta. */
export function normalesDeForma(forma) {
  const s = DICE_SHAPE[forma];
  if (!s?.vertices || !s.faces) return [];
  return s.faces.map((f, i) => ({
    valor: s.faceValues[i],
    normal: unit(cross(sub(s.vertices[f[1]], s.vertices[f[0]]), sub(s.vertices[f[2]], s.vertices[f[0]]))),
  })).filter((x) => x.valor !== 0);
}

/**
 * El colisor convexo de un modelo a partir de sus vértices (ya centrado, en el mismo marco que la malla y con el
 * giro de ajuste horneado). `forma` es la del dado estándar ('d4'…'d20') que reparte los valores. null si no hay
 * casco (nube plana o degenerada), si la forma no tiene caras estándar, si es la moneda o si el casco no cubre todos
 * los valores del dado: se queda la colisión estándar.
 */
export function colisorDeModelo(puntos, { forma, maxVertices = MAX_VERTICES_COLISOR } = {}) {
  const canon = normalesDeForma(forma);
  if (forma === 'd2' || !canon.length || !puntos?.length) return null;
  // sin duplicados (mallas con las aristas soldadas a medias repiten cada vértice varias veces)
  const visto = new Map();
  let radio = 0;
  for (const p of puntos) { radio = Math.max(radio, Math.hypot(p[0], p[1], p[2])); }
  if (!(radio > 0)) return null;
  const q = radio * 1e-4;
  for (const p of puntos) visto.set(`${Math.round(p[0] / q)},${Math.round(p[1] / q)},${Math.round(p[2] / q)}`, p);
  let casco = cascoDe([...visto.values()]);
  if (!casco) return null;
  if (casco.vs.length > maxVertices) casco = cascoDe(lejanos(casco.vs, maxVertices)) || casco;
  const polis = fusionarCoplanares(casco.vs, casco.tris, radio);
  if (polis.length < 4) return null;
  // cannon-es quiere cada cara antihoraria vista desde fuera (comprobado en colisor.test.js con ConvexPolyhedron real)
  const faces = polis.map((p) => [...p.ids]);
  const values = polis.map((p) => {
    let mejor = canon[0]; let m = -2;
    for (const c of canon) { const d = dot(p.n, c.normal); if (d > m) { m = d; mejor = c; } }
    return mejor.valor;
  });
  // Si algún valor del dado no sale en ninguna cara del casco (el modelo no está alineado con las caras del motor o le
  // falta una), el dado no podría sacar ese número: se queda la colisión estándar, que siempre los cubre todos.
  const cubiertos = new Set(values);
  if (canon.some((c) => !cubiertos.has(c.valor))) return null;
  return { vertices: casco.vs, faces, values, radio };
}

/**
 * Los vértices de las mallas de un modelo cargado (`scene.children[0]` y descendientes) en el marco de su raíz, con
 * una muestra si es muy denso (el casco no necesita medio millón de puntos). Acepta lo que tenga `geometry`.
 */
export function puntosDeEscena(raiz, { maximo = 20000 } = {}) {
  const puntos = [];
  const mallas = [];
  raiz.updateWorldMatrix?.(true, true);
  const inv = raiz.matrixWorld?.clone?.().invert?.();
  raiz.traverse((n) => { if (n.isMesh && n.geometry?.attributes?.position) mallas.push(n); });
  const total = mallas.reduce((s, m) => s + m.geometry.attributes.position.count, 0);
  const salto = Math.max(1, Math.floor(total / maximo));
  const v = new Vector3();
  for (const m of mallas) {
    const pos = m.geometry.attributes.position;
    const mat = inv ? inv.clone().multiply(m.matrixWorld) : m.matrixWorld;
    for (let i = 0; i < pos.count; i += salto) { v.fromBufferAttribute(pos, i).applyMatrix4(mat); puntos.push([v.x, v.y, v.z]); }
  }
  return puntos;
}
