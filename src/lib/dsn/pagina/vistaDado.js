/*
 * MODO VISTA de la página del motor de dados (`/dados?modo=vista`): un dado suelto con el motor real (malla, PBR,
 * relieve, HDR, brillo; idéntico a la tirada) que se gira arrastrando y cuyas caras se eligen tocándolas. Lo usan
 * el estudio de skins y el creador de dados, que lo meten en un iframe con eventos de puntero.
 *
 *   padre → vista   { tipo: 'vista', estado }       el dado que se edita; el último gana (ver `estado`)
 *   padre → vista   { tipo: 'resaltes', resaltes }  caras resaltadas y giro hasta una de ellas
 *   vista → padre   { tipo: 'listo' }               al cargar
 *   vista → padre   { tipo: 'vista-aplicada', ms }  el estado ya está pintado (ms de trabajo del motor)
 *   vista → padre   { tipo: 'cara', valor }         el usuario tocó una cara
 *
 * estado = { sides, material, bodyColors[], numColor, outline, edge, composite, hideNumbers, edgeTex, glow,
 *            textura: { source, bump, emissive } (URL de datos o ''), caras: { [valor]: URL de datos },
 *            carasGuardadas: { [valor]: url }, modelUrl, modelRot, modelScale }
 * resaltes = { lista: [{ normal | cara, color, relleno, opacidad }], giro: { normal | cara } | null, girar }
 */
import { getDsnEngine, DsnEngine } from '../DsnEngine.js';
import { DiceEditorPreview } from '../rendering/DiceEditorPreview.js';
import { TEXTURELIST } from '../engine/DiceColors.js';
import { ensurePerFacePreset } from '../dsnArena.js';
import { paintScreens } from '@/lib/dice3d/dieScreen.js';

const padre = window.parent !== window ? window.parent : null;
const enviar = (m) => { try { padre?.postMessage(m, location.origin); } catch { /* el padre ya no está */ } };

// id de acabado del estudio → material del motor
const DSN_MAT = {
  none: 'none', metal: 'metal', wood: 'wood', glass: 'glass', plastic: 'plastic',
  chrome: 'chrome', oro: 'metal', iris: 'iridescent', nacar: 'velvet',
};

let texSeq = 0;
let ultimaTextura = null;
let preview = null;
let resaltesActuales = { lista: [], giro: null, girar: false };

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < String(s).length; i++) h = ((h << 5) + h + String(s).charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Sistema + preset con `modelFile` = un GLB propio (dado esculpido): el motor lo carga y ese modelo ES el dado.
function sistemaDeModelo(engine, url, dieType, rot = null, scale = 1) {
  const rotKey = Array.isArray(rot) && rot.some((n) => n) ? rot.join(',') : '';
  const sc = Number(scale) > 0 ? Math.max(0.5, Math.min(2.5, Number(scale))) : 1;
  const sysId = 'rolmodel-' + hashStr(url + (rotKey ? `|${rotKey}` : '') + (sc !== 1 ? `|s${sc}` : ''));
  try {
    if (!engine.DiceFactory.systems.get(sysId)) {
      engine.addSystem({ id: sysId, name: sysId }, 'default');
      engine.addDicePreset({ type: dieType, system: sysId, modelFile: url, ...(rotKey ? { modelRotOffset: rot } : {}), ...(sc !== 1 ? { scaleModifier: sc } : {}) }, dieType === 'd100' ? 'd10' : dieType);
    }
  } catch (e) { console.warn('[vista de dado] modelo', e); return 'standard'; }
  return sysId;
}

// La apariencia que consume DiceFactory.create: texturas pintadas registradas en el motor y sistema por cara.
async function apariencia(engine, e) {
  const dieType = e.sides === 100 ? 'd100' : `d${e.sides}`;
  let texture = 'none';
  if (e.textura?.source) {
    const id = `studio-live-${++texSeq}`;
    try {
      await engine.addTexture(id, { name: id, composite: e.composite || 'source-over', source: e.textura.source, bump: e.textura.bump || '', emissive: e.textura.emissive || '' });
      if (ultimaTextura && ultimaTextura !== id) { try { delete TEXTURELIST[ultimaTextura]; } catch { /* noop */ } }
      ultimaTextura = id;
      texture = id;
    } catch { /* sin textura → dado liso */ }
  }
  const bg = (e.bodyColors || []).filter(Boolean);
  // Sistema: modelo propio > preset por cara EN VIVO (cada arte solo en su cara) > estándar. El preset por cara
  // lleva nombre único por refresco (el motor cachea las etiquetas dentro del preset).
  let system = 'standard';
  const guardadas = e.carasGuardadas && Object.keys(e.carasGuardadas).length ? e.carasGuardadas : null;
  const vivas = e.caras && Object.keys(e.caras).length ? e.caras : null;
  if (e.modelUrl) system = sistemaDeModelo(engine, e.modelUrl, dieType, e.modelRot, e.modelScale);
  else if (vivas || guardadas) {
    try { system = await ensurePerFacePreset(engine, e.sides, { __faceImgs: vivas, __facesSpec: guardadas, name: `live-${texSeq}` }); }
    catch (err) { console.warn('[vista de dado] por cara', err); }
  }
  // Sobre DEFAULT_APPEARANCE().global (aporta systemSettings:{}, colorset…): setDie pasa la apariencia cruda.
  return {
    ...DsnEngine.DEFAULT_APPEARANCE().global,
    foreground: e.numColor || '#ffffff',
    background: bg.length > 1 ? bg : (bg[0] || '#7a1a1a'),
    outline: e.outline || '',
    edge: e.edge || bg[0] || '',
    texture,
    material: DSN_MAT[e.material] || 'auto',
    system,
    font: 'auto',
    ...(e.hideNumbers ? { rolHideNumbers: true } : {}),
    ...(e.edgeTex ? { rolEdgeTexture: true } : {}),
    // el canal emisivo del tile solo luce si el material emite (mismo gate que la arena)
    ...(e.glow ? { emissiveLabels: true } : {}),
  };
}

function aplicarResaltes(girar) {
  const p = preview;
  if (!p) return;
  const r = resaltesActuales;
  const normal = (x) => x.normal || (x.cara != null ? p.normalDeCara?.(x.cara) : null);
  const lista = [];
  for (const x of r.lista) {
    const n = normal(x);
    if (n) lista.push({ normal: n, color: x.color, relleno: x.relleno, ...(x.opacidad != null ? { opacidad: x.opacidad } : {}) });
  }
  p.setResaltes(lista, girar && r.giro ? normal(r.giro) : null);
}

// Un estado a la vez; si llegan varios mientras se pinta, solo cuenta el último.
let pendiente = null;
let ocupado = false;
async function aplicar() {
  if (ocupado) return;
  ocupado = true;
  try {
    while (pendiente) {
      const e = pendiente; pendiente = null;
      const t0 = performance.now();
      try {
        const engine = getDsnEngine();
        await engine.init();
        const app = await apariencia(engine, e);
        const dieType = e.sides === 100 ? 'd100' : `d${e.sides}`;
        if (!preview) {
          const p = new DiceEditorPreview(document.querySelector('#vista'), engine.DiceFactory);
          p.aplicarEscalaModelo = true;   // el modelo propio viene a radio nativo: sin la escala llenaba la vista
          p.onFaceSelect = (faces) => {
            const f = faces && faces.size ? [...faces][faces.size - 1] : null;
            if (f != null) enviar({ tipo: 'cara', valor: f });
          };
          await p.init();
          await p.setDie(dieType, app);
          preview = p;
          window.addEventListener('resize', () => { try { preview?.resize(); } catch { /* montaje a medias */ } });
        } else {
          await preview.refresh(dieType, app);
        }
        try { paintScreens(preview.dieMesh, String(e.sides)); } catch { /* sin pantalla */ }
        aplicarResaltes(false);
        enviar({ tipo: 'vista-aplicada', ms: Math.round(performance.now() - t0) });
      } catch (err) { console.error('[vista de dado]', err); }
    }
  } finally { ocupado = false; }
}

window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin || ev.source !== padre) return;
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.tipo === 'vista') { pendiente = m.estado; aplicar(); }
  else if (m.tipo === 'resaltes') { resaltesActuales = m.resaltes || { lista: [], giro: null, girar: false }; aplicarResaltes(Boolean(resaltesActuales.girar)); }
});

enviar({ tipo: 'listo' });
