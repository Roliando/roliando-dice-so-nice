import { describe, it, expect } from 'vitest';
import { World, Body, Vec3, Plane, ConvexPolyhedron, Quaternion } from 'cannon-es';
import { colisorDeModelo, normalesDeForma } from './colisor.js';
import { DICE_SHAPE } from './DiceModels.js';

const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const esfericos = (forma, k = 100) => DICE_SHAPE[forma].vertices.map((v) => norm(v).map((x) => x * k));
const cajaDe = (hx, hy, hz) => { const p = []; for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [-hz, hz]) p.push([x, y, z]); return p; };

function aCannon(c, k = 1) {
  return new ConvexPolyhedron({ vertices: c.vertices.map((v) => new Vec3(v[0] * k, v[1] * k, v[2] * k)), faces: c.faces });
}

describe('colisor: casco convexo de un dado importado', () => {
  it('un cubo da 6 caras con los valores del d6 estándar', () => {
    const c = colisorDeModelo(cajaDe(100, 100, 100), { forma: 'd6' });
    expect(c.faces).toHaveLength(6);
    expect([...c.values].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('un icosaedro da 20 caras y reparte los 20 valores una vez cada uno', () => {
    const c = colisorDeModelo(esfericos('d20'), { forma: 'd20' });
    expect(c.faces).toHaveLength(20);
    expect([...c.values].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('cannon-es lo acepta con las normales hacia fuera (el orden de caras es el que le vale)', () => {
    for (const forma of ['d4', 'd6', 'd8', 'd12', 'd20']) {
      const c = colisorDeModelo(esfericos(forma), { forma });
      const cp = aCannon(c);
      expect(cp.faceNormals.length).toBe(c.faces.length);
      cp.faceNormals.forEach((n, i) => {
        const v = cp.vertices[c.faces[i][0]];
        expect(n.dot(v)).toBeGreaterThan(0);
      });
    }
  });

  it('un modelo con bisel y denso se simplifica al tope de vértices y sigue siendo un casco válido', () => {
    const pts = [];
    for (let i = 0; i < 4000; i++) { const u = (i * 0.618034) % 1; const v = (i * 0.414214) % 1; const th = 2 * Math.PI * u; const z = 2 * v - 1; const r = Math.sqrt(1 - z * z); pts.push([100 * r * Math.cos(th), 100 * r * Math.sin(th), 100 * z]); }
    const c = colisorDeModelo(pts, { forma: 'd20' });
    expect(c.vertices.length).toBeLessThanOrEqual(64);
    expect(() => aCannon(c)).not.toThrow();
  });

  it('una nube plana o la moneda no dan colisor (se queda la estándar)', () => {
    expect(colisorDeModelo([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], { forma: 'd6' })).toBeNull();
    expect(colisorDeModelo(cajaDe(1, 1, 1), { forma: 'd2' })).toBeNull();
    expect(colisorDeModelo([], { forma: 'd6' })).toBeNull();
  });

  it('el valor de cada cara es el de la normal estándar más cercana, con un giro de ajuste horneado', () => {
    const canon = normalesDeForma('d6');
    const c = colisorDeModelo(cajaDe(100, 100, 100), { forma: 'd6' });
    const cp = aCannon(c);
    cp.faceNormals.forEach((n, i) => {
      const mejor = canon.reduce((m, k) => (n.dot(new Vec3(...k.normal)) > n.dot(new Vec3(...m.normal)) ? k : m));
      expect(c.values[i]).toBe(mejor.valor);
    });
  });
});

/** Suelta N veces el colisor desde posturas distintas y cuenta qué cara queda arriba (el motor lee la más cercana a +Y). */
function tirar(c, veces, k = 1) {
  const cuenta = {};
  let semilla = 7;
  const azar = () => { semilla = (semilla * 16807) % 2147483647; return semilla / 2147483647; };
  for (let n = 0; n < veces; n++) {
    const w = new World({ gravity: new Vec3(0, -30, 0) });
    const suelo = new Body({ mass: 0, shape: new Plane() });
    suelo.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    w.addBody(suelo);
    const cuerpo = new Body({ mass: 1, shape: aCannon(c, k), position: new Vec3(0, 3, 0), angularDamping: 0.3, linearDamping: 0.05 });
    cuerpo.quaternion.setFromEuler(azar() * 6.28, azar() * 6.28, azar() * 6.28);
    cuerpo.angularVelocity.set(azar() * 6, azar() * 6, azar() * 6);
    w.addBody(cuerpo);
    for (let i = 0; i < 700; i++) w.step(1 / 60);
    const sh = cuerpo.shapes[0];
    let mejor = 0; let ang = -2;
    sh.faceNormals.forEach((nn, i) => { const r = cuerpo.quaternion.vmult(nn); if (r.y > ang) { ang = r.y; mejor = i; } });
    cuenta[c.values[mejor]] = (cuenta[c.values[mejor]] || 0) + 1;
  }
  return cuenta;
}

describe('colisor: rueda como su forma real', () => {
  it('un cubo asienta siempre plano sobre una cara', () => {
    const c = colisorDeModelo(cajaDe(1, 1, 1), { forma: 'd6' });
    const r = tirar(c, 12);
    expect(Object.values(r).reduce((a, b) => a + b, 0)).toBe(12);
  });

  it('un dado alargado (injusto) cae casi siempre sobre sus caras grandes y casi nunca sobre los extremos', () => {
    const c = colisorDeModelo(cajaDe(3, 1, 1), { forma: 'd6' });   // largo en X: las caras ±X son los extremos pequeños
    const extremos = c.faces.map((f, i) => ({ i, nx: Math.abs(aCannon(c).faceNormals[i].x) })).filter((x) => x.nx > 0.9).map((x) => c.values[x.i]);
    const r = tirar(c, 30);
    const enExtremos = extremos.reduce((s, v) => s + (r[v] || 0), 0);
    expect(enExtremos).toBeLessThanOrEqual(3);
  });
});
