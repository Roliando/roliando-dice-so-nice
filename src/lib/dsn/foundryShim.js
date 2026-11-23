/**
 * foundryShim.js — de-Foundry bootstrap for the vendored Dice So Nice engine.
 *
 * DSN's engine references `game`, `Hooks`, `ui`, `CONFIG`, `canvas` and
 * `foundry.utils.*` as FREE GLOBALS (Foundry injects them at runtime). None of
 * those are imported by the engine files, so populating `globalThis` here lets
 * the vendored code run unmodified outside Foundry.
 *
 * Import this module for its side effects BEFORE any engine module:
 *     import './foundryShim.js';
 *     import { Dice3D } from './Dice3D.js';
 *
 * Only the surface the engine actually touches is implemented. `foundry.utils`
 * comes from Roliando's own clean implementation (src/lib/fvtt/utils.js).
 */

/* ------------------------------------------------------------------ *
 *  foundry.utils
 * ------------------------------------------------------------------ */

// Implementación propia de la fachada Foundry (src/lib/fvtt/utils.js), escrita a partir de la
// documentación pública de la API. Antes aquí había un «port» de mergeObject del núcleo de
// Foundry, que es código propietario (ver .planning/investigacion/2026-10-foundry-modulos-compat.md §0).
import { mergeObject, deepClone, isEmpty, getType, getProperty, setProperty, hasProperty, randomID, debounce } from '../fvtt/utils.js';

/* ------------------------------------------------------------------ *
 *  Web Audio (dice sounds)
 * ------------------------------------------------------------------ */

let _audioCtx = null;
function getAudioContext() {
  if (_audioCtx) return _audioCtx;
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AC) _audioCtx = new AC();
  } catch { _audioCtx = null; }
  return _audioCtx;
}

// Minimal foundry.audio.Sound backed by Web Audio: load an mp3 → AudioBuffer,
// play a sprite region [loopStart, loopEnd] (seconds) at a volume. Buffers are
// cached by URL so repeated collisions don't re-fetch.
class WebAudioSound {
  constructor(src, opts = {}) {
    this.src = src;
    this.context = opts.context || getAudioContext();
    this._buffer = null;
  }
  async load() {
    if (!this.context) return this;
    if (WebAudioSound._cache[this.src]) { this._buffer = await WebAudioSound._cache[this.src]; return this; }
    const p = fetch(resolveDsnUrl(this.src))
      .then((r) => r.arrayBuffer())
      .then((ab) => this.context.decodeAudioData(ab));
    WebAudioSound._cache[this.src] = p;
    try { this._buffer = await p; } catch { delete WebAudioSound._cache[this.src]; }
    return this;
  }
  play({ loopStart = 0, loopEnd = 0, volume = 1 } = {}) {
    const ctx = this.context;
    if (!ctx || !this._buffer) return this;
    try {
      if (ctx.state === 'suspended') ctx.resume();
      const node = ctx.createBufferSource();
      node.buffer = this._buffer;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, volume));
      node.connect(gain).connect(ctx.destination);
      const duration = loopEnd > loopStart ? loopEnd - loopStart : undefined;
      node.start(0, loopStart, duration);
    } catch { /* audio best-effort */ }
    return this;
  }
  stop() {}
  on() {} off() {}
}
WebAudioSound._cache = {};

/**
 * Flush the queued audio-preload callbacks (Foundry defers these until a user
 * gesture). Call from a click/roll handler so the AudioContext is allowed to
 * start. Idempotent — pending runs once, resume is cheap.
 */
export function flushAudioPending() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
  const q = gameShim?.audio?.pending;
  if (Array.isArray(q) && q.length) {
    const items = q.splice(0, q.length);
    for (const fn of items) { try { fn(); } catch (e) { console.warn('[dsn audio]', e); } }
  }
}

const foundryShim = {
  utils: {
    mergeObject,
    deepClone,
    duplicate: (x) => deepClone(x),
    isEmpty,
    getType,
    getProperty,
    setProperty,
    hasProperty,
    randomID,
    debounce,
    fromUuidSync: () => null,
    fromUuid: async () => null,
    Color: {
      from: (v) => v,
      fromString: (v) => v,
    },
  },
  applications: {
    api: { ApplicationV2: { _maxZ: 100 } },
    settings: {
      menus: {
        // Foundry font registry. We defer real font loading to a later phase
        // (register CONFIG.fontDefinitions + FontFace from modules/dice-so-nice/fonts).
        // Claiming every font is "available" makes DiceFactory skip its inline
        // loadFont() calls; dice render with a fallback font meanwhile.
        FontConfig: {
          getAvailableFonts: () => ({ includes: () => true }),
          loadFont: async () => {},
        },
      },
    },
  },
  // Foundry audio system — real Web Audio. Sound loads an mp3 into an
  // AudioBuffer and plays sprite regions [loopStart, loopEnd] on dice collisions.
  audio: {
    AudioHelper: {
      preloadSound: (src) => new WebAudioSound(src).load().catch(() => null),
      play: async () => null,
    },
    Sound: WebAudioSound,
  },
  // Foundry dice term base classes. Only used for identity/instanceof checks in
  // the auto-registration loop (which the CONFIG.Dice.terms Proxy makes a no-op).
  dice: {
    terms: {
      Die: class Die { static DENOMINATION = 'd'; },
      Coin: class Coin { static DENOMINATION = 'c'; },
      FateDie: class FateDie { static DENOMINATION = 'f'; },
    },
  },
};

/* ------------------------------------------------------------------ *
 *  requestAnimationFrame ticker (replaces Foundry's PIXI canvas.app.ticker)
 * ------------------------------------------------------------------ */

// PIXI-ticker-compatible linked list. DSN adds with canvas.app.ticker.add(fn,ctx)
// AND removes by traversing ticker._head.next + listener.destroy() (Utils.remove
// Ticker), so we emulate PIXI's TickerListener chain, not a plain array.
class TickerListener {
  constructor(fn, context) { this.fn = fn; this.context = context; this.next = null; this.previous = null; }
  emit() {
    const next = this.next; // capture first: fn may destroy/unlink self
    if (this.fn) { if (this.context) this.fn.call(this.context); else this.fn(); }
    return next;
  }
  connect(prev) {
    this.previous = prev;
    if (prev.next) prev.next.previous = this;
    this.next = prev.next;
    prev.next = this;
  }
  destroy() {
    const next = this.next;
    if (this.previous) this.previous.next = next;
    if (next) next.previous = this.previous;
    this.next = null; this.previous = null; this.fn = null; this.context = null;
    return next;
  }
}

class RafTicker {
  constructor() {
    this._head = new TickerListener(null, null); // sentinel
    this._running = false;
    this._loop = this._loop.bind(this);
  }
  add(fn, context) {
    let tail = this._head;
    while (tail.next) tail = tail.next;
    new TickerListener(fn, context).connect(tail);
    this._start();
    return this;
  }
  remove(fn, context) {
    let listener = this._head.next;
    while (listener) {
      if (listener.fn === fn && (context === undefined || listener.context === context)) listener = listener.destroy();
      else listener = listener.next;
    }
    this._cancelIfNeeded();
    return this;
  }
  _start() { if (!this._running && this._head.next) { this._running = true; requestAnimationFrame(this._loop); } }
  _cancelIfNeeded() { if (!this._head.next) this._running = false; }
  _loop() {
    if (!this._head.next) { this._running = false; return; }
    let listener = this._head.next;
    while (listener) {
      try { listener = listener.emit(); }
      catch (e) { console.error('[dsn ticker]', e); listener = listener ? listener.next : null; }
    }
    if (this._running || this._head.next) { this._running = true; requestAnimationFrame(this._loop); }
    else this._running = false;
  }
}

/* ------------------------------------------------------------------ *
 *  game / canvas / Hooks / ui / CONFIG
 * ------------------------------------------------------------------ */

const hooksImpl = {
  _hooks: {},
  _invoke(name, args) {
    const list = this._hooks[name];
    if (!list) return true;
    for (const fn of list.slice()) {
      try { fn(...args); } catch (e) { console.error('[dsn hook]', name, e); }
    }
    return true;
  },
  call(name, ...args) { return this._invoke(name, args); },
  callAll(name, ...args) { return this._invoke(name, args); },
  on(name, fn) { (this._hooks[name] ??= []).push(fn); return fn; },
  once(name, fn) {
    const wrap = (...a) => { this.off(name, wrap); return fn(...a); };
    return this.on(name, wrap);
  },
  off(name, fn) {
    const list = this._hooks[name];
    if (list) this._hooks[name] = list.filter((f) => f !== fn);
  },
};

// Minimal settings store backed by a Map. DSN reads dozens of settings keys;
// unknown keys return their DSN default via the fallback table below.
const SETTINGS_DEFAULTS = {
  'core.performanceMode': 3, // max quality (bump mapping, glow, high shadows, advanced glass)
  'dice-so-nice.enabled': true,
  'dice-so-nice.sounds': true,
  'dice-so-nice.soundsSurface': 'felt',
  'dice-so-nice.soundsVolume': 0.5,
  'dice-so-nice.autoscale': true,
  'dice-so-nice.scale': 75,
  'dice-so-nice.speed': 1,
  'dice-so-nice.shadowQuality': 'high',
  'dice-so-nice.bumpMapping': true,
  'dice-so-nice.glossy': true,
  'dice-so-nice.antialiasing': 'smaa',
  'dice-so-nice.useHighDPI': true,
  'dice-so-nice.throwingForce': 'medium',
  'dice-so-nice.boostThrow': false,
  'dice-so-nice.rollingArea': null,
  'dice-so-nice.canvasZIndex': 'over',
  'dice-so-nice.showExtraDice': false,
  'dice-so-nice.hideAfterRoll': true,
  'dice-so-nice.timeBeforeHide': 2000,
  'dice-so-nice.hideFX': 'fadeOut',
  'dice-so-nice.immersiveDarkness': true,
  'dice-so-nice.documentsForPreload': [],
  'dice-so-nice.performance': 'auto',
  // physics board (DiceBox)
  'dice-so-nice.maxDiceNumber': 20,
  'dice-so-nice.allowInteractivity': false, // no click-to-hold dice; simpler standalone
  'dice-so-nice.persistentDice': false,
  'dice-so-nice.globalAnimationSpeed': '0', // "0" = use per-throw config.speed
};

const settingsStore = new Map();
const gameSettings = {
  get(mod, key) {
    const full = `${mod}.${key}`;
    if (settingsStore.has(full)) return settingsStore.get(full);
    return SETTINGS_DEFAULTS[full];
  },
  set(mod, key, val) { settingsStore.set(`${mod}.${key}`, val); return Promise.resolve(val); },
  register() {},
  registerMenu() {},
};

const ticker = new RafTicker();

// Foundry `canvas` global (the game board / PIXI app). DSN reads a few fields.
const canvasShim = {
  app: {
    ticker,
    renderer: { context: { extensions: { floatTextureLinear: false } } },
  },
  darknessLevel: 0,
  ready: false,
  scene: null,
};

const userShim = {
  id: 'local',
  name: 'local',
  color: '#ff0000',
  isGM: true,
  _flags: {},
  getFlag(scope, key) { return this._flags?.[`${scope}.${key}`] ?? null; },
  async setFlag(scope, key, val) { (this._flags ??= {})[`${scope}.${key}`] = val; return val; },
  async unsetFlag(scope, key) { delete this._flags?.[`${scope}.${key}`]; },
};

const gameShim = {
  ready: true,
  user: userShim,
  userId: 'local',
  // Foundry game.users is a Collection (iterable + forEach + get). Array covers
  // forEach/map/filter; get/players added for the methods DSN calls.
  users: Object.assign([userShim], { get: () => userShim, players: [userShim] }),
  settings: gameSettings,
  i18n: {
    localize: (k) => k,
    format: (k, data = {}) => k.replace(/\{(\w+)\}/g, (_, n) => (n in data ? data[n] : `{${n}}`)),
    lang: 'es',
    has: () => false,
  },
  modules: { get: () => ({ active: false }) },
  system: { id: 'roliando' },
  canvas: canvasShim,
  // audio system: pending = preload callbacks Foundry flushes after a user
  // gesture (see flushAudioPending); interface = the Web Audio context.
  audio: {
    pending: [],
    get interface() { return getAudioContext(); },
    locked: false,
    playing: new Map(),
  },
  // dice3d is set by DsnEngine after the Dice3D instance is created.
  dice3d: null,
};

const uiShim = {
  notifications: {
    info: (m) => console.info('[dsn]', m),
    warn: (m) => console.warn('[dsn]', m),
    error: (m) => console.error('[dsn]', m),
  },
  sidebar: { expanded: false, element: { clientWidth: 0, querySelector: () => null } },
  activeWindow: null,
};

// CONFIG.Dice.terms maps a die denominator letter (c=Coin, f=Fate, …) to a
// Foundry DiceTerm class. DSN reads `.name` off it for explicit lookups, AND
// iterates it with `for...in` to auto-register system dice terms — which a
// standalone app has none of. The Proxy therefore returns a named stub on
// `get` (so lookups work) but reports NO own keys (so `for...in` skips the
// auto-registration loop entirely).
const diceTermsTarget = { c: { name: 'Coin' }, f: { name: 'FateDie' }, d: { name: 'Die' } };
const diceTermsProxy = new Proxy(diceTermsTarget, {
  get(target, prop) { return target[prop] ?? { name: 'Die' }; },
  ownKeys() { return []; },
  getOwnPropertyDescriptor() { return undefined; },
});
const configShim = { Dice: { terms: diceTermsProxy, types: [] } };

/* ------------------------------------------------------------------ *
 *  install globals (idempotent)
 * ------------------------------------------------------------------ */

const g = globalThis;
if (!g.__dsnShimInstalled) {
  g.foundry = g.foundry ?? foundryShim;
  if (!g.foundry.utils) g.foundry.utils = foundryShim.utils;
  g.game = g.game ?? gameShim;
  g.canvas = g.canvas ?? canvasShim;
  g.Hooks = g.Hooks ?? hooksImpl;
  g.ui = g.ui ?? uiShim;
  g.CONFIG = g.CONFIG ?? configShim;
  g.__dsnShimInstalled = true;
}

/* ------------------------------------------------------------------ *
 *  asset URL resolution
 * ------------------------------------------------------------------ *
 * DSN hardcodes asset paths as `modules/dice-so-nice/...` (relative, Foundry
 * resolves them from the server root). In a SPA served at a nested route those
 * resolve relative to the current path and 404. We serve the assets at
 * `public/modules/dice-so-nice/` and rewrite the relative paths to absolute.
 * Wired into THREE's DefaultLoadingManager and AssetsLoader.
 */
export function resolveDsnUrl(url) {
  if (typeof url !== 'string') return url;
  let u = url.replace(/^\.\//, '');
  if (u.startsWith('modules/')) return '/' + u;
  return url;
}

export { mergeObject, deepClone, isEmpty, getProperty, setProperty, ticker, gameShim, canvasShim };
export default foundryShim;
