import { resolveDsnUrl } from './foundryShim.js';

export class AssetsLoader {
    static cache = {};
    // Roliando: caché SEPARADA para las imágenes crudas. `loadImage` guardaba el
    // HTMLImageElement bajo la MISMA clave que `loadAsset` guarda su envoltorio
    // `{[url]: {source, frame}}`; entre el onload y la línea que reponía el envoltorio
    // había una ventana en la que `loadAsset` devolvía el <img> pelado, `load()` sacaba
    // `Object.keys(img)[0]` (undefined) y la textura acababa sin registrar → dado plano.
    static imgCache = {};

    constructor() {}

    async load(assets = []) {
        if (!Array.isArray(assets)) {
            assets = [assets]; // Ensure assets is always an array
        }

        // Roliando: allSettled, no all. Con `all` una sola imagen rota (404, CORS)
        // tumbaba la carga ENTERA — y como `DiceColors.loadTextures` no tenía `.catch`,
        // la promesa de `addTexture` no se resolvía jamás y la tirada se colgaba.
        const results = await Promise.allSettled(assets.map(asset => this.loadAsset(asset)));

        // Return results with the URL as the key
        const combinedResults = {};
        results.forEach((r, i) => {
            if (r.status !== 'fulfilled') {
                console.warn('[AssetsLoader] no se pudo cargar', assets[i], r.reason?.message || r.reason);
                return;
            }
            const key = Object.keys(r.value)[0];
            combinedResults[key] = r.value[key];
        });
        return combinedResults;
    }

    async loadAsset(asset) {
        if (AssetsLoader.cache[asset]) {
            // If a promise exists in the cache, await it and return the result
            return await AssetsLoader.cache[asset];
        }

        const assetPromise = (async () => {
            const isJson = asset.endsWith('.json');
            if (isJson) {
                // Load JSON and its associated images...
                const response = await fetch(resolveDsnUrl(asset));
                if (!response.ok) throw new Error(`Failed to load JSON asset: ${asset}`);
                const spritesheet = await response.json();
                const result = await this.loadSpriteSheet(asset, spritesheet);
                return { [asset]: result };
            } else {
                // Load a single image...
                const image = await this.loadImage(asset);
                const result = {source: image, frame: {x: 0, y: 0, w: image.width, h: image.height}};
                return { [asset]: result };
            }
        })();

        // Immediately store the promise in the cache
        AssetsLoader.cache[asset] = assetPromise;

        // Await the promise to load and cache the actual result, then return it
        // Roliando: una carga FALLIDA se olvida. Antes la promesa rechazada se quedaba
        // en la caché y envenenaba esa URL para el resto de la sesión: un fallo de red
        // puntual dejaba la skin rota hasta recargar la página.
        let result;
        try {
            result = await assetPromise;
        } catch (e) {
            delete AssetsLoader.cache[asset];
            throw e;
        }
        // Replace the promise in the cache with the actual result for future requests
        AssetsLoader.cache[asset] = result;
        return result;
    }

    async loadSpriteSheet(url, spritesheet) {
        const dirPath = url.substring(0, url.lastIndexOf('/') + 1);
        const baseImageUrl = dirPath + spritesheet.meta.image;
        const image = await this.loadImage(baseImageUrl);
        
        const sprites = {};
        for (const [name, frameInfo] of Object.entries(spritesheet.frames)) {
            sprites[name] = {
                source: image,
                frame: frameInfo.frame
            };
        }
        
        if (spritesheet.meta.related_multi_packs) {
            await Promise.all(spritesheet.meta.related_multi_packs.map(pack => {
                return this.loadAdditionalPack(dirPath + pack, sprites);
            }));
        }

        // Do not change how sprites are cached, just return the flat structure
        return sprites;
    }

    async loadAdditionalPack(url, sprites) {
        const response = await fetch(resolveDsnUrl(url));
        if (!response.ok) throw new Error(`Failed to load additional spritesheet: ${url}`);
        const additionalSpritesheet = await response.json();
        const additionalImage = await this.loadImage(url.substring(0, url.lastIndexOf('/') + 1) + additionalSpritesheet.meta.image);
        
        for (const [name, frameInfo] of Object.entries(additionalSpritesheet.frames)) {
            sprites[name] = {
                source: additionalImage,
                frame: frameInfo.frame
            };
        }
    }

    async loadImage(url) {
        if (AssetsLoader.imgCache[url]) {
            return AssetsLoader.imgCache[url]; // Return from cache if already loaded
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "Anonymous"; // Handle CORS by setting the crossOrigin property
            img.onload = () => {
                AssetsLoader.imgCache[url] = img; // Cache the loaded image
                resolve(img);
            };
            img.onerror = () => {
                reject(new Error(`Failed to load image: ${url}`));
            };
            img.src = resolveDsnUrl(url);
        });
    }
}
