/**
 * themeImport.js — parse a Dice So Nice theme export (any known format) into a
 * colorset object that DsnEngine.addColorset accepts.
 *
 * Format gotcha: colorsets use foreground/background/outline/edge, but Foundry
 * *appearance* exports use labelColor/diceColor/outlineColor/edgeColor. We map
 * appearance → colorset.
 *
 * Supported inputs:
 *   - Full config export:  { appearance: { global, dNN… }, saves: { name: { appearance } } }
 *   - Library export:      { dsnLibraryExport: true, dice: [ { name, baseAppearance } ] }
 *   - Bare colorset:       { name, foreground, background, outline, edge, texture, material, font }
 *   - Bare appearance:     { labelColor, diceColor, outlineColor, edgeColor, texture, material }
 *
 * The referenced texture/material must already be registered (DSN built-in or
 * added via addTexture). A theme referencing a custom texture we don't have
 * bundled still imports — it just renders without that texture overlay.
 */

function fromAppearance(a, name) {
  if (!a || typeof a !== 'object') return null;
  return {
    name: name || a.name || 'Tema importado',
    foreground: a.labelColor ?? 'custom',
    background: a.diceColor ?? 'custom',
    outline: a.outlineColor ?? '',
    edge: a.edgeColor ?? '',
    texture: a.texture ?? 'none',
    material: a.material ?? 'auto',
    font: a.font ?? 'auto',
  };
}

function fromColorset(c, name) {
  if (!c || typeof c !== 'object') return null;
  const out = {
    name: name || c.name || c.description || 'Tema importado',
    foreground: c.foreground ?? 'custom',
    background: c.background ?? 'custom',
    outline: c.outline ?? '',
    edge: c.edge ?? '',
    texture: c.texture ?? 'none',
    material: c.material ?? 'auto',
    font: c.font ?? 'auto',
  };
  if (c.labelComposite) out.labelComposite = c.labelComposite;
  if (c.backgroundComposite) out.backgroundComposite = c.backgroundComposite;
  if (c.visibility) out.visibility = c.visibility;
  return out;
}

/**
 * @param {string|object} input DSN theme JSON (string or parsed object)
 * @returns {object|null} a colorset for DsnEngine.addColorset, or null if unrecognised
 */
export function parseDsnTheme(input) {
  let json = input;
  if (typeof input === 'string') {
    try { json = JSON.parse(input); } catch { return null; }
  }
  if (!json || typeof json !== 'object') return null;

  // full config export → global appearance
  if (json.appearance?.global) return fromAppearance(json.appearance.global, json.name);

  // saves map → first save's global appearance
  if (json.saves && typeof json.saves === 'object') {
    const first = Object.entries(json.saves)[0];
    if (first) {
      const cs = fromAppearance(first[1]?.appearance?.global, first[0]);
      if (cs) return cs;
    }
  }

  // library export → first die's base appearance
  if (json.dsnLibraryExport && Array.isArray(json.dice) && json.dice[0]) {
    const d = json.dice[0];
    const cs = fromAppearance(d.baseAppearance || d.appearance?.global, d.name);
    if (cs) return cs;
  }

  // bare colorset
  if ('foreground' in json || 'background' in json) return fromColorset(json, json.name);

  // bare appearance
  if ('labelColor' in json || 'diceColor' in json) return fromAppearance(json, json.name);

  return null;
}
