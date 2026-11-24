import { describe, it, expect } from 'vitest';
import { generarContrato } from './contrato.js';
import guardado from '../../dice3d/formasDados.json';

describe('formasDados.json', () => {
  it('coincide con lo que da el motor (si falla: node scripts/dsn/generar-formas.mjs)', () => {
    expect(JSON.parse(JSON.stringify(generarContrato()))).toEqual(guardado);
  });
});
