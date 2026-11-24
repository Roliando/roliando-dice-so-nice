/*
 * MODO ARENA de la página del motor de dados (`/dados.html`, ver motorDados.js): las tiradas. Corre dentro de un
 * iframe del mismo origen y no importa nada de la aplicación: la ventana que la contiene le manda órdenes con
 * `postMessage` y ella responde igual.
 *
 *   padre → motor   { tipo: 'orden', id, orden, args: [...] }
 *   motor → padre   { tipo: 'respuesta', id, ok: true, valor } | { tipo: 'respuesta', id, ok: false, error }
 *   motor → padre   { tipo: 'listo' }                           al cargar, antes de aceptar órdenes
 *   motor → padre   { tipo: 'sonido-precargar', src }           el padre descarga y decodifica el sonido
 *   motor → padre   { tipo: 'sonido', src, loopStart, loopEnd, volume }   el padre lo reproduce
 *   padre → motor   { tipo: 'camara', camara }                  sin respuesta (uno por fotograma de la mesa 3D)
 *
 * Órdenes: init(opts) · tirar(spec) · limpiar({forzar}) · reiniciar() · calentar(spec) ·
 *          bandeja(rect|null, {factor}) · terreno(t) · estado() ·
 *          registrar(lote)   alta de los dados, texturas y colorsets de los módulos (ver registroModulos.js);
 *                            la tirada y el calentamiento esperan a que acabe el último lote pedido
 * Todo lo que cruza es clonable (datos planos); los lienzos de textura llegan como URL de datos.
 */
import { initDsnArena, rollDsn, clearDsnArena, resetDsnArena, warmDsnArena, ponerBandejaEnMesa, ponerTerrenoDados, mirarDesdeLaMesa, isDsnArenaReady, bandejaEnMesa } from '../dsnArena.js';
import { usarSonidoExterno } from '../foundryShim.js';
import { registrarLote } from '../registroModulos.js';

const padre = window.parent !== window ? window.parent : null;
const enviar = (m) => { try { padre?.postMessage(m, location.origin); } catch { /* el padre ya no está */ } };

// El sonido lo reproduce la ventana que contiene la página: ella sí tiene el gesto del usuario.
if (padre) {
  usarSonidoExterno({
    precargar: (src) => enviar({ tipo: 'sonido-precargar', src }),
    reproducir: (src, { loopStart, loopEnd, volume }) => enviar({ tipo: 'sonido', src, loopStart, loopEnd, volume }),
  });
}

// Los lotes de módulos se dan de alta de uno en uno; tirar y calentar esperan al último.
let registro = Promise.resolve();

const ORDENES = {
  registrar: (lote) => { registro = registro.then(() => registrarLote(lote)).catch((e) => console.warn('[dados de módulos]', e)); return registro.then(() => null); },
  init: async (opts = {}) => { await initDsnArena('#dice-arena', opts); return null; },
  tirar: async (spec) => { await registro; return rollDsn({ ...spec, container: '#dice-arena' }); },
  limpiar: (o = {}) => { clearDsnArena(o); return null; },
  reiniciar: () => { resetDsnArena(); return null; },
  calentar: async (spec) => { await registro; await warmDsnArena(spec ? { ...spec, container: '#dice-arena' } : spec); return null; },
  bandeja: (rect, opts = {}) => { ponerBandejaEnMesa(rect, opts); return null; },
  terreno: (t) => { ponerTerrenoDados(t); return null; },
  estado: () => ({ lista: isDsnArenaReady(), mesa: bandejaEnMesa() }),
};

// Que la respuesta cruce siempre: un resultado que no se pueda clonar se manda como nulo.
function clonable(v) {
  try { structuredClone(v); return v; } catch { return null; }
}

window.addEventListener('message', async (ev) => {
  if (ev.origin !== location.origin || ev.source !== padre) return;
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.tipo === 'camara') { try { mirarDesdeLaMesa(m.camara); } catch { /* el repintado de la mesa no se rompe por esto */ } return; }
  if (m.tipo !== 'orden') return;
  const { id, orden, args = [] } = m;
  const fn = ORDENES[orden];
  if (!fn) { enviar({ tipo: 'respuesta', id, ok: false, error: `orden desconocida: ${orden}` }); return; }
  try {
    const valor = await fn(...args);
    enviar({ tipo: 'respuesta', id, ok: true, valor: clonable(valor) });
  } catch (e) {
    enviar({ tipo: 'respuesta', id, ok: false, error: String(e?.message || e) });
  }
});

enviar({ tipo: 'listo' });
