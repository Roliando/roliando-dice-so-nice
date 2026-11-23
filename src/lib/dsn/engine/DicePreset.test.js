// DicePreset.loadTextureType: decide si cada label es IMAGEN (se carga) o TEXTO (se pinta
// como número). Las URLs de UploadFile llevan fragmento (`#lqip=1&mini=1`); antes caían a
// texto y el dado per-cara del Estudio pintaba la URL del bucket en lugar del arte.
import { describe, it, expect } from 'vitest';
import { DicePreset } from './DicePreset.js';

const fakeLoader = () => {
  const pedidas = [];
  return {
    pedidas,
    async load([url]) { pedidas.push(url); return { [url]: { source: 'img:' + url } }; },
  };
};

describe('DicePreset.loadTextureType', () => {
  it('carga como imagen las URLs del bucket con fragmento #lqip/#mini', async () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/uploads/1-abc.webp#lqip=1&mini=1';
    const loader = fakeLoader();
    const out = await new DicePreset('d6').loadTextureType(['1', url, '3'], {}, loader);
    expect(out[0]).toBe('1');
    expect(out[1]).toEqual({ source: 'img:' + url });
    expect(out[2]).toBe('3');
    expect(loader.pedidas).toEqual([url]);
  });

  it('acepta query string y extensión en mayúsculas', async () => {
    const loader = fakeLoader();
    const out = await new DicePreset('d6').loadTextureType(['a.PNG?v=2', 'b.jpg#x'], {}, loader);
    expect(out.map((t) => typeof t)).toEqual(['object', 'object']);
  });

  it('sigue tratando como texto los labels normales y los que solo contienen ".png"', async () => {
    const loader = fakeLoader();
    const out = await new DicePreset('d6').loadTextureType(['6', '9.', 'foo.png bar', ''], {}, loader);
    expect(out).toEqual(['6', '9.', 'foo.png bar', '']);
    expect(loader.pedidas).toEqual([]);
  });

  it('dataURL y blob: siguen yendo por imagen', async () => {
    const loader = fakeLoader();
    const out = await new DicePreset('d6').loadTextureType(['data:image/png;base64,AAA', 'blob:http://x/1'], {}, loader);
    expect(out.every((t) => typeof t === 'object')).toBe(true);
  });
});
