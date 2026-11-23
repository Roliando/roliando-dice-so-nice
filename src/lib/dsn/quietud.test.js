import { describe, it, expect } from 'vitest';
import { crearDetectorQuietud, seMovio, anguloEntre } from './quietud';

const dado = (x, y = 0, z = 0, q = [0, 0, 0, 1], radio = 1) => ({ p: [x, y, z], q, radio });
const girado = (grados) => { const r = (grados * Math.PI) / 360; return [Math.sin(r), 0, 0, Math.cos(r)]; };

describe('quietud de los dados', () => {
  it('mide el ángulo entre poses', () => {
    expect(anguloEntre([0, 0, 0, 1], girado(10))).toBeCloseTo(10, 5);
  });
  it('un desplazamiento menor del 0,5 % del radio no cuenta, uno mayor sí', () => {
    expect(seMovio(dado(0), dado(0.004))).toBe(false);
    expect(seMovio(dado(0), dado(0.02))).toBe(true);
    expect(seMovio(dado(0), dado(0, 0, 0, girado(0.3)))).toBe(false);
    expect(seMovio(dado(0), dado(0, 0, 0, girado(2)))).toBe(true);
  });
  it('avisa a los 130 ms de quietud de todos los dados, no antes', () => {
    const d = crearDetectorQuietud();
    let t = 0;
    expect(d.mirar([dado(0), dado(5)], t)).toBe(false);
    for (let i = 1; i <= 10; i++) { t += 16; expect(d.mirar([dado(i * 0.3), dado(5 + i * 0.3)], t)).toBe(false); }
    for (let i = 0; i < 5; i++) { t += 16; expect(d.mirar([dado(3 + (i + 1) * 0.1), dado(8)], t)).toBe(false); }
    const fijo = [dado(3.5), dado(8)];
    expect(d.mirar(fijo, t + 16)).toBe(false);
    let ms = 16; let r = false;
    while (!r && ms < 400) { ms += 16; r = d.mirar(fijo, t + ms); }
    expect(r).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(130);
    expect(ms).toBeLessThanOrEqual(176);
  });
  it('un dado que aún no ha arrancado no cuenta como quieto', () => {
    const d = crearDetectorQuietud();
    for (let t = 0; t < 1000; t += 16) expect(d.mirar([dado(0)], t)).toBe(false);
  });
  it('un movimiento tardío reinicia la cuenta', () => {
    const d = crearDetectorQuietud();
    d.mirar([dado(0)], 0); d.mirar([dado(1)], 16);
    d.mirar([dado(1)], 32); d.mirar([dado(1)], 100);
    expect(d.mirar([dado(1.5)], 120)).toBe(false);
    expect(d.mirar([dado(1.5)], 200)).toBe(false);
    expect(d.mirar([dado(1.5)], 260)).toBe(false);
    expect(d.mirar([dado(1.5)], 340)).toBe(true);
  });
});
