import { describe, it, expect } from 'vitest';
import { getFaceMap, shapeForSides, applyAffine, invertAffine } from './mapasDeCaras.js';

// SAT simple (independiente del de la lib) para verificar que la red no se solapa.
function overlap(P, Q) {
  const shrink = (poly) => {
    const c = poly.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((v) => v / poly.length);
    return poly.map((p) => [c[0] + (p[0] - c[0]) * 0.95, c[1] + (p[1] - c[1]) * 0.95]);
  };
  const A = shrink(P), B = shrink(Q);
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ax = -(q[1] - p[1]), ay = q[0] - p[0];
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const v of A) { const d = v[0] * ax + v[1] * ay; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const v of B) { const d = v[0] * ax + v[1] * ay; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

const SUPPORTED = [2, 4, 6, 8, 10, 12, 20];

describe('faceGeometry — polígonos de cara + red desplegada (geometría DSN real)', () => {
  it('formas soportadas y no soportadas', () => {
    expect(shapeForSides(20)).toBe('d20');
    expect(shapeForSides(4)).toBe('d4');  // arte al canal de FONDO (bajo los números de esquina)
    expect(shapeForSides(100)).toBe('d10'); // d100 = lámina del d10, caras que valen 10..100
    expect(shapeForSides(7)).toBeNull();
  });

  it('d100: mapa del d10 re-clavado a valores 10..100', () => {
    const d100 = getFaceMap(100);
    const d10 = getFaceMap(10);
    expect(d100).not.toBeNull();
    expect(d100.sides).toBe(100);
    expect(Object.keys(d100.faces).map(Number).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    // misma geometría cara a cara (100 ↔ 10, 30 ↔ 3…)
    expect(d100.faces[30].uvPolyTile).toEqual(d10.faces[3].uvPolyTile);
    expect(d100.faces[100].netPoly).toEqual(d10.faces[10].netPoly);
  });

  for (const sides of SUPPORTED) {
    describe(`d${sides}`, () => {
      const map = getFaceMap(sides);

      it('extrae TODAS las caras', () => {
        expect(map).not.toBeNull();
        expect(Object.keys(map.faces)).toHaveLength(sides);
        for (let v = 1; v <= sides; v++) expect(map.faces[v]).toBeTruthy();
      });

      it('el polígono UV de cada cara cae dentro del tile 256²', () => {
        for (const f of Object.values(map.faces)) {
          expect(f.uvPolyTile.length).toBeGreaterThanOrEqual(3);
          for (const [x, y] of f.uvPolyTile) {
            expect(x).toBeGreaterThanOrEqual(-4);
            expect(x).toBeLessThanOrEqual(260);
            expect(y).toBeGreaterThanOrEqual(-4);
            expect(y).toBeLessThanOrEqual(260);
          }
        }
      });

      it('la afín red→tile es exacta (residuo < 1px) y SIN reflexión (det>0)', () => {
        for (const f of Object.values(map.faces)) {
          expect(f.residual).toBeLessThan(1);
          // sin espejo: lo pintado en la red debe salir en el dado tal cual (no reflejado)
          const [a, b, , d, e] = f.netToTile;
          expect(a * e - b * d).toBeGreaterThan(0);
          // y la inversa vuelve (round-trip < 1px)
          const inv = invertAffine(f.netToTile);
          for (const p of f.netPoly) {
            const q = applyAffine(inv, applyAffine(f.netToTile, p));
            expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(1);
          }
        }
      });

      it('la red no se solapa y cabe en su lienzo', () => {
        const vals = Object.keys(map.faces);
        expect(map.net.w).toBeGreaterThan(100);
        expect(map.net.h).toBeGreaterThan(100);
        expect(map.net.w).toBeLessThanOrEqual(2600);
        expect(map.net.h).toBeLessThanOrEqual(2600);
        for (const v of vals) {
          for (const [x, y] of map.faces[v].netPoly) {
            expect(x).toBeGreaterThanOrEqual(-1);
            expect(y).toBeGreaterThanOrEqual(-1);
            expect(x).toBeLessThanOrEqual(map.net.w + 1);
            expect(y).toBeLessThanOrEqual(map.net.h + 1);
          }
        }
        for (let i = 0; i < vals.length; i++) {
          for (let j = i + 1; j < vals.length; j++) {
            expect(overlap(map.faces[vals[i]].netPoly, map.faces[vals[j]].netPoly),
              `caras ${vals[i]} y ${vals[j]} solapadas en la red del d${sides}`).toBe(false);
          }
        }
      });

      if (sides !== 2) {
        it('la red está SOLDADA (cada cara comparte arista con otra a < 2px)', () => {
          const vals = Object.keys(map.faces);
          let welded = 0;
          for (const v of vals) {
            const P = map.faces[v].netPoly;
            let touches = false;
            for (const w of vals) {
              if (w === v) continue;
              const Q = map.faces[w].netPoly;
              for (const p of P) {
                for (const q of Q) {
                  if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 2) { touches = true; break; }
                }
                if (touches) break;
              }
              if (touches) break;
            }
            if (touches) welded++;
          }
          expect(welded).toBe(vals.length); // todas conectadas a la lámina
        });
      }
    });
  }

  it('d2: dos discos separados (componentes aparte), polígono ~circular', () => {
    const map = getFaceMap(2);
    const f1 = map.faces[1], f2 = map.faces[2];
    expect(f1.uvPolyTile.length).toBeGreaterThanOrEqual(8); // borde redondo, muchos vértices
    expect(overlap(f1.netPoly, f2.netPoly)).toBe(false);
  });
});
