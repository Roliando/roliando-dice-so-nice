/*
 * PÁGINA DEL MOTOR DE DADOS. `dados.html` se carga dentro de un iframe del mismo origen y solo habla por
 * mensajes con la ventana que la contiene (`postMessage`); no importa nada de la aplicación. Tiene dos modos:
 *
 *   /dados                  la ARENA: las tiradas, sobre `#dice-arena` (arenaDados.js; protocolo ahí)
 *   /dados?modo=vista       la VISTA de un dado: el dado del estudio de skins y del creador, que se gira con
 *                           el ratón o el dedo y se actualiza en vivo (vistaDado.js; protocolo ahí)
 */
const modo = new URLSearchParams(location.search).get('modo');
if (modo === 'vista') {
  document.documentElement.classList.add('modo-vista');
  import('./vistaDado.js');
} else {
  import('./arenaDados.js');
}
