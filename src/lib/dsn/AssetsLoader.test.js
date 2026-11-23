// AssetsLoader: la carga de imágenes del motor DSN. Lo que se prueba aquí son los tres
// fallos que dejaban una skin rota hasta recargar la página — una imagen mala tumbaba el
// lote entero, la promesa rechazada se quedaba cacheada, y el <img> crudo y su envoltorio
// compartían clave de caché.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./foundryShim.js', () => ({ resolveDsnUrl: (u) => u }));

const { AssetsLoader } = await import('./AssetsLoader.js');

// Image de mentira: las urls que contienen 'rota' fallan, el resto cargan.
class FakeImage {
  set src(v) {
    this._src = v;
    queueMicrotask(() => (String(v).includes('rota') ? this.onerror?.() : this.onload?.()));
  }
  get src() { return this._src; }
  width = 256;
  height = 256;
}

beforeEach(() => {
  globalThis.Image = FakeImage;
  AssetsLoader.cache = {};
  AssetsLoader.imgCache = {};
});

describe('AssetsLoader.load', () => {
  it('una imagen rota NO tumba las demás del lote', async () => {
    const out = await new AssetsLoader().load(['buena-a.webp', 'rota.webp', 'buena-b.webp']);
    expect(Object.keys(out).sort()).toEqual(['buena-a.webp', 'buena-b.webp']);
    expect(out['buena-a.webp'].source).toBeInstanceOf(FakeImage);
    expect(out['buena-a.webp'].frame).toEqual({ x: 0, y: 0, w: 256, h: 256 });
  });

  // Antes: `Promise.all` rechazaba y `DiceColors.loadTextures` no tenía `.catch`, así que
  // la promesa de `addTexture` no se resolvía JAMÁS y la tirada se quedaba colgada.
  it('un lote entero de imágenes rotas resuelve (vacío), no se cuelga', async () => {
    await expect(new AssetsLoader().load(['rota-1.webp', 'rota-2.webp'])).resolves.toEqual({});
  });

  it('una carga fallida no envenena la caché: al reintentar se vuelve a pedir', async () => {
    await new AssetsLoader().load(['rota.webp']);
    expect(AssetsLoader.cache['rota.webp']).toBeUndefined();
    // La url pasa a funcionar (fallo de red puntual) → la siguiente carga la coge.
    const out = await new AssetsLoader().load(['rota.webp'.replace('rota', 'ya-va')]);
    expect(Object.keys(out)).toEqual(['ya-va.webp']);
  });

  it('el envoltorio cacheado sobrevive a la carga del <img> (no comparten clave)', async () => {
    await new AssetsLoader().load(['tex.webp']);
    // La caché de assets guarda el envoltorio { url: {source, frame} }, no el <img> pelado:
    // devolver el <img> hacía que `load()` sacara Object.keys(img)[0] = undefined y la
    // textura no llegara a registrarse → dado plano y oscuro.
    expect(AssetsLoader.cache['tex.webp']).toHaveProperty(['tex.webp', 'frame']);
    expect(AssetsLoader.imgCache['tex.webp']).toBeInstanceOf(FakeImage);
    const otra = await new AssetsLoader().load(['tex.webp']);
    expect(otra['tex.webp'].frame).toEqual({ x: 0, y: 0, w: 256, h: 256 });
  });
});
