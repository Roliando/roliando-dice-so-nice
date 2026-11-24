/*
 * Lo que el resto de Roliando necesita saber de la forma de los dados, sacado del motor una sola vez y
 * guardado como datos (`src/lib/dice3d/formasDados.json`):
 *   · `mapas`: por número de caras, dónde cae cada cara en su lámina de textura y la red desplegada
 *     del dado (lo que usa el editor para pintar cara a cara);
 *   · `normales`: por forma, la normal y el valor de cada cara (con lo que el estudio orienta un
 *     modelo importado).
 * Así el editor y el estudio no importan nada del motor: leen este archivo.
 *
 *   node scripts/dsn/generar-formas.mjs   # regenera el archivo tras cambiar la geometría del motor
 */
import { getFaceMap } from './mapasDeCaras.js';
import { normalesDeForma } from '../engine/colisor.js';

export const LADOS = [2, 4, 6, 8, 10, 12, 20];
export const FORMAS = ['d2', 'd4', 'd6', 'd8', 'd10', 'd12', 'd20'];

export function generarContrato() {
  const mapas = {};
  for (const l of LADOS) mapas[l] = getFaceMap(l);
  const normales = {};
  for (const f of FORMAS) normales[f] = normalesDeForma(f);
  return { version: 1, mapas, normales };
}
