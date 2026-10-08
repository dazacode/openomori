// Keeps pictures (cutscene stills, overlays) centred in the wide map view.
//
// Stock MV computes a centring offset for the picture layer but applies it with setFrame() on a Sprite
// that has no bitmap, which does nothing; at 640 wide that was invisible, in a wider view every picture
// hugs the left edge. We apply the offset for real. A full-screen still is only 640 wide, so while an
// opaque one is up we also black out the extra world on either side, as the original game would show.

const COVER_TOLERANCE = 8;   // px a picture may fall short of the UI box and still count as "full screen"
const MIN_ALPHA = 0.3;       // ignore faint full-screen overlays (fog etc.)

export function installCutsceneLayout(): void {
    const offsetX = () => (Graphics.width - Graphics.boxWidth) / 2;
    const offsetY = () => (Graphics.height - Graphics.boxHeight) / 2;

    const createPicturesStock = Spriteset_Base.prototype.createPictures;
    Spriteset_Base.prototype.createPictures = function () {
        createPicturesStock.call(this);
        const container = this._pictureContainer;
        // The stock setFrame(x, y, ...) call leaves pivot = (x, y) on this bitmap-less Sprite, which cancels
        // any position we give it. Clear the pivot, then position the layer.
        container.pivot.set(0, 0);
        container.x = offsetX();
        container.y = offsetY();

        // KEN_PictureBelowChars moves one picture into the tilemap, outside the container: offset it too.
        for (const child of this._tilemap?.children ?? []) {
            if (child instanceof Sprite_Picture) child._wideOffset = true;
        }

        // Side panels, as a sibling *below* the container (other plugins index the container's children).
        const mask = new PIXI.Graphics();
        mask.beginFill(0x000000);
        const ox = offsetX(), oy = offsetY(), w = Graphics.width, h = Graphics.height;
        if (ox > 0) { mask.drawRect(0, 0, ox, h); mask.drawRect(w - ox, 0, ox, h); }
        if (oy > 0) { mask.drawRect(0, 0, w, oy); mask.drawRect(0, h - oy, w, oy); }
        mask.endFill();
        mask.alpha = 0;
        this._cutsceneMask = mask;
        this.addChildAt(mask, this.getChildIndex(container));
    };

    const updatePositionStock = Sprite_Picture.prototype.updatePosition;
    Sprite_Picture.prototype.updatePosition = function () {
        updatePositionStock.call(this);
        if (this._wideOffset) { this.x += offsetX(); this.y += offsetY(); }
    };

    const updateStock = Spriteset_Base.prototype.update;
    Spriteset_Base.prototype.update = function () {
        updateStock.call(this);
        const mask = this._cutsceneMask;
        if (!mask) return;
        const bw = Graphics.boxWidth, bh = Graphics.boxHeight;
        let cover = 0;
        for (const s of this._pictureContainer.children) {
            if (!s.visible || s.blendMode !== 0 || s.alpha < MIN_ALPHA || !s.bitmap?.isReady()) continue;
            const w = s.width * Math.abs(s.scale.x), h = s.height * Math.abs(s.scale.y);
            const left = s.x - s.anchor.x * w, top = s.y - s.anchor.y * h;
            if (left <= COVER_TOLERANCE && left + w >= bw - COVER_TOLERANCE && top <= COVER_TOLERANCE && top + h >= bh - COVER_TOLERANCE) {
                cover = Math.max(cover, s.alpha);
            }
        }
        mask.alpha = cover;
    };
}
