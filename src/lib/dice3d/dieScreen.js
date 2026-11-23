/**
 * dieScreen — PANTALLA DE RESULTADO en modelos 3D custom (skin C4 y afines).
 *
 * Si el modelo del dado trae un mesh cuyo nombre (o el de su material) suena a
 * pantalla (screen/display/panel/timer/lcd/pantalla/contador), al ASENTARSE la
 * tirada se le pinta el RESULTADO como dígitos LED (canvas → map + emissiveMap:
 * la cifra EMITE y el bloom la enciende). El número se dibuja DENTRO del rect UV
 * que ese mesh muestrea, así funciona aunque la pantalla use solo una región.
 *
 * three puro (sin shim del motor): lo usan dsnArena (tirada real), el visor del
 * Estudio (número demo) y los tests/harness.
 */
import { CanvasTexture, Color, SRGBColorSpace, Vector3, Quaternion } from 'three';

export const SCREEN_RE = /screen|display|panel|timer|lcd|pantalla|contador/i;

/** Meshes-pantalla bajo un root (por nombre de mesh o de su material). */
export function findScreens(root) {
  const out = [];
  if (!root?.traverse) return out;
  root.traverse((node) => {
    if (!node.isMesh) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    const names = [node.name || '', ...mats.map((m) => m?.name || '')].join('|');
    if (SCREEN_RE.test(names)) out.push(node);
  });
  return out;
}

/** ¿El modelo tiene pantalla de resultado? */
export function hasScreen(root) { return findScreens(root).length > 0; }

// Rect UV [u0,v0,u1,v1] que muestrea un mesh (la pantalla puede usar solo una región).
function uvRect(mesh) {
  const uv = mesh.geometry?.attributes?.uv;
  if (!uv || !uv.count) return [0, 0, 1, 1];
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  if (!(u1 > u0) || !(v1 > v0)) return [0, 0, 1, 1];
  return [u0, v0, u1, v1];
}

// Triángulo FRONTAL de la pantalla: el de mayor área 3D cuya normal apunta HACIA
// FUERA del dado (centro ≈ origen tras normalizar). Las pantallas suelen ser cajitas
// (frontal+dorso+cantos) con el MISMO UV en todas las caras: ni la normal media ni
// el área UV distinguen el LCD visible — la geometría sí.
function frontTri(mesh) {
  const g = mesh.geometry;
  const pos = g?.attributes?.position;
  if (!pos) return null;
  const triCount = g.index ? g.index.count / 3 : Math.floor(pos.count / 3);
  const idx = (t, k) => (g.index ? g.index.getX(t * 3 + k) : t * 3 + k);
  let best = null, bestScore = -Infinity;
  for (let t = 0; t < triCount; t++) {
    const a = idx(t, 0), b = idx(t, 1), c = idx(t, 2);
    const P = (i) => new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const p0 = P(a), p1 = P(b), p2 = P(c);
    const n = new Vector3().crossVectors(p1.clone().sub(p0), p2.clone().sub(p0));
    const area = n.length() / 2;
    if (area <= 0) continue;
    n.normalize();
    const centroid = p0.clone().add(p1).add(p2).multiplyScalar(1 / 3);
    const out = centroid.lengthSq() > 1e-8 ? n.dot(centroid.normalize()) : 1;
    const score = area * (out > 0 ? 1 : 0.001); // fuerte castigo a caras que miran adentro
    if (score > bestScore) { bestScore = score; best = [a, b, c]; }
  }
  return best;
}

/**
 * Pinta `text` en las pantallas del dado. El material de pantalla se CLONA una vez
 * por mesh (el motor cachea materiales por tipo+skin: sin el clon, dos dados de la
 * misma tirada compartirían pantalla y mostrarían el mismo número).
 */
export function paintScreens(root, text, { color = '#ff3b2a', off = false } = {}) {
  const screens = findScreens(root);
  for (const mesh of screens) {
    try {
      if (!mesh.userData.__rolOwnScreenMat) {
        const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!src) continue;
        mesh.material = src.clone();
        mesh.userData.__rolOwnScreenMat = true;
      }
      const m = mesh.material;
      const [u0, v0, u1, v1] = uvRect(mesh);
      // Compensación de ASPECTO: el panel puede mapear un UV cuadrado sobre una
      // superficie 4:1 (el C4 lo hace) → el texto se ESTIRABA. Con los gradientes
      // ∇U/∇V del tri frontal se dibuja el glifo pre-comprimido para que quede
      // CUADRADO sobre la superficie real.
      let sxAspect = 1;
      try {
        const tri = frontTri(mesh);
        const gg = mesh.geometry;
        const uvA = gg?.attributes?.uv;
        const posA = gg?.attributes?.position;
        if (tri && uvA && posA) {
          const [ja, jb, jc] = tri;
          const PV = (i) => new Vector3(posA.getX(i), posA.getY(i), posA.getZ(i));
          const q0 = PV(ja), q1 = PV(jb), q2 = PV(jc);
          const ee1 = q1.clone().sub(q0);
          const ee2 = q2.clone().sub(q0);
          const nn = new Vector3().crossVectors(ee1, ee2).normalize();
          const Xb = ee1.clone().normalize();
          const Yb = new Vector3().crossVectors(nn, Xb);
          const xl = ee1.length() || 1;
          const s2x = ee2.dot(Xb), s2y = ee2.dot(Yb);
          if (Math.abs(s2y) > 1e-8) {
            const du1 = uvA.getX(jb) - uvA.getX(ja);
            const du2 = uvA.getX(jc) - uvA.getX(ja);
            const dv1 = uvA.getY(jb) - uvA.getY(ja);
            const dv2 = uvA.getY(jc) - uvA.getY(ja);
            const gux = du1 / xl, guy = (du2 - gux * s2x) / s2y;
            const gvx = dv1 / xl, gvy = (dv2 - gvx * s2x) / s2y;
            const gu = Math.hypot(gux, guy), gv = Math.hypot(gvx, gvy);
            if (gu > 1e-9 && gv > 1e-9) sxAspect = Math.max(0.15, Math.min(6, gu / gv));
          }
        }
      } catch { /* aspecto neutro */ }
      const N = 512;
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const x = c.getContext('2d');
      x.fillStyle = '#060806'; // vidrio apagado
      x.fillRect(0, 0, N, N);
      // CONVENCIÓN glTF: V hacia ABAJO (los loaders ponen flipY=false en sus texturas).
      // Nuestra CanvasTexture usa la MISMA convención (flipY=false abajo) → el canvas se
      // muestrea 1:1 como el arte original y el texto va derecho SIN transforms. (El
      // «20» en espejo/volteado de antes era este mismatch: canvas V-arriba vs glTF V-abajo.)
      const rx = u0 * N, rw = Math.max(8, (u1 - u0) * N);
      const ry = v0 * N, rh = Math.max(8, (v1 - v0) * N);
      if (!off) {
        const label = String(text);
        x.save();
        x.translate(rx + rw / 2, ry + rh / 2);
        x.scale(sxAspect, 1); // pre-compresión: glifo cuadrado SOBRE LA SUPERFICIE
        let fs = rh * 0.74;
        x.font = `700 ${fs}px "Courier New", ui-monospace, monospace`;
        const w = x.measureText(label).width * sxAspect;
        if (w > rw * 0.86) { fs *= (rw * 0.86) / w; x.font = `700 ${fs}px "Courier New", ui-monospace, monospace`; }
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.shadowColor = color;
        x.shadowBlur = Math.max(4, fs * 0.35); // halo LED
        x.fillStyle = color;
        x.fillText(label, 0, 0);
        x.shadowBlur = 0;
        x.fillText(label, 0, 0); // núcleo nítido encima del halo
        x.restore();
      }
      const tex = new CanvasTexture(c);
      tex.flipY = false; // convención glTF (V-abajo), como las texturas del modelo
      try { tex.colorSpace = SRGBColorSpace; } catch { /* three viejo */ }
      m.map = tex;
      m.emissive = new Color(0xffffff);
      m.emissiveMap = tex;      // la cifra EMITE → el bloom la enciende
      m.emissiveIntensity = off ? 0.15 : 0.85; // legible: con bloom, 1.8 quemaba los dígitos
      if ('metalness' in m) m.metalness = Math.min(m.metalness ?? 0, 0.2);
      if ('roughness' in m) m.roughness = Math.max(m.roughness ?? 1, 0.35);
      m.needsUpdate = true;
    } catch { /* pantalla exótica: el dado sigue sin ella */ }
  }
  return screens.length;
}

/** Etiqueta de pantalla para un dado del motor (percentil: decenas '70', unidades '0'). */
export function screenLabelFor(dieType, forcedResult) {
  const fr = parseInt(forcedResult, 10);
  if (!Number.isFinite(fr)) return null;
  if (dieType === 'd100') return fr === 0 ? '00' : String(fr * 10);
  return String(fr);
}

/**
 * PLANTA el dado asentado con la pantalla hacia ARRIBA (la bomba se coloca sola y el
 * timer queda legible). Con pantalla el resultado no depende de la orientación (lo da
 * ella), así que girar el mesh ya quieto es seguro: la física terminó. Además gira en
 * el plano para que el texto se lea desde el frente (+Z de la mesa).
 */
export function plantScreenUp(dicemesh) {
  const q = computePlantQuaternion(dicemesh);
  if (!q) return false;
  dicemesh.quaternion.copy(q);
  return true;
}

/** Quaternion FINAL de plantado (SIN mutar el dado), o null si no hay pantalla. */
export function computePlantQuaternion(dicemesh) {
  const screens = findScreens(dicemesh);
  if (!screens.length) return null;
  try {
    const mesh = screens[0];
    const g = mesh.geometry;
    const pos = g?.attributes?.position;
    if (!pos) return null;
    const qcur = dicemesh.quaternion.clone(); // se trabaja sobre una copia
    // Triángulo FRONTAL (mayor área mirando hacia fuera) — mismo selector que el texto.
    const tri = frontTri(mesh);
    if (!tri) return null;
    const [ia, ib, ic] = tri;
    const P = (i) => new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const p0 = P(ia), p1 = P(ib), p2 = P(ic);
    const e1 = p1.clone().sub(p0);
    const e2 = p2.clone().sub(p0);
    const nLocal = new Vector3().crossVectors(e1, e2).normalize(); // normal GEOMÉTRICA del frontal
    // → mundo con la rotación actual del dado, y quaternion que la lleva a +Y
    const nWorld = nLocal.clone().applyQuaternion(qcur).normalize();
    const up = new Vector3(0, 1, 0);
    const q = new Quaternion().setFromUnitVectors(nWorld, up);
    qcur.premultiply(q);
    // giro en Y: el ARRIBA DEL ARTE hacia -Z (legible desde el frente). Con la
    // convención glTF (V-abajo), arriba del arte = dirección donde V DECRECE: -∇V.
    const uvA = g.attributes.uv;
    let textUp = null;
    if (uvA) {
      const X = e1.clone().normalize();
      const Yb = new Vector3().crossVectors(nLocal, X);
      const xl = e1.length() || 1;
      const s2x = e2.dot(X), s2y = e2.dot(Yb);
      const dv1 = uvA.getY(ib) - uvA.getY(ia);
      const dv2 = uvA.getY(ic) - uvA.getY(ia);
      if (Math.abs(s2y) > 1e-8) {
        const gx = dv1 / xl;
        const gy = (dv2 - gx * s2x) / s2y;
        textUp = X.multiplyScalar(-gx).add(Yb.multiplyScalar(-gy));
        if (textUp.lengthSq() < 1e-10) textUp = null; else textUp.normalize();
      }
    }
    if (!textUp) textUp = new Vector3().crossVectors(nLocal, e1.clone().normalize()).normalize();
    const upWorld = textUp.applyQuaternion(qcur);
    const flat = Math.hypot(upWorld.x, upWorld.z);
    if (flat > 1e-4) {
      const ang = Math.atan2(upWorld.x, upWorld.z) - Math.PI; // destino (0,0,-1)
      const qy = new Quaternion().setFromAxisAngle(up, -ang);
      qcur.premultiply(qy);
    }
    return qcur;
  } catch { return null; }
}

/**
 * Plantado ANIMADO y anti-pisado para la ARENA: el motor puede reescribir el
 * quaternion con el último frame del buffer físico DESPUÉS del callback de fin de
 * tirada — un snap inmediato se perdía y la bomba quedaba como cayera. Espera un
 * pelín, gira SUAVE (slerp easeOut) hasta el plantado y lo RE-FIJA pasado el settle.
 */
export function plantScreenUpAnimated(dicemesh, { delay = 90, duration = 300, settleMs = 750, onFrame = null } = {}) {
  if (!findScreens(dicemesh).length) return false;
  const frame = () => { try { onFrame?.(); } catch { /* render best-effort */ } };
  setTimeout(() => {
    try {
      const target = computePlantQuaternion(dicemesh); // desde la pose REAL post-física
      if (!target) return;
      const start = dicemesh.quaternion.clone();
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const tick = () => {
        try {
          const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          const k = Math.min(1, (now - t0) / duration);
          const e = 1 - Math.pow(1 - k, 3); // easeOut: se PLANTA con golpe suave
          dicemesh.quaternion.copy(start).slerp(target, e);
          frame(); // CLAVE: el motor para su render al asentar — sin esto el giro
                   // (y el LED) no se VEÍAN hasta la siguiente tirada
          if (k < 1) requestAnimationFrame(tick);
          else { dicemesh.quaternion.copy(target); frame(); }
        } catch { /* dado retirado a mitad */ }
      };
      requestAnimationFrame(tick);
      // re-fijado tardío: si un frame rezagado del motor pisó el quaternion, se replanta
      setTimeout(() => { try { dicemesh.quaternion.copy(target); frame(); } catch { /* retirado */ } }, settleMs);
    } catch { /* nunca rompe la tirada */ }
  }, delay);
  return true;
}
