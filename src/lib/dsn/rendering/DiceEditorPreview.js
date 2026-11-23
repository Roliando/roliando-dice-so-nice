import '../foundryShim.js'; // puebla globalThis.canvas/ticker/game… (Foundry-free)
import {
    BufferGeometry,
    Float32BufferAttribute,
    LineBasicMaterial,
    LineSegments,
    Mesh,
    MeshBasicMaterial,
    Quaternion,
    Raycaster,
    Triangle,
    Vector2,
    Vector3
} from 'three';
import { DiceScene } from '../engine/DiceScene.js';
import { LEGACY_TO_METERS } from '../engine/SceneConstants.js';
import { DsnEngine } from '../DsnEngine.js'; // reemplaza el Dice3D de Foundry (ALL_CONFIG)
import { DICE_SHAPE } from '../engine/DiceModels.js';
import { Utils } from '../Utils.js';

//wraps a DiceScene with manual mesh rotation + face raycasting
export class DiceEditorPreview {

    constructor(container, diceFactory) {
        this.container = container;
        this.diceFactory = diceFactory;
        this.dieMesh = null;
        this.selectedFaces = new Set();
        this.onFaceSelect = null;
        this.diceScene = null;
        this.aplicarEscalaModelo = false;
        this._resaltes = null; //Roliando: caras resaltadas {caras:[{normal,color,relleno}], girarA}
        this._giro = null;
    }

    async init() {
        const width = this.container.clientWidth || 300;
        const height = this.container.clientHeight || 300;

        const config = foundry.utils.mergeObject(
            DsnEngine.ALL_CONFIG(),
            {
                rendererCacheKey: "editor",
                dimensions: { width, height },
                autoscale: false,
                scale: 60
            }
        );

        this.diceScene = new DiceScene(this.container, this.diceFactory, config);
        await this.diceScene.initialize();
        this.diceScene.setupBloomPipeline();

        this.diceScene.camera.position.set(150 * LEGACY_TO_METERS, 540 * LEGACY_TO_METERS, 200 * LEGACY_TO_METERS);
        this.diceScene.camera.lookAt(0, 0, 0);
        this.diceScene.camera.updateProjectionMatrix();

        this._initControls();
        this._initRaycasting();
        canvas.app.ticker.add(this._animate, this);
    }

    _initControls() {
        //LEFT-drag (or right-drag) rotates the mesh (not camera) so HDR lighting changes.
        //A small movement threshold separates rotate-drags from face-select clicks, and
        //wheel dollies the camera WITHOUT bubbling to the page (the studio workspace
        //zooms the 2D canvas on wheel — the preview must not steal/leak gestures).
        this._isDragging = false;
        this._dragMoved = false;
        this._prevMouse = { x: 0, y: 0 };
        this._zoom = 1;
        this._camBase = null; //set on first dolly (camera already positioned by init)
        const canvas = this.diceScene.renderer.domElement;
        canvas.style.cursor = "grab";
        canvas.style.touchAction = "none";

        this._onContextMenu = (e) => e.preventDefault();
        canvas.addEventListener("contextmenu", this._onContextMenu);

        this._onPointerDown = (e) => {
            if (e.button !== 0 && e.button !== 2) return;
            e.stopPropagation(); //que el workspace no arranque su pan
            this._giro = null; //Roliando: el usuario coge el dado: se acaba el giro automatico
            this._isDragging = true;
            this._dragMoved = false;
            this._prevMouse.x = e.clientX;
            this._prevMouse.y = e.clientY;
            try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
            canvas.style.cursor = "grabbing";
        };
        canvas.addEventListener("pointerdown", this._onPointerDown);

        this._onPointerMove = (e) => {
            if (!this._isDragging || !this.dieMesh) return;
            const dx = e.clientX - this._prevMouse.x;
            const dy = e.clientY - this._prevMouse.y;
            this._prevMouse.x = e.clientX;
            this._prevMouse.y = e.clientY;
            if (Math.abs(dx) + Math.abs(dy) > 0) this._dragMoved = this._dragMoved || (Math.hypot(dx, dy) > 1.5);

            //camera-relative axes so drag direction always feels natural
            const speed = 0.01;
            const cameraRight = new Vector3();
            const cameraUp = new Vector3();
            cameraRight.setFromMatrixColumn(this.diceScene.camera.matrixWorld, 0);
            cameraUp.setFromMatrixColumn(this.diceScene.camera.matrixWorld, 1);

            const qX = new Quaternion().setFromAxisAngle(cameraUp, dx * speed);
            const qY = new Quaternion().setFromAxisAngle(cameraRight, dy * speed);
            this.dieMesh.quaternion.premultiply(qX).premultiply(qY);
        };
        canvas.addEventListener("pointermove", this._onPointerMove);

        this._onPointerUp = (e) => {
            if (!this._isDragging) return;
            this._isDragging = false;
            canvas.style.cursor = "grab";
            try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        };
        canvas.addEventListener("pointerup", this._onPointerUp);
        canvas.addEventListener("pointercancel", this._onPointerUp);

        //wheel = dolly del dado; preventDefault+stopPropagation para no zoomear la página/lienzo
        this._onWheel = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this._camBase) this._camBase = this.diceScene.camera.position.clone();
            this._zoom = Math.max(0.45, Math.min(2.4, this._zoom * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
            this.diceScene.camera.position.copy(this._camBase).multiplyScalar(this._zoom);
            this.diceScene.camera.lookAt(0, 0, 0);
            this.diceScene.camera.updateProjectionMatrix();
        };
        canvas.addEventListener("wheel", this._onWheel, { passive: false });
    }

    _initRaycasting() {
        this.raycaster = new Raycaster();
        this.mouse = new Vector2();

        this._onClick = (event) => {
            if (!this.dieMesh) return;
            if (this._dragMoved) return; //fue un arrastre de rotación, no un click de cara

            const rect = this.diceScene.renderer.domElement.getBoundingClientRect();
            this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.diceScene.camera);
            const intersects = this.raycaster.intersectObject(this.dieMesh, true);
            if (intersects.length === 0) return;

            const hit = intersects[0];
            const faceValue = this._hitToFaceValue(hit);
            if (faceValue === null) return;

            if (event.ctrlKey || event.metaKey) {
                if (this.selectedFaces.has(faceValue)) {
                    this.selectedFaces.delete(faceValue);
                } else {
                    this.selectedFaces.add(faceValue);
                }
            } else {
                this.selectedFaces.clear();
                this.selectedFaces.add(faceValue);
            }

            if (this.onFaceSelect) {
                this.onFaceSelect(new Set(this.selectedFaces));
            }
        };
        this.diceScene.renderer.domElement.addEventListener("click", this._onClick);
    }

    //compare hit triangle normal against known face normals from DICE_SHAPE
    _hitToFaceValue(hit) {
        if (!this._faceNormals) return null;

        const localNormal = hit.face.normal.clone();

        let bestValue = null;
        let bestAngle = Math.PI;
        for (const { normal, value } of this._faceNormals) {
            const angle = localNormal.angleTo(normal);
            if (angle < bestAngle) {
                bestAngle = angle;
                bestValue = value;
            }
        }

        return bestValue;
    }

    _buildFaceNormals(diceobj) {
        this._faceNormals = null;
        this._shapeToTypeValue = {};
        const shapeData = DICE_SHAPE[diceobj.shape];
        if (!shapeData) return;

        this._faceNormals = [];

        //for inherited shapes (df->d6, d3->d6, etc), values cycle
        const mapToTypeValue = (shapeFaceValue) => {
            return diceobj.values[(shapeFaceValue - 1) % diceobj.values.length];
        };

        if (shapeData.type === "Cylinder") {
            const valueFaceValues = shapeData.faceValues.filter(v => v !== 0);
            if (valueFaceValues.length >= 2) {
                this._faceNormals.push({ normal: new Vector3(0, 1, 0), value: valueFaceValues[1] });
                this._faceNormals.push({ normal: new Vector3(0, -1, 0), value: valueFaceValues[0] });
                for (const sfv of valueFaceValues) {
                    this._shapeToTypeValue[sfv] = mapToTypeValue(sfv);
                }
            }
        } else if (shapeData.vertices && shapeData.faces) {
            const verts = shapeData.vertices.map(v => new Vector3(v[0], v[1], v[2]));

            for (let i = 0; i < shapeData.faces.length; i++) {
                const face = shapeData.faces[i];
                const shapeFaceValue = shapeData.faceValues[i];
                if (shapeFaceValue === 0) continue;

                const tri = new Triangle(verts[face[0]], verts[face[1]], verts[face[2]]);
                const normal = new Vector3();
                tri.getNormal(normal);

                this._faceNormals.push({ normal, value: shapeFaceValue });
                this._shapeToTypeValue[shapeFaceValue] = mapToTypeValue(shapeFaceValue);
            }
        }

        this._typeValueLabels = {};
        const labels = Array.isArray(diceobj.labels[0]) ? diceobj.labels[0] : diceobj.labels;
        const edgeOffset = labels.length - diceobj.values.length;
        for (let i = 0; i < diceobj.values.length; i++) {
            const label = labels[i + edgeOffset];
            if (label !== undefined && typeof label === 'string') {
                this._typeValueLabels[diceobj.values[i]] = label;
            }
        }
    }

    _animate() {
        if (this._giro && this.dieMesh) {
            const g = this._giro;
            const k = Math.min(1, (performance.now() - g.t0) / g.dur);
            const e = 1 - Math.pow(1 - k, 3);
            this.dieMesh.quaternion.slerpQuaternions(g.desde, g.hasta, e);
            if (k >= 1) this._giro = null;
        }
        this.diceScene.renderScene();
    }

    //Roliando: la normal LOCAL de la cara de ese valor (null si la forma no tiene normales conocidas)
    normalDeCara(valor) {
        const f = (this._faceNormals || []).find((x) => x.value === valor);
        return f ? [f.normal.x, f.normal.y, f.normal.z] : null;
    }

    //Roliando: gira el dado (con suavidad) hasta que la normal local mire a la camara
    girarANormal(normal) {
        if (!this.dieMesh || !this.diceScene?.camera) return;
        const n = new Vector3(normal[0], normal[1], normal[2]).normalize();
        const cam = this.diceScene.camera.position.clone().normalize();
        const hasta = new Quaternion().setFromUnitVectors(n, cam);
        //un poco de lado: de frente un cubo parece un cuadrado plano y se pierde el volumen del dado
        const arriba = new Vector3().setFromMatrixColumn(this.diceScene.camera.matrixWorld, 1);
        const derecha = new Vector3().setFromMatrixColumn(this.diceScene.camera.matrixWorld, 0);
        hasta.premultiply(new Quaternion().setFromAxisAngle(arriba, -0.42)).premultiply(new Quaternion().setFromAxisAngle(derecha, 0.3));
        this._giro = { desde: this.dieMesh.quaternion.clone(), hasta, t0: performance.now(), dur: 420 };
    }

    //Roliando: quita los resaltes dibujados sobre el dado
    _quitarResaltes() {
        if (!this.dieMesh) return;
        const fuera = [];
        this.dieMesh.traverse((n) => { if (n.userData?.resalte) fuera.push(n); });
        for (const n of fuera) { n.parent?.remove(n); n.geometry?.dispose?.(); n.material?.dispose?.(); }
    }

    /**
     * Roliando: resalta caras por su normal LOCAL (relleno translucido + contorno, justo encima de la superficie) y,
     * si se pide, gira el dado hasta enseñar `girarA`. `caras` = [{ normal:[x,y,z], color:'#rrggbb', relleno:bool }].
     * Se recuerda y se repinta solo cuando el dado se reconstruye (cambio de textura, dado, modelo).
     */
    setResaltes(caras, girarA = null) {
        this._resaltes = Array.isArray(caras) ? caras : null;
        this._aplicarResaltes();
        if (girarA) this.girarANormal(girarA);
    }

    _aplicarResaltes() {
        if (!this.dieMesh) return;
        this._quitarResaltes();
        const lista = this._resaltes;
        if (!lista?.length) return;
        const mallas = [];
        this.dieMesh.traverse((n) => { if (n.isMesh && n.geometry?.attributes?.position && !n.userData?.resalte) mallas.push(n); });
        const A = new Vector3(); const B = new Vector3(); const C = new Vector3(); const nt = new Vector3();
        for (const m of mallas) {
            const pos = m.geometry.attributes.position;
            const idx = m.geometry.index;
            const nTri = (idx ? idx.count : pos.count) / 3;
            if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
            const eps = (m.geometry.boundingSphere?.radius || 1) * 0.012;
            for (const it of lista) {
                const objetivo = new Vector3(it.normal[0], it.normal[1], it.normal[2]).normalize();
                const tris = [];
                for (let t = 0; t < nTri; t++) {
                    const i0 = idx ? idx.getX(t * 3) : t * 3; const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1; const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
                    A.fromBufferAttribute(pos, i0); B.fromBufferAttribute(pos, i1); C.fromBufferAttribute(pos, i2);
                    nt.crossVectors(B.clone().sub(A), C.clone().sub(A));
                    if (nt.lengthSq() < 1e-20) continue;
                    nt.normalize();
                    if (nt.dot(objetivo) < 0.9986) continue; //~3 grados: solo el plano de la cara, no el chaflan
                    tris.push([A.clone(), B.clone(), C.clone()]);
                }
                if (!tris.length) continue;
                const desp = objetivo.clone().multiplyScalar(eps);
                if (it.relleno !== false) {
                    const v = [];
                    for (const tr of tris) for (const p of tr) v.push(p.x + desp.x, p.y + desp.y, p.z + desp.z);
                    const g = new BufferGeometry();
                    g.setAttribute('position', new Float32BufferAttribute(v, 3));
                    const malla = new Mesh(g, new MeshBasicMaterial({ color: it.color, transparent: true, opacity: it.opacidad ?? 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
                    malla.userData.resalte = true; malla.renderOrder = 4;
                    m.add(malla);
                }
                //contorno: las aristas que solo tiene un triangulo de la cara
                const cuenta = new Map();
                const clave = (p) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)},${Math.round(p.z * 1000)}`;
                for (const tr of tris) {
                    for (let e = 0; e < 3; e++) {
                        const p = tr[e]; const q = tr[(e + 1) % 3];
                        const kp = clave(p); const kq = clave(q);
                        const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
                        const v = cuenta.get(k);
                        if (v) v.n++; else cuenta.set(k, { n: 1, p, q });
                    }
                }
                const seg = [];
                for (const { n, p, q } of cuenta.values()) if (n === 1) seg.push(p.x + desp.x, p.y + desp.y, p.z + desp.z, q.x + desp.x, q.y + desp.y, q.z + desp.z);
                if (seg.length) {
                    const g = new BufferGeometry();
                    g.setAttribute('position', new Float32BufferAttribute(seg, 3));
                    const linea = new LineSegments(g, new LineBasicMaterial({ color: it.color, transparent: true, opacity: 0.95 }));
                    linea.userData.resalte = true; linea.renderOrder = 5;
                    m.add(linea);
                }
            }
        }
    }

    async setDie(dieType, appearance, diceLibrary = null) {
        //guard against concurrent calls - newer call supersedes
        const token = this._setDieToken = {};

        if (this.dieMesh) {
            this.diceScene.scene.remove(this.dieMesh);
            this.dieMesh = null;
        }

        const scopedTextureCache = this.diceScene.renderer.scopedTextureCache;
        if (!scopedTextureCache) return;

        const mesh = await this.diceFactory.create(scopedTextureCache, dieType, appearance, diceLibrary);
        if (this._setDieToken !== token) return;
        if (!mesh) return;

        this.dieMesh = mesh;
        //Roliando: un modelo propio viene a su tamano nativo (radio 100) y el motor le pone `userData.modelScale` al
        //colocarlo (ThrowEngine, ShowcaseView); sin aplicarlo aqui el modelo llenaba la vista y no se veia. Se enciende
        //con `aplicarEscalaModelo` (el estudio de Tinta); el de Escena queda como estaba.
        if (this.aplicarEscalaModelo && mesh.userData?.modelScale) this.dieMesh.scale.multiplyScalar(mesh.userData.modelScale * 0.85);
        this.dieMesh.scale.multiplyScalar(1.7);
        this.diceScene.scene.add(this.dieMesh);
        this._aplicarResaltes(); //Roliando: los resaltes sobreviven a la reconstruccion del dado

        const diceobj = this.diceFactory.getPresetBySystem(dieType, appearance.system || "standard");
        if (diceobj) {
            this._buildFaceNormals(diceobj);
        }
    }

    async refresh(dieType, appearance, diceLibrary = null) {
        if (appearance.libraryDieId) {
            this.diceFactory.disposeCachedMaterials();
        }
        //preserve rotation across mesh rebuilds
        const savedRotation = this.dieMesh ? this.dieMesh.quaternion.clone() : null;
        const savedSelection = new Set(this.selectedFaces);
        this.selectedFaces.clear();
        await this.setDie(dieType, appearance, diceLibrary);
        if (savedRotation && this.dieMesh) {
            this.dieMesh.quaternion.copy(savedRotation);
        }
        this.selectedFaces = savedSelection;
    }

    resize() {
        const width = this.container.clientWidth || 300;
        const height = this.container.clientHeight || 300;
        const cam = this.diceScene.camera;
        cam.aspect = width / height;
        //Roliando: en un visor mas alto que ancho el dado se salia por los lados; la camara se aleja lo justo
        const k = cam.aspect < 1 ? 1 / cam.aspect : 1;
        const antes = this._aspectK || 1;
        if (Math.abs(k - antes) > 1e-6) {
            const f = k / antes;
            cam.position.multiplyScalar(f);
            if (this._camBase) this._camBase.multiplyScalar(f);
            this._aspectK = k;
            cam.lookAt(0, 0, 0);
        }
        cam.updateProjectionMatrix();
        this.diceScene.renderer.setSize(width, height);
    }

    dispose() {
        //los listeners de puntero/rueda viven en el canvas del renderer (compartido):
        //se quitan aquí para no acumular al remontar el preview
        try {
            const canvas = this.diceScene?.renderer?.domElement;
            if (canvas) {
                if (this._onWheel) canvas.removeEventListener("wheel", this._onWheel);
                if (this._onPointerDown) canvas.removeEventListener("pointerdown", this._onPointerDown);
                if (this._onPointerMove) canvas.removeEventListener("pointermove", this._onPointerMove);
                if (this._onPointerUp) {
                    canvas.removeEventListener("pointerup", this._onPointerUp);
                    canvas.removeEventListener("pointercancel", this._onPointerUp);
                }
                if (this._onClick) canvas.removeEventListener("click", this._onClick);
                if (this._onContextMenu) canvas.removeEventListener("contextmenu", this._onContextMenu);
            }
        } catch { /* noop */ }
        Utils.removeTicker(this._animate);
        if (this.diceScene) {
            this.diceScene.clearScene();
            //renderer is shared via dice3dRenderers.editor, don't dispose it
            if (this.diceScene.renderer.domElement.parentNode) {
                this.diceScene.renderer.domElement.parentNode.removeChild(this.diceScene.renderer.domElement);
            }
            this.diceScene = null;
        }
    }
}
