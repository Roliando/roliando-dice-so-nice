/*
 * Alta, dentro del motor, de lo que traen los módulos importados: texturas, sistemas (caras con su propio
 * arte o símbolos), dados propios y colorsets. Llega como datos clonables (orden `registrar` de la página
 * del motor); aquí se mete en el motor sin pisar lo que ya tenía.
 */
import { getDsnEngine } from './DsnEngine.js';
import { TEXTURELIST } from './engine/DiceColors.js';

const hechas = new Set(); // firma de lo ya registrado (una vez por página)

// La forma de un dado propio (`dv` de 10 caras → d10), como DSN da de alta los términos del sistema:
// 3, 5 y 7 caras ruedan en d6, d10 y d14. Null si ya existe o no hay forma con esas caras.
function formaDe(motor, tipo, terminos) {
  const estandar = motor.DiceFactory?.systems?.get('standard')?.dice;
  if (!estandar || estandar.has(tipo)) return null;
  const caras = Number(terminos?.[tipo]);
  if (!(caras > 0)) return null;
  const forma = `d${[3, 5, 7].includes(caras) ? caras * 2 : caras}`;
  return estandar.has(forma) ? forma : null;
}

async function cargarFuentes(fuentes) {
  if (typeof FontFace === 'undefined') return;
  await Promise.allSettled(Object.entries(fuentes || {}).map(async ([familia, urls]) => {
    if ([...document.fonts].some((f) => f.family.replace(/["']/g, '') === familia)) return;
    const f = new FontFace(familia, urls.map((u) => `url("${u}")`).join(', '));
    await f.load();
    document.fonts.add(f);
  }));
}

/** Registra un lote de temas (`texturas`, `sistemas`, `presets`, `colorsets`, `fuentes`, `terminos`). */
export async function registrarLote(temas) {
  if (!temas) return;
  const motor = getDsnEngine();
  await motor.init();
  await cargarFuentes(temas.fuentes);
  const firma = (tipo, id) => `${tipo}:${id}`;
  await Promise.allSettled(Object.entries(temas.texturas || {}).map(([id, t]) => {
    if (hechas.has(firma('t', id)) || TEXTURELIST[id]) return null;
    hechas.add(firma('t', id));
    return motor.addTexture(id, { name: t.name || id, composite: t.composite || 'multiply', source: t.source || '', bump: t.bump || '', ...(t.emissive ? { emissive: t.emissive } : {}), ...(t.atlas ? { atlas: t.atlas } : {}) });
  }));
  for (const [id, s] of Object.entries(temas.sistemas || {})) {
    if (hechas.has(firma('s', id))) continue;
    hechas.add(firma('s', id));
    // Nunca «preferido»: ese cambio es global en el motor y pisaría los dados del resto de la app.
    try { motor.addSystem({ id, name: s.name, group: s.group }, 'default'); } catch (err) { console.warn('[dados de módulos] sistema', id, err); }
  }
  for (const p of temas.presets || []) {
    const id = `${p.system}/${p.type}`;
    if (hechas.has(firma('p', id))) continue;
    hechas.add(firma('p', id));
    const { forma, ...dado } = p;
    try { motor.addDicePreset(dado, forma || formaDe(motor, p.type, temas.terminos)); } catch (err) { console.warn('[dados de módulos] dado', id, err); }
  }
  for (const cs of Object.values(temas.colorsets || {})) {
    if (hechas.has(firma('c', cs.name))) continue;
    hechas.add(firma('c', cs.name));
    const { _modo, ...limpio } = cs;
    try { await motor.addColorset(limpio, 'default'); } catch (err) { console.warn('[dados de módulos] colores', cs.name, err); }
  }
}
