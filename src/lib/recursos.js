// Prefijo único de los recursos pesados de public/ (fx-packs, library, modules, cards, cosmetics,
// sonidos). Todo lo que pide una de esas rutas pasa por aquí: en producción va a `/r/<ruta>`, que
// el Worker sirve desde R2 con caché larga y, mientras el objeto no esté subido, cae al archivo
// estático de siempre. Para moverlo a otro dominio basta `VITE_RECURSOS_BASE` en el build.

export const CARPETAS_PESADAS = ['fx-packs', 'library', 'modules', 'cards', 'cosmetics', 'sonidos'];

const REGEX = new RegExp(`^/(${CARPETAS_PESADAS.join('|')})/`);

// En desarrollo y en tests no hay Worker delante: las rutas se quedan como están.
const BASE = (() => {
  const env = import.meta?.env;
  if (!env) return '';
  if (env.VITE_RECURSOS_BASE != null) return String(env.VITE_RECURSOS_BASE).replace(/\/$/, '');
  return env.DEV ? '' : '/r';
})();

/** `/cards/x.webp` pasa a `/r/cards/x.webp`. Lo que no es de esas carpetas se devuelve intacto. */
export function recurso(ruta) {
  if (typeof ruta !== 'string' || !BASE || !REGEX.test(ruta)) return ruta;
  return `${BASE}${ruta}`;
}

export const baseRecursos = () => BASE;

const RE_URL_CSS = new RegExp(`url\\((['"]?)/(${CARPETAS_PESADAS.join('|')})/`, 'g');

/** Pasa por el prefijo los `url(/cosmetics/…)` de un valor de CSS escrito desde JS. */
export function recursoCss(valor) {
  if (typeof valor !== 'string' || !BASE) return valor;
  return valor.replace(RE_URL_CSS, (_m, q, dir) => `url(${q}${BASE}/${dir}/`);
}
