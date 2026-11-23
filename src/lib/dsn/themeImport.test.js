import { describe, it, expect } from 'vitest';
import { parseDsnTheme } from './themeImport';

describe('parseDsnTheme', () => {
  it('config export (appearance.global) → colorset con nombres de material', () => {
    const json = { name: 'Mi Tema', appearance: { global: {
      labelColor: '#ede2b2', diceColor: '#7a1a1a', outlineColor: 'black', edgeColor: '#e3e2ee',
      texture: 'fire', material: 'metal', font: 'Arial',
    }, d20: {} } };
    expect(parseDsnTheme(json)).toMatchObject({
      name: 'Mi Tema', foreground: '#ede2b2', background: '#7a1a1a', outline: 'black',
      edge: '#e3e2ee', texture: 'fire', material: 'metal', font: 'Arial',
    });
  });

  it('acepta string JSON y colorset suelto (foreground/background)', () => {
    const s = JSON.stringify({ name: 'Fuego', foreground: '#fc0', background: '#910200', texture: 'lava', material: 'glass' });
    expect(parseDsnTheme(s)).toMatchObject({ name: 'Fuego', foreground: '#fc0', background: '#910200', texture: 'lava', material: 'glass' });
  });

  it('toma el primer save si no hay appearance.global raíz', () => {
    const json = { saves: { Tema1: { appearance: { global: { labelColor: '#000', diceColor: '#0f0', material: 'wood' } } } } };
    expect(parseDsnTheme(json)).toMatchObject({ name: 'Tema1', foreground: '#000', background: '#0f0', material: 'wood' });
  });

  it('library export (dsnLibraryExport) → baseAppearance del primer dado', () => {
    const json = { dsnLibraryExport: true, dice: [{ name: 'Dragón', dieType: 'd20', baseAppearance: { labelColor: '#fff', diceColor: '#222', edgeColor: '#f00', material: 'chrome' } }] };
    expect(parseDsnTheme(json)).toMatchObject({ name: 'Dragón', foreground: '#fff', background: '#222', edge: '#f00', material: 'chrome' });
  });

  it('appearance suelto (labelColor/diceColor sin envoltura)', () => {
    expect(parseDsnTheme({ labelColor: '#fff', diceColor: '#123456' })).toMatchObject({ foreground: '#fff', background: '#123456' });
  });

  it('rellena defaults de material/textura ausentes', () => {
    expect(parseDsnTheme({ background: '#111' })).toMatchObject({ texture: 'none', material: 'auto', font: 'auto', foreground: 'custom' });
  });

  it('devuelve null si no reconoce nada', () => {
    expect(parseDsnTheme('no json')).toBeNull();
    expect(parseDsnTheme({ hola: 1 })).toBeNull();
    expect(parseDsnTheme(null)).toBeNull();
  });
});
