// Display layer: fit the game to any window with no black bars.
//
// * Map scenes render a WIDER view (same 480px height, width follows the window's aspect), so the
//   window fills with game world. MV already separates Graphics.width (render area) from
//   Graphics.boxWidth (UI area, kept at 640 and centred by the engine), so windows/pictures stay put.
// * Every other scene (title, menus, battle, ...) is laid out for 640x480, so it stays 4:3 and the
//   leftover bars are filled with the picture's own edge colours instead of black.
// * The canvas renders at an integer multiple of the logical size (default up to 3x) and the
//   browser downsamples smoothly, replacing the stock stepped, `pixelated` scaling.

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const MAX_WIDE_WIDTH = 1120;  // ~21:9 at 480px tall; wider windows get bars rather than an absurd view
const EDGE_EVERY = 4;         // sample bar colours every Nth rendered frame (~15 Hz)
const STEPS = 12;             // colour stops sampled along each bar's edge

export interface DisplayOptions {
    /** Max internal render multiplier (1..4). `?q=` in the URL overrides it. */
    maxResolution: number;
}

export function installDisplay(opts: DisplayOptions = { maxResolution: 3 }): void {
    const G = Graphics;
    const query = new URLSearchParams(location.search);
    const maxRes = clamp(Number(query.get('q')) || opts.maxResolution, 1, 4);
    const wideEnabled = query.get('wide') !== '0';

    let baseW = 640, baseH = 480;

    // Capture the game's native size (the UI box stays at it).
    const initStock = G.initialize;
    G.initialize = function (w: number, h: number, type: string) {
        baseW = w; baseH = h;
        initStock.call(this, w, h, type);
    };

    // ---- sizing --------------------------------------------------------------------------
    const wideWidth = () => clamp(2 * Math.round((baseH * innerWidth / innerHeight) / 2), baseW, MAX_WIDE_WIDTH);

    function applyMode(wide: boolean) {
        const w = wide && wideEnabled ? wideWidth() : baseW;
        if (G._width === w) return;
        G._width = w;
        G._height = baseH;
        // boxWidth/boxHeight deliberately untouched: the UI stays at the native size, centred by the engine.
        if (G._canvas) G._updateAllElements();
    }

    G._updateRealScale = function () {
        this._stretchEnabled = true;
        const s = Math.min(innerWidth / this._width, innerHeight / this._height);
        this._realScale = s;
        // Integer internal resolution so the browser only ever downsamples slightly.
        this._res = clamp(Math.ceil(s * devicePixelRatio - 0.01), 1, maxRes);
    };

    G._centerElement = function (el: HTMLCanvasElement | HTMLElement) {
        // The game canvas' backing store is larger than the logical size, so size from logical.
        const isMain = el === this._canvas;
        const w = (isMain ? this._width : (el as HTMLCanvasElement).width) * this._realScale;
        const h = (isMain ? this._height : (el as HTMLCanvasElement).height) * this._realScale;
        Object.assign(el.style, {
            position: 'absolute', margin: 'auto', inset: '0',
            width: `${w}px`, height: `${h}px`,
            imageRendering: 'auto', // smooth downsample; the old plugin forced `pixelated`
        });
    };

    G._updateCanvas = function () {
        this._canvas.width = this._width * this._res;
        this._canvas.height = this._height * this._res;
        this._canvas.style.zIndex = '1';
        this._centerElement(this._canvas);
    };

    G._updateRenderer = function () {
        const r = this._renderer;
        if (!r) return;
        r.resolution = this._res;
        if (r.rootRenderTarget) r.rootRenderTarget.resolution = this._res;
        PIXI.settings.FILTER_RESOLUTION = this._res;
        r.resize(this._width, this._height);
    };

    const createStock = G._createRenderer;
    G._createRenderer = function () {
        PIXI.dontSayHello = true;
        try {
            this._renderer = new PIXI.WebGLRenderer(this._width, this._height, {
                view: this._canvas,
                resolution: this._res ?? 1,
                powerPreference: 'high-performance',
                antialias: false,            // 2D sprites; MSAA would only cost fill rate
            });
            this._renderer.textureGC && (this._renderer.textureGC.maxIdle = 1); // as in stock rpg_core
        } catch {
            createStock.call(this); // stock path handles the canvas-renderer fallback
        }
    };

    // ---- per-scene width -----------------------------------------------------------------
    // Decide the render width just before the engine instantiates the next scene.
    const changeSceneStock = SceneManager.changeScene;
    SceneManager.changeScene = function () {
        if (this.isSceneChanging() && !this.isCurrentSceneBusy() && this._nextScene) {
            applyMode(this._nextScene instanceof Scene_Map);
        }
        changeSceneStock.call(this);
    };

    // GALV_CamControl keeps the camera target at Graphics.boxWidth/2 (the 640 UI box), which in a wider
    // view leaves the player left of centre. Let the camera see the full render size while it scrolls.
    const updateScrollStock = Game_Map.prototype.updateScroll;
    Game_Map.prototype.updateScroll = function (...args: unknown[]) {
        const bw = G._boxWidth, bh = G._boxHeight;
        G._boxWidth = G._width; G._boxHeight = G._height;
        try { return updateScrollStock.apply(this, args); }
        finally { G._boxWidth = bw; G._boxHeight = bh; }
    };

    // ---- bar colour ----------------------------------------------------------------------
    // Whatever the canvas doesn't cover is filled with the picture's own edge, sampled as a gradient
    // along the edge (a white title screen gets white bars, a dark scene gets dark bars, no seams).
    const bars = [document.createElement('div'), document.createElement('div')] as const;
    bars.forEach(el => Object.assign(el.style, { position: 'fixed', zIndex: '0', pointerEvents: 'none' }));
    document.body.prepend(...bars);
    document.body.style.background = '#000';

    const mkProbe = (w: number, h: number) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const x = c.getContext('2d', { willReadFrequently: true })!;
        x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
        return x;
    };
    const probeV = mkProbe(1, STEPS), probeH = mkProbe(STEPS, 1);

    /** STEPS colours along one edge of the rendered picture (each a small area average). */
    function edgeColors(src: HTMLCanvasElement, side: 'left' | 'right' | 'top' | 'bottom'): string[] {
        const sw = src.width, sh = src.height, k = 2 * G._res;
        const vertical = side === 'left' || side === 'right';
        const ctx = vertical ? probeV : probeH;
        if (side === 'left') ctx.drawImage(src, 0, 0, k, sh, 0, 0, 1, STEPS);
        else if (side === 'right') ctx.drawImage(src, sw - k, 0, k, sh, 0, 0, 1, STEPS);
        else if (side === 'top') ctx.drawImage(src, 0, 0, sw, k, 0, 0, STEPS, 1);
        else ctx.drawImage(src, 0, sh - k, sw, k, 0, 0, STEPS, 1);
        const d = ctx.getImageData(0, 0, vertical ? 1 : STEPS, vertical ? STEPS : 1).data;
        return Array.from({ length: STEPS }, (_, i) => `rgb(${d[i * 4]},${d[i * 4 + 1]},${d[i * 4 + 2]})`);
    }

    const place = (el: HTMLElement, x: number, y: number, w: number, h: number) =>
        Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });

    function paintBars() {
        const src: HTMLCanvasElement = G._canvas;
        const horizontal = innerWidth / innerHeight >= G._width / G._height; // bars left/right vs top/bottom
        const cw = G._width * G._realScale, ch = G._height * G._realScale;
        const gx = (innerWidth - cw) / 2, gy = (innerHeight - ch) / 2;       // the bars are what's outside the canvas
        const [first, second] = bars;
        if (horizontal) {
            place(first, 0, 0, Math.ceil(gx) + 1, innerHeight);
            place(second, Math.floor(gx + cw) - 1, 0, innerWidth - Math.floor(gx + cw) + 1, innerHeight);
            first.style.background = `linear-gradient(180deg, ${edgeColors(src, 'left')})`;
            second.style.background = `linear-gradient(180deg, ${edgeColors(src, 'right')})`;
        } else {
            place(first, 0, 0, innerWidth, Math.ceil(gy) + 1);
            place(second, 0, Math.floor(gy + ch) - 1, innerWidth, innerHeight - Math.floor(gy + ch) + 1);
            first.style.background = `linear-gradient(90deg, ${edgeColors(src, 'top')})`;
            second.style.background = `linear-gradient(90deg, ${edgeColors(src, 'bottom')})`;
        }
    }

    // WebGL canvases are only readable in the same task as the draw, so sample inside render().
    const renderStock = G.render;
    let n = 0;
    G.render = function (stage: unknown) {
        renderStock.call(this, stage);
        if (this._rendered && ++n % EDGE_EVERY === 0 && this._canvas?.width) {
            try { paintBars(); } catch { /* context lost mid-resize */ }
        }
    };

    // Window resized: recompute scale; re-pick the width if we're not inside a map (maps keep the width
    // they were built with, since their tilemap is sized once).
    window.addEventListener('resize', () => {
        if (!(SceneManager._scene instanceof Scene_Map)) applyMode(false);
    });
}
