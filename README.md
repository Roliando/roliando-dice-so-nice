# Roliando — modified Dice So Nice engine

This repository holds the **complete source code of the modified version of
[Dice So Nice](https://gitlab.com/riccisi/foundryvtt-dice-so-nice)** that powers the 3D dice in
[Roliando](https://roliando.com). It is published to comply with the
**GNU Affero General Public License v3.0**, under which Dice So Nice is released. This modified
version is under the same license (see `LICENSE`).

- Original work: **Dice So Nice** 6.2.8, by **Simone Ricciardi and JDW** and contributors (AGPL-3.0).
- Dice themes and faces in `src/lib/dsn/themes/niceMoreDice.js` and `public/modules/nice-more-dice/`:
  **Nice More Dice**, by **LyncsCwtsh**
  ([repository](https://github.com/LyncsCwtsh/fvtt-module-nice-more-dice)), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- The full list of credits for the original and the **changes we made** is in `NOTICE.md`
  (in Spanish).

## Layout

| Path | Contents |
|---|---|
| `src/lib/dsn/` | The engine: vendored Dice So Nice code plus our changes (`foundryShim.js`, `DsnEngine.js`, `dsnArena.js`, `themeImport.js`). |
| `src/lib/dice3d/dieScreen.js` | Result display painted on custom 3D die models (used by `dsnArena.js`). |
| `src/lib/recursos.js` | Resolves the URL of the static assets under `public/`. |
| `public/modules/dice-so-nice/` | Engine assets: textures, sounds, HDR environment. |
| `public/modules/nice-more-dice/` | Nice More Dice textures and die faces. |

The code is used as an ES module inside a Vite app (`@/` points to `src/`, the physics worker is
imported with Vite's `?worker` suffix). Runtime dependencies: `three` 0.184, `cannon-es`,
`webworker-promise`.

This repository is kept in sync with the version deployed on Roliando.

---

# Roliando — motor de Dice So Nice modificado

Aquí está **el código fuente completo de la versión modificada de Dice So Nice** con la que funcionan
los dados 3D de Roliando, publicado para cumplir la **GNU AGPL v3.0**. Créditos y lista de cambios en
`NOTICE.md`.
