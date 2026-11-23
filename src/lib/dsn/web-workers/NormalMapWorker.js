import { normalesDeRelieve } from '../engine/normalMapMath.js';

// Recibe { id, red: ArrayBuffer (canal rojo w*h), w, h, strength } y devuelve { id, rgba: ArrayBuffer }.
self.onmessage = (e) => {
  const { id, red, w, h, strength } = e.data;
  try {
    const rgba = normalesDeRelieve(new Uint8Array(red), w, h, strength);
    self.postMessage({ id, rgba: rgba.buffer }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
