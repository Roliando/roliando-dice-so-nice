/*
 * ¿HAN DEJADO DE MOVERSE LOS DADOS A LA VISTA?
 *
 * El motor de física avisa del final de la tirada cuando termina su simulación, que puede ser bastante después de que los
 * dados se vean quietos (cola de movimiento diminuto, umbral de reposo). Esto mira la pose de cada dado en cada fotograma y
 * dice cuándo TODOS llevan quietos `quietoMs`: ese es el momento en que se enseña el resultado.
 *
 * Pura: no toca el DOM ni el motor. Cada muestra es `{ p: [x, y, z], q: [x, y, z, w], radio }`.
 */

export const QUIETUD = {
  /** Desplazamiento máximo por fotograma, como fracción del radio del dado. */
  epsPos: 0.005,
  /** Giro máximo por fotograma, en grados. */
  epsGrados: 0.5,
  /** Tiempo seguido sin moverse, en ms. */
  quietoMs: 130,
  /** Fotogramas quietos seguidos como mínimo (con la pantalla ahogada, dos fotogramas muy separados no prueban nada). */
  minFotogramas: 3,
};

/** Ángulo (grados) entre dos cuaterniones unitarios. */
export function anguloEntre(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}

/** ¿Se movió este dado más que el umbral entre dos muestras? */
export function seMovio(antes, ahora, { epsPos, epsGrados } = QUIETUD) {
  const radio = ahora.radio || antes.radio || 1;
  const dx = ahora.p[0] - antes.p[0];
  const dy = ahora.p[1] - antes.p[1];
  const dz = ahora.p[2] - antes.p[2];
  if (Math.hypot(dx, dy, dz) > epsPos * radio) return true;
  return anguloEntre(antes.q, ahora.q) > epsGrados;
}

/**
 * Detector con estado. `mirar(muestras, ahoraMs)` devuelve true la primera vez que todos los dados llevan `quietoMs` quietos.
 * Hace falta haber visto moverse a algún dado antes (un dado que aún no ha arrancado no cuenta como quieto), y que el número
 * de dados no cambie (un dado nuevo reinicia la cuenta).
 */
export function crearDetectorQuietud(opts = {}) {
  const cfg = { ...QUIETUD, ...opts };
  let previas = null;
  let desde = null;
  let vistoMoverse = false;
  let hecho = false;
  let quietos = 0;
  return {
    mirar(muestras, ahora) {
      if (hecho) return true;
      if (!muestras || !muestras.length) { previas = null; desde = null; return false; }
      if (!previas || previas.length !== muestras.length) {
        previas = muestras;
        desde = null;
        return false;
      }
      const movido = muestras.some((m, i) => seMovio(previas[i], m, cfg));
      previas = muestras;
      if (movido) { vistoMoverse = true; desde = null; quietos = 0; return false; }
      if (!vistoMoverse) return false;
      if (desde == null) desde = ahora;
      quietos += 1;
      if (ahora - desde >= cfg.quietoMs && quietos >= cfg.minFotogramas) { hecho = true; return true; }
      return false;
    },
    get quieto() { return hecho; },
  };
}
