# Dice So Nice — versión modificada

Este directorio contiene una versión **modificada** del motor de
[Dice So Nice](https://gitlab.com/riccisi/foundryvtt-dice-so-nice) 6.2.8,
un módulo para Foundry VTT de **Simone Ricciardi y JDW**, publicado bajo la
**GNU Affero General Public License v3.0** (texto completo en `LICENSE`).

Copyright de la obra original: sus autores y colaboradores. Créditos del original:

- Basado en el «Online 3D dice roller» de Anton Natarov (dominio público) y el fork de MajorVictory.
- Geometría del d10 de Greewi.
- Temas: Spencer Thayer (`Thylean Bronze`), LyncsCwtsh (sistema `Spectrum`), MajorVictory (el resto).
- Efectos de sonido adicionales de https://www.zapsplat.com
- Construido sobre Three.js, cannon-es y Proton.

Los temas y caras de `themes/niceMoreDice.js` y `public/modules/nice-more-dice/` son de
**Nice More Dice**, de **LyncsCwtsh**
(https://github.com/LyncsCwtsh/fvtt-module-nice-more-dice), bajo
**CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/).

## Cambios respecto al original

- Desacoplado de Foundry VTT: `foundryShim.js` sustituye a los globales de Foundry
  (`game`, `Hooks`, `ui`, `CONFIG`, `foundry.utils`) y `DsnEngine.js` sustituye a `Dice3D.js`.
- `dsnArena.js`: arena de tiradas de Roliando (cola de tiradas, resultado predeterminado,
  mapeo de las skins de dados, ajustes de calidad en móvil, brillo y temas animados).
- `engine/DiceFactory.js`: el canvas emisivo también dibuja el patrón de las texturas con brillo.
- Retirado el preset y el sistema «Foundry VTT» (con el logo de Foundry) y su fuente.
- `themeImport.js`: importación de temas exportados desde Dice So Nice.
- Rutas de assets absolutas, worker de física con la sintaxis `?worker` de Vite, `stats-gl` sin uso.
