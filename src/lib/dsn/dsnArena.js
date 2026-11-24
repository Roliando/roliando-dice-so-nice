/**
 * dsnArena.js — physics dice arena on the vendored Dice So Nice engine.
 *
 * Mirrors the public shape of the legacy arena (src/lib/dice3d/diceArena.js):
 *   initDsnArena(container, opts) / rollDsn(spec) / clearDsnArena() / resetDsnArena()
 * so the roll dispatcher can route to it behind a flag without touching callers.
 *
 * Results are PREDETERMINED: spec.values are the already-computed roll results;
 * DSN physics-simulates then rigs each die to land on its value (forcedResult →
 * swapDiceFace). So the value shown == the value passed in.
 */

import './foundryShim.js';
import { flushAudioPending } from './foundryShim.js';
import { Color, RepeatWrapping } from 'three';
import { DiceBox } from './rendering/DiceBox.js';
import { DsnEngine, getDsnEngine } from './DsnEngine.js';
import { TEXTURELIST, COLORSETS, DiceColors } from './engine/DiceColors.js';
import { crearDetectorQuietud } from './quietud.js';
import { paintScreens, screenLabelFor, plantScreenUpAnimated } from '@/lib/dice3d/dieScreen.js';

// ── Brillo REAL de detalle (emissive + bloom) ───────────────────────────────
// El pipeline de bloom del arena solo ilumina materiales EMISIVOS. Por defecto
// ningún colorset con textura emite → no brilla. Aquí marcamos texturas concretas
// como emisivas (su patrón brillante emite luz de un tinte) para que, p.ej., las
// ramas doradas brillen en oro de verdad. Clave = nombre de la textura (lo único
// que sobrevive intacto hasta createMaterial, que reconstruye appearance/materialData).
// Valor = tinte hex fijo, o 'accent' = deriva del color base del dado (materialData.
// background) → así un tema puede brillar en el COLOR DE ACENTO del usuario.
const GLOW_TEXTURES = {
  GoldenBranches: 0xffcc44, // ramas doradas → oro
  cosmic: 0x5b8cff,         // nebulosa → azul estelar
  orbs: 0xb060ff,           // orbes → violeta
  Hex: 0xffb020,            // panal → ámbar
  hell: 0xff4400,           // infierno → brasa
  lava: 0xff5a1e,           // lava/fuego → naranja
  fire: 0xff7a2a,
  stars: 0x9ab8ff,          // fuerza → destello
  skulls: 0xff2a2a,         // necrosis → rojo
  astral: 0x8a6bff,         // nebulosa astral → violeta
};
const GLOW_INTENSITY = 1.5;
// Texturas «de energía» que ADEMÁS fluyen (el mapa emisivo se desplaza) — no solo laten.
const FLOW_TEXTURES = new Set(['cosmic', 'hell', 'lava', 'fire', 'astral', 'stars']);

// ── Animación por-frame (pulso + flujo) ─────────────────────────────────────
// Materiales con glow registrados aquí «respiran» (emissiveIntensity oscila) y los de
// energía FLUYEN (offset del mapa emisivo). Un solo rAF con GATE por actividad (mientras
// haya tiradas vivas + ventana del hide) → cero coste con el arena quieto.
const animMats = new Set();
let animRAF = null;
let animUntil = 0;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0);

function animTick() {
  const now = nowMs();
  const t = now / 1000;
  let live = false;
  for (const m of animMats) {
    const a = m.userData && m.userData.__rolAnim;
    if (!a) continue;
    live = true;
    // Glow: pulso CENTRADO en base (nunca por debajo de ~0.82×) → respira sin apagarse.
    if (a.glow) m.emissiveIntensity = a.base * (1.0 + 0.18 * Math.sin(t * a.pulseSpeed));
    // Flujo: el mapa emisivo se desplaza → la energía fluye por las caras.
    if (a.flowMap) { a.flowMap.offset.x = (t * a.flowSpeed) % 1; a.flowMap.offset.y = (t * a.flowSpeed * 0.6) % 1; }
    // Iridiscente: el IOR de la interferencia oscila → el tornasol cambia solo (sin girar).
    if (a.iris) m.iridescenceIOR = 1.5 + 0.65 * Math.sin(t * a.irisSpeed);
  }
  // DSN detiene su render al asentar los dados → forzamos un dibujo mientras dure la
  // ventana, si no el pulso/flujo no se vería con el dado quieto (solo cambiaría el valor).
  if (live) { try { box?.diceScene?.renderScene?.(); } catch { /* sin escena */ } }
  if (activeThrows > 0 || now < animUntil) animRAF = requestAnimationFrame(animTick);
  else animRAF = null;
}
// Arranca/prolonga el loop de animación (lo llama cada tirada). Ventana = tirada + hide.
function pumpAnim() {
  animUntil = nowMs() + 4000;
  if (animRAF == null && typeof requestAnimationFrame !== 'undefined') animRAF = requestAnimationFrame(animTick);
}
// Registra un material con glow para animarlo. `flow` → mapa emisivo propio (clon con
// RepeatWrapping) que se desplaza: el brillo FLUYE mientras el número (difuso) se queda.
function registerGlowAnim(mat, base, flow) {
  let flowMap = null;
  if (flow && mat.emissiveMap) {
    // Clon del mapa EMISIVO (que lleva la textura) → al desplazarlo fluye el brillo del
    // patrón mientras el difuso (número) se queda quieto.
    try { flowMap = mat.emissiveMap.clone(); flowMap.wrapS = flowMap.wrapT = RepeatWrapping; flowMap.needsUpdate = true; mat.emissiveMap = flowMap; } catch { flowMap = null; }
  }
  mat.userData = mat.userData || {};
  mat.userData.__rolAnim = { glow: true, base, pulseSpeed: 2.4, flowMap, flowSpeed: 0.05 };
  animMats.add(mat);
}

// Registra un material IRIDISCENTE para animar su tornasol (IOR oscilante) aun quieto.
function registerIrisAnim(mat) {
  if (!mat || typeof mat.iridescenceIOR !== 'number') return;
  mat.userData = mat.userData || {};
  const prev = mat.userData.__rolAnim || {};
  mat.userData.__rolAnim = { ...prev, iris: true, irisSpeed: 0.9 };
  animMats.add(mat);
}

// Modelo 3D propio (F6): registra (una vez por URL+dado) un sistema+preset con `modelFile`
// = un GLB del usuario → ese modelo ES el dado (forma esculpida tipo therollsmith). La
// física usa la colisión estándar del tipo; el visual, el modelo. Devuelve el id del sistema.
function ensureModelSystem(engine, url, dieType, rot = null, scale = 1, physics = null) {
  const rotKey = Array.isArray(rot) && rot.some((n) => n) ? rot.join(',') : '';
  const sc = Number(scale) > 0 ? Math.max(0.5, Math.min(2.5, Number(scale))) : 1;
  const phys = physics === 'd6' || physics === 'd2' ? physics : null; // física prestada (caja/moneda)
  const sysId = 'rolmodel-' + hashStr(url + (rotKey ? `|${rotKey}` : '') + (sc !== 1 ? `|s${sc}` : '') + (phys ? `|p${phys}` : ''));
  try {
    if (!engine.DiceFactory.systems.get(sysId)) engine.addSystem({ id: sysId, name: sysId }, 'default');
    const sys = engine.DiceFactory.systems.get(sysId);
    if (sys && !sys.dice.has(dieType)) engine.addDicePreset({ type: dieType, system: sysId, modelFile: url, ...(rotKey ? { modelRotOffset: rot } : {}), ...(sc !== 1 ? { scaleModifier: sc } : {}), ...(phys ? { physicsShape: phys, noFaceSwap: true } : {}) }, dieType === 'd100' ? 'd10' : dieType);
    return sysId;
  } catch (e) { console.warn('[dsnArena] modelo', e); return 'standard'; }
}

// Parcha DiceFactory.createMaterial (una vez) para inyectar emissiveMap=map + tinte
// en las texturas de GLOW_TEXTURES tras crear el material. Idempotente por-proto.
function patchGlowMaterials(factory) {
  // DiceFactory.createTextMaterial lee este set al componer el canvas emisivo: dibuja el
  // PATRÓN de la textura en él → emite el detalle (ramas/orbes), no solo el número.
  globalThis.__rolGlowTextures = new Set(Object.keys(GLOW_TEXTURES));
  const proto = factory && Object.getPrototypeOf(factory);
  if (!proto || typeof proto.createMaterial !== 'function' || proto.__rolGlowPatched) return;
  const orig = proto.createMaterial;
  proto.createMaterial = function (cache, cacheStr, diceobj, materialData) {
    const mat = orig.call(this, cache, cacheStr, diceobj, materialData);
    try {
      const texName = materialData?.texture?.name;
      const tint = texName != null ? GLOW_TEXTURES[texName] : undefined;
      if (tint !== undefined && mat && mat.emissive && (mat.emissiveMap || mat.map)) {
        // El canvas emisivo de DSN ya lleva la textura (patrón) → el DETALLE emite el
        // tinte y el bloom lo recoge. Fallback al difuso si no hubiese canvas emisivo.
        if (!mat.emissiveMap) mat.emissiveMap = mat.map;
        mat.emissive = new Color(tint);
        if (this.realisticLighting && mat.emissive.convertLinearToSRGB) mat.emissive.convertLinearToSRGB();
        mat.emissiveIntensity = GLOW_INTENSITY;
        mat.needsUpdate = true;
        registerGlowAnim(mat, GLOW_INTENSITY, FLOW_TEXTURES.has(texName)); // pulso (+flujo)
      }
      // Acabado iridiscente → tornasol animado (aunque el dado esté quieto).
      if (materialData?.material === 'iridescent') registerIrisAnim(mat);
    } catch { /* material normal */ }
    return mat;
  };
  proto.__rolGlowPatched = true;
}

// dice-box-threejs material names → DSN material names
const DSN_MATERIAL = {
  chrome: 'chrome', glass: 'glass', frosted: 'glass', iridescent: 'iridescent', iris: 'iridescent',
  metal: 'metal', nacar: 'velvet', velvet: 'velvet', none: 'none', oro: 'metal', gold: 'metal',
  plastic: 'none', wood: 'wood', stone: 'none', auto: 'auto',
};

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Texturas de skin ya pedidas al motor: id → Promise<¿cargada?>. Es el candado que
// impide que una segunda tirada use una textura que aún está bajando (ver
// resolveSkinTexture). Una carga fallida se borra del mapa para poder reintentarla.
const texReady = new Map();

/**
 * Register a skin's custom texture (bucket URL or live studio canvas + optional
 * bump + composite) with DSN and return its texture id. Catalog skins already
 * reference DSN texture names directly (fire/marble/wood…), so those pass through.
 * @returns {Promise<string>} a DSN texture id ('none' if the skin has none)
 */
async function resolveSkinTexture(engine, cs) {
  // 1) custom/packed texture — a URL (__tex) or a live canvas (__img)
  if (cs.__tex || cs.__img) {
    // `__img` llega como lienzo vivo (mismo documento) o ya como URL de datos (cuando cruza desde la app).
    let source = cs.__tex;
    if (!source && typeof cs.__img === 'string') source = cs.__img;
    if (!source && cs.__img?.toDataURL) { try { source = cs.__img.toDataURL(); } catch { source = null; } }
    if (!source) return 'none';
    const bump = cs.__bump || '';
    const composite = cs.__composite || 'multiply';
    // Mapa EMISIVO de la skin (capas de brillo del Estudio): url del bucket o canvas
    // en vivo → el motor lo dibuja en el canal emisivo del tile (LUZ de verdad).
    let emissive = cs.__glowTex || '';
    if (!emissive && typeof cs.__glowImg === 'string') emissive = cs.__glowImg;
    if (!emissive && cs.__glowImg?.toDataURL) { try { emissive = cs.__glowImg.toDataURL(); } catch { emissive = ''; } }
    const id = 'rol-' + hashStr(`${typeof source === 'string' ? source.slice(0, 160) : 'live'}|${bump}|${composite}|${typeof emissive === 'string' ? emissive.slice(0, 120) : ''}`);
    // Se espera la PROMESA de carga, no la entrada de TEXTURELIST. `addTexture` escribe
    // TEXTURELIST[id] de forma SÍNCRONA y carga la imagen después, así que un `if
    // (!TEXTURELIST[id])` dejaba pasar de largo a la segunda resolución (otra tirada
    // encadenada, otro dado) mientras la imagen aún bajaba: DiceColors.getTexture no la
    // encontraba, devolvía {name:''} y DiceFactory se saltaba el dibujo → dado con el
    // color de cuerpo pelado, oscuro y sin diseño, «a veces». Con el mapa de promesas
    // todos esperan la MISMA carga; si falla se olvida para poder reintentarla luego.
    if (!texReady.has(id)) {
      texReady.set(id, engine.addTexture(id, { name: id, composite, source, bump, emissive })
        .then(() => !!DiceColors.diceTextures[id])
        .catch((e) => { console.warn('[dsnArena] addTexture', e); return false; }));
    }
    if (!await texReady.get(id)) { texReady.delete(id); return 'none'; }
    return id;
  }
  // 2) catalog named texture is already a DSN texture name
  if (cs.texture && cs.texture !== 'none') return cs.texture;
  return 'none';
}

/**
 * Map a Roliando colorset (from the legacy arena's skin resolution) to a DSN
 * appearance in Foundry-named fields, registering its custom texture if any.
 */
// Skins with a glow effect (fx or a glow map) → the numbers/labels glow. DSN
// drives this from a colorset flag (emissiveLabels). We register ONE reusable
// 'rolglow' colorset that sets emissiveLabels but leaves everything else custom,
// so colors/texture/material still come from the per-roll appearance.
const GLOW_COLORSET = 'rolglow';
async function ensureGlowColorset(engine) {
  if (COLORSETS[GLOW_COLORSET]) return;
  await engine.addColorset({
    name: GLOW_COLORSET, description: 'Roliando glow',
    foreground: 'custom', background: 'custom', outline: '', edge: '',
    texture: 'custom', material: 'custom', font: 'custom',
    emissiveLabels: true,
  }, 'default');
}
function skinHasGlow(cs) {
  return !!(cs.__fx || cs.__glowTex || cs.__glowImg);
}

// Per-face images: build a dynamic preset that clones the standard die's labels
// and swaps in the skin's per-face image on the given faces. Registered under a
// unique system so it doesn't collide with the standard dice.
export async function ensurePerFacePreset(engine, sides, cs) {
  const facesSpec = cs.__facesSpec || null;   // { faceValue: url }
  const faceImgs = cs.__faceImgs || null;     // { faceValue: canvas }  (studio live)
  if (!facesSpec && !faceImgs) return 'standard';
  const type = sides === 100 ? 'd100' : `d${sides}`;
  const base = engine.DiceFactory.get(type);
  if (!base || !Array.isArray(base.labels)) return 'standard';

  // d4: el arte per-cara va al canal de FONDO (backgrounds) — DEBAJO de los números de
  // esquina (tripletes), que el motor sigue pintando encima (o quita rolHideNumbers).
  // El swap de labels normal es imposible en d4: sus labels son tripletes por vértice.
  if (base.shape === 'd4') {
    const merged = { ...(facesSpec || {}) };
    if (faceImgs) for (const k of Object.keys(faceImgs)) { try { merged[k] = faceImgs[k]?.toDataURL ? faceImgs[k].toDataURL() : faceImgs[k]; } catch { /* noop */ } }
    const slots = ['', '', '', ''];
    for (const [face, img] of Object.entries(merged)) {
      const vi = parseInt(face, 10) - 1;
      if (vi >= 0 && vi < 4 && typeof img === 'string' && img) slots[vi] = img;
    }
    if (!slots.some(Boolean)) return 'standard';
    // huecos → transparente 1×1 (registerFaces SALTA entradas falsy y desalinearía índices)
    const filler = transparentDataUrl();
    const bg = slots.map((u) => u || filler);
    const glowSet4 = cs.__facesGlow instanceof Set ? cs.__facesGlow
      : (Array.isArray(cs.__facesGlow) ? new Set(cs.__facesGlow.map(Number)) : null);
    const bgEmissive = glowSet4 && glowSet4.size
      ? slots.map((u, i) => (glowSet4.has(i + 1) && u ? u : blackDataUrl()))
      : null;
    const sysId = 'rolface-' + hashStr(`${type}|bg:${slots.map((u) => (u ? u.slice(0, 40) : '')).join(',')}|${glowSet4 ? [...glowSet4].sort().join(',') : ''}|${cs.name || ''}`);
    if (!engine.DiceFactory.systems.get(sysId)) {
      engine.addSystem({ id: sysId, name: sysId }, 'default');
      engine.addDicePreset({
        type, labels: ['1', '2', '3', '4'],
        backgrounds: { labels: bg, ...(bgEmissive ? { emissiveMaps: bgEmissive } : {}) },
        ...(bgEmissive ? { emissive: 0xffffff, emissiveIntensity: 1.6 } : {}),
        system: sysId,
      }, 'd4');
    }
    return sysId;
  }

  const baseLabels = Array.isArray(base.labels[0]) ? base.labels[0] : base.labels;
  const faceCount = base.values?.length || sides;
  const edgeOffset = Math.max(0, baseLabels.length - faceCount);

  const faces = { ...(facesSpec || {}) };
  if (faceImgs) for (const k of Object.keys(faceImgs)) { try { faces[k] = faceImgs[k]?.toDataURL ? faceImgs[k].toDataURL() : faceImgs[k]; } catch {} }

  // OJO 1: la clave de cara es el VALOR de la cara, no su posición — el d100 vale
  // 10..100 (paso 10): índice via base.values.indexOf(valor).
  // OJO 2 (corrimiento): a addDicePreset hay que pasar SOLO los labels de CARA:
  // registerFaces vuelve a prepender los '' de canto al cargar el preset — pasarlos
  // con canto los DUPLICABA y corría todas las caras (+2; +1 en d2/d10/d100):
  // caras vacías sin número, números en la cara equivocada y arte desplazado.
  const values = Array.isArray(base.values) ? base.values : [];
  const viOfFace = (face) => {
    const v = parseInt(face, 10);
    const vi = values.indexOf(v);
    return vi >= 0 ? vi : (v >= 1 && v <= faceCount ? v - 1 : -1);
  };
  const faceLabels = baseLabels.slice(edgeOffset); // solo caras, sin tiles de canto
  const keys = [];
  for (const [face, img] of Object.entries(faces)) {
    if (!img) continue;
    const vi = viOfFace(face);
    if (vi >= 0 && vi < faceLabels.length) { faceLabels[vi] = img; keys.push(face); }
  }
  if (!keys.length) return 'standard';

  // Efectos por cara (F5): caras marcadas para BRILLAR (cs.__facesGlow) → mapa emisivo por
  // cara = el arte de esa cara (sus zonas claras EMITEN); las demás, negro (no emiten). El
  // material emite en blanco → solo las caras con glow lucen, no los números.
  const glowSet = cs.__facesGlow instanceof Set ? cs.__facesGlow
    : (Array.isArray(cs.__facesGlow) ? new Set(cs.__facesGlow.map(Number)) : null);
  let emissiveMaps = null;
  if (glowSet && glowSet.size) {
    const black = blackDataUrl();
    emissiveMaps = faceLabels.map(() => black); // por CARA (registerFaces prepende el canto)
    for (const face of glowSet) {
      const vi = viOfFace(face);
      if (faces[face] && vi >= 0 && vi < emissiveMaps.length) emissiveMaps[vi] = faces[face];
    }
  }

  const sysId = 'rolface-' + hashStr(`${type}|${keys.sort().join(',')}|${glowSet ? [...glowSet].sort().join(',') : ''}|${cs.name || ''}`);
  if (!engine.DiceFactory.systems.get(sysId)) {
    engine.addSystem({ id: sysId, name: sysId }, 'default');
    engine.addDicePreset({ type, labels: faceLabels, ...(emissiveMaps ? { emissiveMaps, emissive: 0xffffff, emissiveIntensity: 1.6 } : {}), system: sysId }, base.shape);
  }
  return sysId;
}

// PNG transparente 1×1 (cache): relleno de slots vacíos del fondo per-cara del d4.
let _transUrl = null;
function transparentDataUrl() {
  if (_transUrl) return _transUrl;
  try {
    const c = document.createElement('canvas'); c.width = c.height = 1;
    c.getContext('2d'); // contexto creado; el canvas queda transparente
    _transUrl = c.toDataURL('image/png');
  } catch { _transUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; }
  return _transUrl;
}

// PNG negro 8×8 (cache) para las caras que NO brillan (mapa emisivo = negro → no emiten).
let _blackUrl = null;
function blackDataUrl() {
  if (_blackUrl) return _blackUrl;
  try {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const x = c.getContext('2d'); x.fillStyle = '#000000'; x.fillRect(0, 0, 8, 8);
    _blackUrl = c.toDataURL('image/png');
  } catch { _blackUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; }
  return _blackUrl;
}

export async function appearanceFromRoliandoColorset(cs, sides) {
  const engine = getDsnEngine();
  await engine.init();
  // Tema NATIVO de DSN: resolvemos el colorset a campos EXPLÍCITOS (colorset:'custom')
  // conservando colores (arrays multicolor → variedad por dado), textura y material del
  // tema, pero SIN el contorno marcado del número — el outline propio de varios temas DSN
  // (negro/granate) se veía muy fuerte y ajeno al tema. generateMaterialData acepta
  // fg/bg como array o string; una textura nombrada (marble/skulls…) se resuelve en create.
  if (cs.__dsnColorset) {
    const dc = COLORSETS[cs.__dsnColorset] || {};
    return {
      colorset: 'custom',
      labelColor: dc.foreground, diceColor: dc.background,
      outlineColor: '', edgeColor: dc.edge || '',
      texture: Array.isArray(dc.texture) ? dc.texture : (dc.texture || 'none'),
      material: dc.material || 'auto',
      // La fuente del tema (los de módulos de Foundry traen la suya, ya cargada por FontFace).
      system: 'standard', font: typeof dc.font === 'string' && dc.font !== 'custom' ? dc.font : 'auto',
    };
  }
  // Set de NMD (arte por-cara): el `system` monta las caras; el cuerpo/canto toman el color
  // representativo del set (preview del catálogo, en cs.foreground/background) para no
  // enseñar un gris ajeno. Sin outline marcado.
  if (cs.__dsnSystem) {
    const bg = Array.isArray(cs.background) ? cs.background[0] : cs.background;
    return {
      colorset: 'custom',
      labelColor: cs.foreground || '#efe7d8', diceColor: bg || '#2a2a2a',
      outlineColor: '', edgeColor: bg || '#2a2a2a',
      texture: 'none', material: 'auto',
      system: cs.__dsnSystem, font: 'auto',
    };
  }
  // Cuerpo: la LISTA entera si la skin trae varios colores. El motor elige uno al azar
  // POR DADO (DiceFactory ~L2247) y usa el mismo índice para el canto, que es justo lo
  // que enseña el visor del Estudio. Antes se colapsaba a `background[0]` y la tirada
  // salía siempre del primer color —el más oscuro de la pareja— mientras la preview
  // enseñaba los dos: el «se ven más oscuros al tirar» era esto.
  const bgList = Array.isArray(cs.background) ? cs.background.filter(Boolean) : null;
  const bg = bgList?.length ? (bgList.length > 1 ? bgList : bgList[0]) : cs.background;
  const texture = await resolveSkinTexture(engine, cs);
  let colorset = 'custom';
  if (skinHasGlow(cs)) { await ensureGlowColorset(engine); colorset = GLOW_COLORSET; }
  let system = 'standard';
  try { system = await ensurePerFacePreset(engine, sides, cs); } catch (e) { console.warn('[dsnArena] perFace', e); }
  // Modelo 3D propio (F6b): un GLB del usuario reemplaza la forma → sistema con modelFile.
  if (cs.__model) system = ensureModelSystem(engine, cs.__model, sides === 100 ? 'd100' : `d${sides}`, cs.__modelRot || null, cs.__modelScale || 1, cs.__modelPhysics || null);
  return {
    colorset,
    labelColor: cs.foreground || '#f7efe0',
    diceColor: bg || '#8a1f1f',
    outlineColor: cs.outline && cs.outline !== 'none' ? cs.outline : '#000000',
    edgeColor: cs.edge || bg || '#8a1f1f',
    texture,
    material: DSN_MATERIAL[cs.material] || 'auto',
    system,
    font: 'auto',
    // Roliando: skin sin números (el usuario pinta los suyos) y canto con la textura
    // (bisel sin banda que corte el diseño). Los lee createTextMaterial.
    ...(cs.__hideNumbers ? { rolHideNumbers: true } : {}),
    ...(cs.__edgeTex ? { rolEdgeTexture: true } : {}),
  };
}

let box = null;
let readyPromise = null;
let containerEl = null;
// Tiradas VIVAS (rodando o encoladas). clearDsnArena lo respeta: el auto-borrado
// de UNA tirada (timer de 4s por tirada) no debe borrar los dados de OTRA en
// vuelo — esa interferencia es la que colgaba las tiradas rápidas de skins.
let activeThrows = 0;
// Clear PEDIDO pero diferido porque había una tirada viva. Antes clearDsnArena hacía
// `return` seco al chocar con activeThrows>0 y NO se reintentaba → los dados quedaban
// pegados en pantalla para siempre (tirar muchas veces rápido / cambiar de menú). Ahora
// se recuerda y flushBatches lo ejecuta al drenar.
let clearWanted = false;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// El auto-escalado de DSN sale más grande que la lib vieja (y penetra el suelo
// físico en pantallas grandes → dados clavados). Reducimos la escala del dado por
// un factor: sigue proporcional a la pantalla pero más chico. La escala está en
// metros (~0.04), no en las unidades 100 de la lib vieja.
const DICE_SCALE_FACTOR = 0.9;

function resolveEl(container) {
  if (!container) return document.querySelector('#dice-arena');
  return typeof container === 'string' ? document.querySelector(container) : container;
}

// Móvil/tablet/gama-baja: puntero grueso (táctil). Sirve para aligerar el
// pipeline 3D (pixelRatio, sombras, cristal) y evitar cuelgues en dispositivos modestos.
function isMobileLike() {
  try {
    if (typeof window === 'undefined') return false;
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
    // Tablet incluida: un iPad (1024-1366 de ancho) es tan táctil y modesto como un móvil para
    // el 3D; con el corte de 820 px se llevaba sombras y cristal a pleno.
    return !!coarse;
  } catch { return false; }
}

export function initDsnArena(container = '#dice-arena', opts = {}) {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const engine = getDsnEngine();
    await engine.init(); // factory + colorsets + NMD
    patchGlowMaterials(engine.DiceFactory); // brillo real de detalle (emissive+bloom)

    const el = resolveEl(container);
    if (!el) throw new Error('dsnArena: contenedor no encontrado');
    containerEl = el;
    const width = el.clientWidth || window.innerWidth;
    const height = el.clientHeight || window.innerHeight;

    const config = {
      ...DsnEngine.DEFAULT_OPTIONS,
      boxType: 'board',
      dimensions: { width, height, margin: { top: 0, right: 0, bottom: 0, left: 0 } },
      autoscale: true,
      scale: 75,
      sounds: true,
      soundsVolume: 0.5,
      soundsSurface: 'felt',
      muteSoundSecretRolls: false,
      showExtraDice: false,
      immersiveDarkness: false, // no Foundry canvas darkness behind us
      visibility: 'all',
      speed: 1, // velocidad original (natural); el delay al encolar no molesta
      throwingForce: 'medium',
      ...opts,
    };

    // Móvil: aligerar el pipeline para no colgar la gama media — pixelRatio 1 (evita el
    // 4-9× de píxeles de un DPR 2-3), sombras bajas (mapa 1024 vs 4096), sin cristal
    // avanzado (quita el AA + shader de transmisión caro). Se CONSERVA el glow (bloom),
    // que es la identidad visual de las skins pro. Nada de esto toca el motor vendorizado.
    if (isMobileLike()) {
      config.useHighDPI = false;
      config.shadowQuality = 'low';
      config.advancedGlass = false;
      config.antialiasing = 'none';
    }

    box = new DiceBox(el, engine.DiceFactory, config);
    engine.box = box; // game.dice3d.box — DiceFactory.createMaterial reads box.anisotropy
    await box.initialize();
    // Preload the hit/surface audio buffers NOW (decode needs no user gesture, only
    // playback does) so the very first roll isn't silent — the sim consumes the sound
    // table the instant it returns, before a lazy first-roll preload could finish.
    try { flushAudioPending(); } catch { /* audio best-effort */ }
    // shrink the dice a notch so they aren't oversized / don't clip the floor.
    // NOTE: the box exposes the factory as `dicefactory` (lowercase); use the
    // engine's reference (same object) which drives dice geometry + physics.
    try {
      const sc = box.diceScene?.display?.scale;
      if (sc) engine.DiceFactory.setScale(sc * DICE_SCALE_FACTOR);
    } catch { /* ignore */ }
    // El terreno de la mesa 3D, si lo hay: la caja nueva nace con un mundo físico vacío.
    await aplicarTerreno();
    return box;
  })().catch((e) => {
    console.error('[dsnArena] init falló', e);
    readyPromise = null;
    box = null;
    throw e;
  });
  return readyPromise;
}

/**
 * Build the DSN `throws` structure from a roll spec.
 * @param {object} spec {sides, count, fudge, values, appearance}
 */
function buildThrows(spec, appearance) {
  const { sides, fudge } = spec;
  const values = spec.values || [];
  const dice = [];
  // Dado propio de un sistema de Foundry (`dv`, `db`…) con sus caras ya registradas en el motor
  // (fvtt/dadosDeModulos.js). Sin registrar (quien mira no tiene la mesa abierta): el de sus caras.
  let tipoPropio = null;
  if (typeof spec.dieType === 'string' && spec.dieType !== `d${sides}`) {
    try { if (getDsnEngine().DiceFactory?.systems?.get('standard')?.dice?.has(spec.dieType)) tipoPropio = spec.dieType; } catch { /* sin motor */ }
  }

  // each die carries Foundry-DiceTerm-shaped fields the engine reads:
  // .options (roll options: colorset/flavor), consumed by getAppearanceForDice.
  const mk = (type, result) => ({ type, result, options: {} });
  for (const R of values) {
    if (fudge) {
      dice.push(mk('df', R)); // Fate/Fudge: -1/0/+1
    } else if (sides === 100) {
      // percentile = two dice: d100 (tens, faces 00..90) + d10 (units 0..9).
      // Each die's forcedResult must be the DIGIT (0-9), matching DSN's compound-die
      // contract (DiceNotation.addDie): swapDiceFace lands the face whose physics value
      // == result, and the standard d100 preset has no valueMap. Passing digit*10 (e.g. 70)
      // has no rotationCombinations key → "No dice rotation found" → face left uncorrected
      // → the tens die shows a wrong value (log said 72 but die showed 62).
      dice.push(mk('d100', Math.floor(R / 10) % 10));
      dice.push(mk('d10', R % 10));
    } else {
      dice.push(mk(tipoPropio || `d${sides}`, R));
    }
  }

  return [{ dice, dsnConfig: { appearance: { global: appearance }, diceLibrary: null } }];
}

/** Lib-compatible result shape so libDiceFaces(result) keeps working. */
function resultShape(spec) {
  return { sets: [{ rolls: (spec.values || []).map((v) => ({ value: v })) }] };
}

/**
 * Roll dice with predetermined results. Serialized (one throw at a time).
 * @param {{sides?:number,count?:number,fudge?:boolean,values:number[],appearance?:object,container?:any}} spec
 * @returns {Promise<{sets:{rolls:{value:number}[]}[]}>}
 */
// Force the engine back to a rollable state if a throw got stuck (physics never
// settled, appearance load hung, etc.). Without this, throwEngine.rolling stays
// true and EVERY later startUnifiedBatch no-ops → "after 1-2 rolls nothing rolls".
function forceRecover() {
  try { if (box?.throwEngine) box.throwEngine.rolling = false; } catch { /* ignore */ }
  try { Promise.resolve(box?.clearAll?.()).catch(() => {}); } catch { /* ignore */ }
}

// Resolve a spec's DSN appearance (skin mapping capped so a slow texture never
// blocks the batch — falls back to a plain colour die).
async function resolveAppearanceFor(spec) {
  if (spec.colorset) {
    const a = await Promise.race([
      appearanceFromRoliandoColorset(spec.colorset, spec.sides).catch(() => null),
      wait(4000).then(() => null),
    ]);
    if (a) return a;
  }
  return specToAppearance(spec);
}

/* ── Coalescing batch queue ────────────────────────────────────────────────
 * DSN's startUnifiedBatch throws ONE batch at a time, but a batch can hold many
 * groups with different appearances. So instead of serialising rapid rolls (slow)
 * or letting them no-op (broken), we COALESCE: rolls that pile up while a batch
 * is rolling fire together in the next batch → "tirar varios a la vez".
 */
let pending = []; // [{ spec, resolve }]
let batchTimer = null;
let flushing = false;

function scheduleFlush() {
  if (batchTimer || flushing) return; // if flushing, its loop picks up new items
  batchTimer = setTimeout(flushBatches, 90);
}

/*
 * LA CAJA SE QUEDÓ DEL TAMAÑO DE ANTES. El lienzo de los dados se dimensiona UNA vez, al nacer la caja (el calentamiento
 * del primer gesto), y el motor no escucha cambios de ventana. Si después la ventana cambia de tamaño o de zoom (densidad
 * de píxel), el lienzo conservaba el ancho viejo y la piel lo encogía a lo ancho de la ventana (`max-width: 100%` de
 * Tinta) sin tocar el alto: dados estirados o aplastados, en 2D y en 3D. Antes de cada tirada se comprueba; si no casa,
 * la caja se rehace (cámara, luces y paredes salen del tamaño, ver `ponerBandejaEnMesa`).
 */
function cajaDesfasada() {
  const el = containerEl;
  const esc = box?.diceScene;
  if (!el || !esc?.display) return false;
  const w = el.clientWidth; const h = el.clientHeight;
  if (!(w > 0 && h > 0)) return false;
  if (Math.abs(w - esc.display.currentWidth) > 1 || Math.abs(h - esc.display.currentHeight) > 1) return true;
  const pr = esc.dicefactory?.useHighDPI ? (window.devicePixelRatio || 1) : 1;
  return Math.abs((esc.renderer?.getPixelRatio?.() || pr) - pr) > 0.01;
}
function soltarCaja() {
  try { box?.clearAll?.(); } catch { /* ignore */ }
  readyPromise = null;
  box = null;
  containerEl = null;
}

/**
 * Mira la pose de cada dado en cada fotograma y llama a `alQuietos` cuando todos llevan un rato quietos a la vista
 * (`lib/dsn/quietud`). Devuelve la función que lo para. Si no hay dados que mirar, no hace nada: queda el final del motor.
 */
function vigilarQuietud(caja, alQuietos) {
  if (typeof requestAnimationFrame !== 'function') return () => {};
  const det = crearDetectorQuietud();
  let vivo = true;
  let id = 0;
  const muestra = (m) => {
    let radio = 1;
    try {
      const g = m.geometry;
      if (g && !g.boundingSphere) g.computeBoundingSphere?.();
      radio = (g?.boundingSphere?.radius || 1) * (m.scale?.x || 1);
    } catch { /* radio por defecto */ }
    const cuerpo = m.parent || m;   // el motor mueve el contenedor del dado, no el dado
    const p = cuerpo.position; const q = cuerpo.quaternion;
    return { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], radio };
  };
  const paso = (ahora) => {
    if (!vivo) return;
    try {
      const lista = caja?.throwEngine?.diceList || [];
      // Un dado que aún no ha entrado en la escena (tirada escalonada) no ha empezado: aún no se puede decir que todo esté quieto.
      const ms = lista.some((d) => d.parent && !d.parent.parent) ? [] : lista.map(muestra);
      const qa = typeof window !== 'undefined' ? window.__qaDados : null;   // medidor de QA: pose de los dados fotograma a fotograma
      if (qa) { qa.push([Math.round(ahora), ms.map((m) => [m.p[0], m.p[1], m.p[2], m.q[0], m.q[1], m.q[2], m.q[3], m.radio])]); }
      if (det.mirar(ms, ahora)) { vivo = false; try { performance.mark('dados-quietos'); } catch { /* sin marcas */ } alQuietos(); return; }
    } catch { /* si no se puede mirar, vale el final del motor */ }
    id = requestAnimationFrame(paso);
  };
  id = requestAnimationFrame(paso);
  return () => { vivo = false; try { cancelAnimationFrame(id); } catch { /* ignore */ } };
}

async function flushBatches() {
  batchTimer = null;
  if (flushing) return;
  flushing = true;
  try {
    // Nada rueda (no hay lote en marcha): rehacer la caja aquí no corta ninguna tirada.
    if (box && activeThrows === 0 && cajaDesfasada()) soltarCaja();
    if (!readyPromise) initDsnArena('#dice-arena');
    await readyPromise;
    if (!box) { const p = pending; pending = []; p.forEach((i) => i.resolve(resultShape(i.spec))); return; }
    flushAudioPending();

    while (pending.length) {
      const batch = pending; pending = []; // take everything queued so far
      // recover if a previous batch left the engine wedged (rolling stuck)
      if (box.throwEngine?.rolling) { forceRecover(); await wait(50); }
      // resolve every roll's appearance in parallel, then build the groups
      const appearances = await Promise.all(batch.map((i) => resolveAppearanceFor(i.spec)));
      const groups = [];
      batch.forEach((item, i) => { for (const g of buildThrows(item.spec, appearances[i])) groups.push(g); });

      activeThrows += batch.length;
      pumpAnim(); // arranca/prolonga el pulso+flujo mientras ruedan los dados con glow
      // Pantalla de RESULTADO (skin C4): con los dados ASENTADOS, pinta el valor en los
      // meshes-pantalla de los modelos que la traigan (idempotente; noop sin pantalla).
      // El resultado se entrega en cuanto los dados SE VEN quietos (`vigilarQuietud`), sin esperar
      // al final de la simulación del motor; lo que llegue antes de los dos manda y el otro no repite.
      let entregado = false;
      const entregar = () => {
        if (entregado) return;
        entregado = true;
        try {
          let planted = false;
          const renderNow = () => { try { box?.diceScene?.renderScene?.(); } catch { /* sin escena */ } };
          const lists = [box.throwEngine?.diceList || [], box.throwEngine?.deadDiceList || []];
          for (const list of lists) {
            for (const die of list) {
              const label = screenLabelFor(die?.notation?.type, die?.forcedResult ?? die?.result);
              if (label == null) continue;
              if (paintScreens(die, label) > 0) {
                // ANIMADO + RENDER PROPIO: el motor detiene su render al asentar — sin
                // onFrame ni el giro ni el LED se veían hasta la siguiente tirada.
                plantScreenUpAnimated(die, { onFrame: renderNow });
                planted = true;
              }
            }
          }
          if (planted) { renderNow(); pumpAnim(); }
        } catch { /* la pantalla nunca rompe la tirada */ }
        batch.forEach((item) => item.resolve(resultShape(item.spec)));
      };
      let paraVigilar = () => {};
      try {
        await new Promise((resolve) => {
          let settled = false;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          const t = setTimeout(done, 10000); // physics safety cap
          paraVigilar = vigilarQuietud(box, entregar);
          Promise.resolve(box.startUnifiedBatch(groups, null, () => { clearTimeout(t); done(); }))
            .catch((e) => { console.error('[dsnArena] startUnifiedBatch error', e?.stack || e); clearTimeout(t); done(); });
        });
      } finally {
        paraVigilar();
        try { performance.mark('dados-fin-motor'); } catch { /* sin marcas */ }
        activeThrows = Math.max(0, activeThrows - batch.length);
      }
      entregar();
      // loop: rolls that arrived during this batch fire as the next one
    }
  } catch (e) {
    console.error('[dsnArena] flushBatches', e?.stack || e);
    forceRecover();
    activeThrows = 0; // el batch reventó: no dejes el contador atascado (bloquearía TODO clear futuro → dados eternos)
    const p = pending; pending = []; p.forEach((i) => i.resolve(resultShape(i.spec)));
  } finally {
    flushing = false;
    if (pending.length) scheduleFlush();
    else drainClear(); // honra un clear diferido: ya no hay nada rodando → borra los dados que quedaron pegados
  }
}

export function rollDsn(spec) {
  clearWanted = false; // una tirada nueva anula un clear diferido: sus dados tienen su propia gracia
  return new Promise((resolve) => {
    pending.push({ spec, resolve });
    scheduleFlush();
  });
}

/**
 * Precalienta el motor SIN tirar: paga el arranque frío (init: motor + assets + worker de
 * física) y, con `spec`, precarga la apariencia de la skin activa (textura/modelo) para que
 * la PRIMERA tirada real no pague nada. Best-effort y time-boxed (un asset lento nunca cuelga
 * el calentamiento). Idempotente: `initDsnArena` reusa el `readyPromise` si ya está en marcha.
 */
export async function warmDsnArena(spec) {
  try {
    if (!readyPromise) initDsnArena('#dice-arena');
    await readyPromise;
    if (!box || !spec) return;
    // resolveAppearanceFor registra/cachea textura+sistema+modelo de la skin → la 1ª tirada
    // los encuentra listos. Cap de 6s para no dejar el warm colgado en un asset lento.
    await Promise.race([resolveAppearanceFor(spec).catch(() => null), wait(6000)]);
  } catch { /* warm es best-effort; la tirada real reintenta si algo falló */ }
}

/**
 * Map a roll spec to a DSN appearance in FOUNDRY-NAMED fields.
 * The physics path funnels appearance through DiceFactory.getAppearanceForDice,
 * which reads labelColor/diceColor/colorset/texture/material/system/font (Foundry
 * names) and converts them to the material names create() consumes — unlike the
 * static render path, which passes material names straight to create().
 */
function specToAppearance(spec) {
  if (spec.appearance) return spec.appearance; // pre-built Foundry-named appearance (from the dispatcher)
  const bg = spec.background || spec.accent || '#8a1f1f';
  const fg = spec.foreground || '#f7efe0';
  return {
    colorset: spec.colorset || 'custom',
    labelColor: fg,
    diceColor: bg,
    outlineColor: spec.outline || '#000000',
    edgeColor: spec.edge || bg,
    texture: spec.texture || 'none',
    material: spec.material || 'auto',
    system: spec.system || 'standard',
    font: spec.font || 'auto',
  };
}

export function clearDsnArena({ forzar = false } = {}) {
  if (forzar) {
    // Limpieza a la fuerza: no espera a nadie. Descarta la cola (sus promesas se resuelven para no dejar a nadie colgado),
    // suelta el contador de tiradas vivas y deja el motor en estado de tirar. La tirada en vuelo, si la hay, termina sola
    // por su tope de 10 s sin pintar nada más.
    const p = pending; pending = [];
    p.forEach((i) => { try { i.resolve(resultShape(i.spec)); } catch { /* ignore */ } });
    clearTimeout(batchTimer); batchTimer = null;
    activeThrows = 0; clearWanted = false;
    forceRecover();
    return;
  }
  // Pide limpiar. Si hay una tirada en vuelo/encolada, se DIFIERE (borrar ahora quitaría
  // los dados de esa otra tirada) y flushBatches vuelve a intentar al drenar. Antes esto
  // era `return` seco sin reintento → un clear que caía durante otra tirada se perdía y los
  // dados se quedaban pegados en pantalla para siempre.
  clearWanted = true;
  drainClear();
}

// Ejecuta un clear pendiente SOLO con el lienzo en reposo (sin tiradas vivas ni cola). Si
// no, lo deja pedido; flushBatches llama aquí de nuevo al terminar el último batch.
function drainClear() {
  if (!clearWanted) return;
  if (activeThrows > 0 || pending.length || flushing) return;
  clearWanted = false;
  // clearAll hace render limpio tras quitar los dados (sin frame fantasma/sombra).
  try { Promise.resolve(box?.clearAll?.()).catch(() => {}); } catch { /* ignore */ }
}

export function resetDsnArena() {
  try { box?.clearAll?.(); } catch { /* ignore */ }
  // drena la cola de tiradas y limpia el estado del batch
  const p = pending; pending = [];
  p.forEach((i) => { try { i.resolve(resultShape(i.spec)); } catch { /* ignore */ } });
  clearTimeout(batchTimer); batchTimer = null; flushing = false; activeThrows = 0; clearWanted = false;
  readyPromise = null;
  box = null;
  containerEl = null;
}

/*
 * ── LOS DADOS, EN LA MESA 3D (PLAN-VTT-3D, T8) ──────────────────────────────────────────────
 *
 * Los dados no cambian: son los de siempre, con las skins del estudio, su física y su sonido. Lo
 * único que cambia es DESDE DÓNDE se miran. El motor tira sobre un plano horizontal y la mesa 3D
 * enseña el mapa en OTRO plano horizontal: si a la cámara del motor se le da la orientación de la
 * cámara de la mesa —y su posición, multiplicada por el factor que convierte metros en casillas—,
 * las dos imágenes encajan y los dados ruedan sobre el mapa, con su sombra encima.
 *
 * Por qué se REINICIA la caja al entrar y al salir en vez de redimensionarla: el tamaño del
 * contenedor no es solo el lienzo, de él salen la cámara, las luces, la bandeja y las paredes
 * contra las que rebotan los dados. Reconstruir es una ruta que ya existe y que se usa en cada
 * desmontaje; redimensionar a medias dejaría los dados rebotando contra paredes invisibles que
 * ya no están donde parece. La reconstrucción es perezosa: la paga la siguiente tirada.
 */
let mesa = null;   // { factor } mientras la mesa 3D manda; null = bandeja de pantalla completa

/**
 * Posa la bandeja sobre la mesa 3D (o la devuelve a su sitio con `rect = null`).
 * `rect` solo indica si hay mesa (null = bandeja de pantalla completa); el hueco en pantalla lo aplica la app al contenedor.
 */
export function ponerBandejaEnMesa(rect, { factor = null } = {}) {
  // Al cambiar de sitio o de tamaño, la caja se reconstruye: ver la cabecera de este bloque.
  // Posar el contenedor sobre el hueco (left/top/width/height) es cosa de quien lo aloja: el motor
  // solo recibe el tamaño que ya tiene.
  resetDsnArena();
  mesa = rect ? { factor: Number(factor) > 0 ? Number(factor) : 1 } : null;
}

/*
 * EL TERRENO DE LA MESA (relieve, plantas y paredes) para que los dados choquen con él. Lo manda
 * la mesa ya en metros del motor (`vtt3d/dadosConTerreno`); `null` lo quita. Se recuerda y se
 * vuelve a poner cuando la caja se reconstruye (cada vez que se entra en la mesa o cambia su hueco).
 */
let terrenoDados = null;
async function aplicarTerreno() {
  const w = box?.physicsWorker;
  if (!w) return;
  try { await w.exec('setTerreno', mesa ? terrenoDados : null); } catch { /* sin motor, la próxima caja lo pondrá */ }
}
export function ponerTerrenoDados(t) {
  terrenoDados = t || null;
  aplicarTerreno();
}
export { aplicarTerreno as reaplicarTerrenoDados };

/** ¿Está la bandeja posada en la mesa 3D? */
export function bandejaEnMesa() { return Boolean(mesa); }

/**
 * La mesa dice desde dónde se mira. Se llama en cada repintado de la mesa: es una copia de
 * cuatro números, y sin ella los dados se quedarían con la cámara del fotograma anterior
 * mientras el mapa gira — o sea, flotando.
 */
export function mirarDesdeLaMesa(camara) {
  if (!mesa || !box || !camara) return;
  const cam = box.camera;
  if (!cam) return;
  const p = camara.posicion || {};
  cam.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
  const q = camara.quaternion;
  if (q) cam.quaternion.set(Number(q.x) || 0, Number(q.y) || 0, Number(q.z) || 0, Number(q.w) || 1);
  if (camara.fov) cam.fov = camara.fov;
  if (camara.aspect) cam.aspect = camara.aspect;
  /*
   * El «lejos» tiene que llegar hasta el mapa: la cámara del motor nace pensada para una bandeja
   * de sobremesa (unos centímetros) y desde la mesa 3D se mira desde mucho más lejos en sus
   * unidades. Sin esto los dados se recortan contra el plano de fondo y desaparecen a medio rodar.
   */
  const lejos = Math.max(1, Math.hypot(cam.position.x, cam.position.y, cam.position.z) * 4);
  if (cam.far < lejos) { cam.far = lejos; }
  cam.updateProjectionMatrix();
  // Repintar YA: el motor solo dibuja cuando hay dados moviéndose, y aquí lo que se ha movido es
  // la cámara. Sin esto, girar la mesa con los dados parados los deja clavados en el sitio viejo.
  try { box.diceScene?.renderScene?.(); } catch { /* si el motor no está listo, ya repintará */ }
}

export function isDsnArenaReady() {
  return !!box;
}
