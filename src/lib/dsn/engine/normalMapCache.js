// Mapas de normales de los dados: cache en memoria + IndexedDB y calculo fuera del hilo principal.
//
// El relieve de cada textura se convierte en mapa de normales (Sobel, ver normalMapMath.js). Era un
// bucle por pixel en el hilo principal (~590 ms al abrir el Estudio). Ahora:
//  1. la clave es un hash del relieve + tamano + fuerza: la misma textura no se vuelve a calcular;
//  2. si hay Worker, el lienzo se devuelve YA (plano) y se rellena cuando llega el resultado
//     (de IndexedDB como PNG sin perdida, o calculado en el Worker); el llamador recibe `alListo`;
//  3. sin Worker se calcula en el momento con la misma funcion (resultado identico).
import NormalMapWorker from '../web-workers/NormalMapWorker.js?worker';
import { normalesDeRelieve } from './normalMapMath.js';

const VERSION = 'n1';
const DB_NAME = 'roliando-dsn-normales';
const MAX_ENTRADAS_DB = 48;
const MAX_PX_MEMORIA = 8 * 1024 * 1024;

const memoria = new Map(); // clave -> { canvas, px, listos: bool, oyentes: [] }
let pxMemoria = 0;

function hashRelieve(red, w, h, strength) {
  // cyrb53 sobre palabras de 32 bits (rapido; el relieve es potencia de 2 en cada lado)
  let h1 = 0xdeadbeef ^ w, h2 = 0x41c6ce57 ^ h;
  const n4 = red.length >> 2;
  const words = new Uint32Array(red.buffer, red.byteOffset, n4);
  for (let i = 0; i < n4; i++) {
    const ch = words[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  for (let i = n4 << 2; i < red.length; i++) {
    h1 = Math.imul(h1 ^ red[i], 2654435761);
    h2 = Math.imul(h2 ^ red[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${VERSION}:${w}x${h}:${strength}:${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

// ---- IndexedDB (best effort: si falla, se calcula y ya)
let dbPromise = null;
function abrirDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('n');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}
const reqP = (r) => new Promise((res) => { r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
async function dbLeer(clave) {
  const db = await abrirDb(); if (!db) return null;
  try { return (await reqP(db.transaction('n').objectStore('n').get(clave)))?.blob || null; } catch { return null; }
}
async function dbEscribir(clave, blob) {
  const db = await abrirDb(); if (!db) return;
  try {
    const st = db.transaction('n', 'readwrite').objectStore('n');
    st.put({ blob, t: Date.now() }, clave);
    const n = await reqP(db.transaction('n').objectStore('n').count());
    if (n > MAX_ENTRADAS_DB) {
      const todas = await reqP(db.transaction('n').objectStore('n').getAll());
      const claves = await reqP(db.transaction('n').objectStore('n').getAllKeys());
      const orden = claves.map((k, i) => [k, todas[i]?.t || 0]).sort((a, b) => a[1] - b[1]).slice(0, n - MAX_ENTRADAS_DB);
      const w = db.transaction('n', 'readwrite').objectStore('n');
      for (const [k] of orden) w.delete(k);
    }
  } catch { /* sin cache persistente */ }
}

// ---- Worker
let worker = null; let sinWorker = false; let sigId = 1; const pendientes = new Map();
function obtenerWorker() {
  if (worker || sinWorker) return worker;
  try {
    worker = new NormalMapWorker();
    worker.onmessage = (e) => { const p = pendientes.get(e.data.id); if (!p) return; pendientes.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(new Uint8ClampedArray(e.data.rgba)); };
    worker.onerror = () => { sinWorker = true; worker = null; for (const [, p] of pendientes) p.rej(new Error('worker')); pendientes.clear(); };
  } catch { sinWorker = true; worker = null; }
  return worker;
}
function enWorker(red, w, h, strength) {
  const wk = obtenerWorker();
  if (!wk) return Promise.reject(new Error('sin worker'));
  return new Promise((res, rej) => { const id = sigId++; pendientes.set(id, { res, rej }); wk.postMessage({ id, red: red.buffer, w, h, strength }, [red.buffer]); });
}

function recortarMemoria() {
  for (const [k, e] of memoria) {
    if (pxMemoria <= MAX_PX_MEMORIA) break;
    if (!e.listos) continue; // lo que esta calculandose no se expulsa
    memoria.delete(k); pxMemoria -= e.px;
  }
}

function pintarRGBA(canvas, rgba, w, h) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
}

/**
 * Lienzo con el mapa de normales del relieve `srcCanvas`. Si el resultado no esta listo todavia
 * devuelve un lienzo plano y llama a `alListo` cuando se rellena (hay que marcar la textura sucia).
 */
export function normalCanvasDeRelieve(srcCanvas, strength, alListo) {
  let fuente = srcCanvas;
  // Tactil: el relieve ya sale desenfocado (3 pasadas) y el mapa de normales de 2048 px son 16 MB que subir a la GPU del
  // movil; a la mitad de resolucion se ve igual y pesa 4 veces menos. La fuerza se reparte para que la pendiente sea la misma.
  if (srcCanvas.width >= 2048 && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
    const m = document.createElement('canvas');
    m.width = srcCanvas.width >> 1; m.height = srcCanvas.height >> 1;
    const mc = m.getContext('2d');
    mc.imageSmoothingEnabled = true; mc.imageSmoothingQuality = 'high';
    mc.drawImage(srcCanvas, 0, 0, m.width, m.height);
    fuente = m; strength *= 0.5;
  }
  const w = fuente.width, h = fuente.height;
  const rgba = fuente.getContext('2d').getImageData(0, 0, w, h).data;
  const red = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < red.length; i++, j += 4) red[i] = rgba[j];
  const clave = hashRelieve(red, w, h, strength);

  const hit = memoria.get(clave);
  if (hit) {
    memoria.delete(clave); memoria.set(clave, hit); // LRU
    if (!hit.listos && alListo) hit.oyentes.push(alListo);
    return hit.canvas;
  }

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const entrada = { canvas, px: w * h, listos: false, oyentes: alListo ? [alListo] : [] };
  memoria.set(clave, entrada); pxMemoria += entrada.px;

  const terminar = () => { entrada.listos = true; recortarMemoria(); const o = entrada.oyentes; entrada.oyentes = []; for (const f of o) { try { f(); } catch { /* oyente */ } } };

  if (typeof Worker === 'undefined' || sinWorker || !obtenerWorker()) {
    pintarRGBA(canvas, normalesDeRelieve(red, w, h, strength), w, h);
    entrada.listos = true; entrada.oyentes = []; recortarMemoria();
    return canvas;
  }

  // plano (128,128,255): lo que da una pendiente 0
  const flat = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < flat.length; i += 4) { flat[i] = 128; flat[i + 1] = 128; flat[i + 2] = 255; flat[i + 3] = 255; }
  pintarRGBA(canvas, flat, w, h);

  (async () => {
    try {
      const blob = await dbLeer(clave);
      if (blob && typeof createImageBitmap === 'function') {
        try {
          const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
          const ctx = canvas.getContext('2d');
          ctx.globalCompositeOperation = 'copy';
          ctx.drawImage(bmp, 0, 0);
          bmp.close?.();
          terminar();
          return;
        } catch { /* PNG ilegible: se recalcula */ }
      }
      let res;
      try { res = await enWorker(red.slice(), w, h, strength); } catch { res = normalesDeRelieve(red, w, h, strength); }
      pintarRGBA(canvas, res, w, h);
      terminar();
      if (canvas.toBlob) canvas.toBlob((b) => { if (b) dbEscribir(clave, b); }, 'image/png');
    } catch {
      memoria.delete(clave); pxMemoria -= entrada.px;
      terminar();
    }
  })();
  return canvas;
}

/** Solo para pruebas. */
export function _vaciarCacheNormales() { memoria.clear(); pxMemoria = 0; }
