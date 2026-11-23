/**
 * DsnEngine.js — de-Foundry orchestrator for the vendored Dice So Nice engine.
 *
 * Replaces DSN's Foundry-coupled `Dice3D.js`. It provides exactly the surface
 * the engine + themes need:
 *   - the `game.dice3d` singleton shape: `dice3dRenderers`, `uniforms`, `DiceFactory`
 *   - the theme API themes call: addColorset / addTexture / addSystem / addDicePreset
 *   - the static config methods DiceScene / DiceBox / DiceFactory consume
 *   - `init()`  — build factory, load colorsets/textures/fonts/presets
 *   - `renderStatic()` — render a real DSN die (mesh + PBR material + bump relief
 *                        + bloom) into a container, no physics. Editor-preview path.
 *
 * The physics roll path (DiceBox) is added on top of this in a later phase.
 */

import './foundryShim.js';
import { ticker, resolveDsnUrl } from './foundryShim.js';
// Nice More Dice — registers its textures/presets/systems on the diceSoNiceReady
// hook. Imported for side effect (must come AFTER foundryShim so `Hooks` exists);
// the hook is fired at the end of init().
import './themes/niceMoreDice.js';

import { TextureLoader, DefaultLoadingManager } from 'three';
import { Quaternion, Raycaster, Triangle, Vector2, Vector3 } from 'three';

// Rewrite DSN's relative `modules/dice-so-nice/...` asset URLs to absolute for
// every THREE loader (TextureLoader, RGBELoader, CubeTextureLoader, GLTFLoader).
DefaultLoadingManager.setURLModifier(resolveDsnUrl);

import { DiceFactory } from './engine/DiceFactory.js';
import { DiceScene } from './engine/DiceScene.js';
import { DiceColors, TEXTURELIST, COLORSETS } from './engine/DiceColors.js';
import { DiceLibrary } from './engine/DiceLibrary.js';
import { CustomDiceTerms } from './engine/CustomDiceTerms.js';
import { DICE_SHAPE } from './engine/DiceModels.js';
import { LEGACY_TO_METERS } from './engine/SceneConstants.js';
import { ThinFilmFresnelMap } from './libs/ThinFilmFresnelMap.js';
import { Utils } from './Utils.js';
import { parseDsnTheme } from './themeImport.js';

const mergeObject = foundry.utils.mergeObject;

export class DsnEngine {
  /* ----------------------------- static config ----------------------------- */

  static get DEFAULT_OPTIONS() {
    // performanceMode 3 = max quality (see foundryShim SETTINGS_DEFAULTS)
    return {
      visibility: 'all',
      showExtraDice: false,
      hideAfterRoll: true,
      timeBeforeHide: 2000,
      hideFX: 'fadeOut',
      autoscale: true,
      scale: 75,
      speed: 1,
      imageQuality: 'high',
      shadowQuality: 'high',
      bumpMapping: true,
      sounds: true,
      soundsSurface: 'felt',
      soundsVolume: 0.5,
      canvasZIndex: 'over',
      throwingForce: 'medium',
      useHighDPI: true,
      antialiasing: 'smaa',
      glow: true,
      persistentDiceOutlines: true,
      advancedGlass: true,
      ambiance: 'foyer_1k',
      showOthersSFX: true,
      immersiveDarkness: true,
      muteSoundSecretRolls: false,
      enableFlavorColorset: true,
      skipAnimationOnInactiveTab: false,
      rollingArea: false,
      persistentDiceSpawnLocation: 'center',
    };
  }

  static DEFAULT_APPEARANCE() {
    const color = '#8a1f1f';
    // NOTE: DiceFactory.generateMaterialData reads material-layer names
    // (foreground/background/outline/edge), NOT the Foundry-settings names
    // (labelColor/diceColor/outlineColor/edgeColor). The Foundry UI transforms
    // between them; we supply the material names directly.
    return {
      global: {
        foreground: '#f7efe0', // number/label color
        background: color, // die body color
        outline: '#000000',
        edge: color,
        texture: 'none',
        material: 'auto',
        font: 'auto',
        colorset: 'custom',
        system: 'standard',
        systemSettings: {},
      },
    };
  }

  static CONFIG() {
    const config = mergeObject(DsnEngine.DEFAULT_OPTIONS, {}, { applyOperators: true, inplace: false });
    delete config.appearance;
    return config;
  }

  static APPEARANCE() {
    return mergeObject(DsnEngine.DEFAULT_APPEARANCE(), {}, { applyOperators: true, inplace: false });
  }

  static ALL_CONFIG() {
    const ret = mergeObject(DsnEngine.CONFIG(), { appearance: DsnEngine.APPEARANCE() }, { applyOperators: true });
    ret.specialEffects = [];
    return ret;
  }

  /* ----------------------------- construction ----------------------------- */

  constructor() {
    this.dice3dRenderers = { board: null, showcase: null, editor: null };
    this.exports = { Utils, DiceColors, TEXTURELIST, COLORSETS };
    this._iridescenceLookUp = null;
    this._iridescenceNoise = null;
    const self = this;
    this.uniforms = {
      globalBloom: { value: 1 },
      bloomStrength: { value: 1.1 },
      bloomRadius: { value: 0.2 },
      bloomThreshold: { value: 0 },
      iridescenceLookUp: {
        get value() { return (self._iridescenceLookUp ??= new ThinFilmFresnelMap()); },
        set value(v) { self._iridescenceLookUp = v; },
      },
      iridescenceNoise: {
        get value() { return (self._iridescenceNoise ??= new TextureLoader().load('modules/dice-so-nice/textures/noise-thin-film.webp')); },
        set value(v) { self._iridescenceNoise = v; },
      },
      boost: { value: 1.5 },
      time: { value: 0 },
    };
    this.defaultShowExtraDice = false;
    this._ready = null;
  }

  /**
   * Build the DiceFactory and load all default colorsets, textures, fonts and
   * presets. Idempotent — returns the same promise on repeat calls.
   */
  init() {
    if (this._ready) return this._ready;

    // game.dice3d must point at us BEFORE anything reads game.dice3d.uniforms / .DiceFactory
    game.dice3d = this;

    // DiceFactory.createMaterial reads game.dice3d.box.anisotropy for texture
    // filtering. renderStatic has no physics DiceBox, so provide a stub; the
    // value is refined from the real renderer in renderStatic().
    this.box = { anisotropy: 4 };

    this.DiceFactory = new DiceFactory();
    // apply quality/config to the factory (ambiance, realistic lighting, shadows,
    // glow, AA) — DiceBox does this in Foundry; we do it directly.
    this.DiceFactory.setQualitySettings(DsnEngine.DEFAULT_OPTIONS);
    this.DiceFactory.setScale(60);
    try { CustomDiceTerms.registerPresetsInFactory(this.DiceFactory); } catch (e) { console.warn('[dsn] CustomDiceTerms', e); }
    this.diceLibrary = new DiceLibrary();

    this._ready = new Promise((resolve) => {
      DiceColors.loadTextures(TEXTURELIST, async () => {
        try {
          DiceColors.initColorSets();
          try { await this.DiceFactory._loadFonts(); } catch (e) { console.warn('[dsn] fonts', e); }
          try { await this.diceLibrary.load(); } catch (e) { /* Foundry lib persistence — optional */ }
          try { await this.DiceFactory.preloadPresets(); } catch (e) { console.warn('[dsn] preloadPresets', e); }
          // fire diceSoNiceReady so modules (Nice More Dice, DSN theme packs)
          // register their textures/colorsets/presets/systems via the addon API.
          try { globalThis.Hooks?.callAll?.('diceSoNiceReady', this); } catch (e) { console.warn('[dsn] diceSoNiceReady', e); }
          try { await this.DiceFactory._loadFonts(); } catch (e) { /* fonts from newly-registered presets */ }
        } catch (e) {
          console.error('[dsn] init', e);
        }
        resolve(this);
      });
    });
    return this._ready;
  }

  /* ------------------------------- theme API ------------------------------- */
  // Themes (DSN exports, Nice More Dice) call these on game.dice3d.

  addSystem(system, mode = 'default') {
    if (typeof mode === 'boolean') mode = mode ? 'preferred' : 'default';
    this.DiceFactory.addSystem(system, mode);
  }

  addDicePreset(dice, shape = null) {
    this.DiceFactory.addDicePreset(dice, shape);
  }

  addTexture(textureID, textureData) {
    if (!textureData.bump) textureData.bump = '';
    return new Promise((resolve) => {
      const entry = { [textureID]: textureData };
      TEXTURELIST[textureID] = textureData;
      DiceColors.loadTextures(entry, () => resolve());
    });
  }

  async addColorset(colorset, mode = 'default') {
    const defaults = {
      foreground: 'custom', background: 'custom', outline: '', edge: '',
      texture: 'custom', material: 'custom', font: 'custom', visibility: 'visible',
      labelComposite: 'source-over', backgroundComposite: 'source-over',
    };
    colorset = mergeObject(defaults, colorset, { applyOperators: true });
    COLORSETS[colorset.name] = colorset;
    DiceColors.initColorSets(colorset);
    // Foundry FontConfig font-loading branch is skipped; DiceFactory._loadFonts
    // handles webfonts via the FontFace API instead.
    if (mode === 'preferred') this.DiceFactory.preferredColorset = colorset.name;
  }

  /**
   * Import a Dice So Nice theme export (any format) and register it as a
   * colorset. Returns the registered colorset name (to select it) or null.
   */
  async importTheme(input) {
    const cs = parseDsnTheme(input);
    if (!cs) return null;
    await this.addColorset(cs, 'default');
    return cs.name;
  }

  /* ------------------------------ catalog listing -------------------------- */
  // For UI: enumerate everything currently registered (DSN built-ins + NMD +
  // any imported theme). Call after init().

  listTextures() {
    return Object.entries(TEXTURELIST).map(([id, t]) => ({ id, name: t.name || id, bump: !!(t.bump && t.bump !== '') }));
  }

  listColorsets() {
    return Object.entries(COLORSETS).map(([id, c]) => ({ id, name: c.name || id }));
  }

  listSystems() {
    const out = [];
    try { for (const [id, s] of this.DiceFactory.systems) out.push({ id, name: s.name || id }); } catch {}
    return out;
  }

  listMaterials() {
    return ['auto', 'none', 'plastic', 'metal', 'chrome', 'wood', 'glass', 'iridescent', 'velvet'];
  }

  /* ------------------------------ static render ---------------------------- */

  /**
   * Render a single real DSN die into `container` (no physics). Proves the full
   * material pipeline: baked mesh, PBR material, bump relief, HDR env, bloom.
   * @returns {Promise<{dispose:Function, refresh:Function, scene:DiceScene, mesh:Object}>}
   */
  async renderStatic(container, dieType = 'd20', appearanceOverride = {}) {
    await this.init();

    const width = container.clientWidth || 300;
    const height = container.clientHeight || 300;

    const config = mergeObject(DsnEngine.ALL_CONFIG(), {
      rendererCacheKey: 'editor',
      dimensions: { width, height },
      autoscale: false,
      scale: 60,
    });

    const scene = new DiceScene(container, this.DiceFactory, config);
    await scene.initialize();
    scene.setupBloomPipeline();
    // refine anisotropy from the real renderer + lift exposure a touch (the
    // board scene is tuned to composite over Foundry's lit canvas; standalone
    // on a dark page it reads a bit dim).
    try { this.box.anisotropy = scene.renderer.capabilities.getMaxAnisotropy?.() || 4; } catch {}

    scene.camera.position.set(150 * LEGACY_TO_METERS, 540 * LEGACY_TO_METERS, 200 * LEGACY_TO_METERS);
    scene.camera.lookAt(0, 0, 0);
    scene.camera.updateProjectionMatrix();

    const appearance = mergeObject(DsnEngine.DEFAULT_APPEARANCE().global, appearanceOverride, { applyOperators: true });

    const handle = {
      scene,
      mesh: null,
      _tick: () => scene.renderScene(),
      _dragging: false,
      _prev: { x: 0, y: 0 },
      async setDie(type, app) {
        if (this.mesh) { scene.scene.remove(this.mesh); this.mesh = null; }
        const cache = scene.renderer.scopedTextureCache;
        if (!cache) return;
        // always merge over defaults so partial overrides keep system/systemSettings/etc.
        const full = mergeObject(DsnEngine.DEFAULT_APPEARANCE().global, app || {}, { applyOperators: true, inplace: false });
        const mesh = await game.dice3d.DiceFactory.create(cache, type, full, game.dice3d.diceLibrary);
        if (!mesh) return;
        this.mesh = mesh;
        this.mesh.scale.multiplyScalar(1.15);
        scene.scene.add(this.mesh);
      },
      async refresh(type, app) {
        const saved = this.mesh ? this.mesh.quaternion.clone() : null;
        await this.setDie(type, app);
        if (saved && this.mesh) this.mesh.quaternion.copy(saved);
      },
      dispose() {
        ticker.remove(this._tick);
        window.removeEventListener('mouseup', this._onUp);
        try { scene.clearScene(); } catch {}
        try {
          const el = scene.renderer?.domElement;
          if (el?.parentNode) el.parentNode.removeChild(el);
        } catch {}
      },
    };

    // right-drag rotates the die so HDR lighting sweeps across it
    const el = scene.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('mousedown', (e) => { if (e.button === 2) { handle._dragging = true; handle._prev = { x: e.clientX, y: e.clientY }; } });
    el.addEventListener('mousemove', (e) => {
      if (!handle._dragging || !handle.mesh) return;
      const dx = e.clientX - handle._prev.x, dy = e.clientY - handle._prev.y;
      handle._prev = { x: e.clientX, y: e.clientY };
      const right = new Vector3().setFromMatrixColumn(scene.camera.matrixWorld, 0);
      const up = new Vector3().setFromMatrixColumn(scene.camera.matrixWorld, 1);
      const qx = new Quaternion().setFromAxisAngle(up, dx * 0.01);
      const qy = new Quaternion().setFromAxisAngle(right, dy * 0.01);
      handle.mesh.quaternion.premultiply(qx).premultiply(qy);
    });
    handle._onUp = (e) => { if (e.button === 2) handle._dragging = false; };
    window.addEventListener('mouseup', handle._onUp);

    await handle.setDie(dieType, appearance);
    ticker.add(handle._tick);
    return handle;
  }
}

/** Singleton accessor. */
let _engine = null;
export function getDsnEngine() {
  if (!_engine) _engine = new DsnEngine();
  return _engine;
}
