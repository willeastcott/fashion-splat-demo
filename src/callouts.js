import { Vec3 } from 'playcanvas';

// Product callouts pinned to the figure. Each one is a point on a garment, in the figure's rest
// pose. Every frame that point is run through the same skinning as the gaussians (Rig.skin), so
// the callout rides the body as it sways and the head as it turns. During a morph, callout i of
// the outgoing outfit travels to callout i of the incoming one, and its text changes over at
// the moment the wave of the morph passes it.

const SVG = 'http://www.w3.org/2000/svg';
const GAP = 8;              // px kept between stacked labels, and between labels and other UI

const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

const rest = new Vec3();
const tip = new Vec3();
const posed = new Vec3();
const world = new Vec3();
const normal = new Vec3();
const toCam = new Vec3();
const screen = new Vec3();
const axis = new Vec3();
const tmp = new Vec3();

export class Callouts {
    /** Whether callouts are shown at all. */
    enabled = true;

    /** Slot under the pointer, or -1. */
    hover = -1;

    /** Slot picked by a click or tap, or by the show, or -1. */
    pinned = -1;

    /**
     * @param {HTMLElement} root - Element covering the canvas; labels and lines are added to it.
     * @param {object[]} defs - Figure definitions in outfit order (see src/figures.js).
     * @param {(n: number) => string} formatPrice - Price formatter.
     * @param {HTMLElement[]} avoid - Other UI that labels should stay clear of.
     */
    constructor(root, defs, formatPrice, avoid = []) {
        this.root = root;
        this.defs = defs;
        this.formatPrice = formatPrice;
        this.avoid = avoid;
        this.svg = document.createElementNS(SVG, 'svg');
        root.appendChild(this.svg);
        const count = Math.max(...defs.map(d => d.callouts.length));
        this.slots = Array.from({ length: count }, (_, i) => this._createSlot(i));
    }

    _createSlot(i) {
        const g = document.createElementNS(SVG, 'g');
        const path = document.createElementNS(SVG, 'path');
        const halo = document.createElementNS(SVG, 'circle');
        halo.setAttribute('class', 'halo');
        halo.setAttribute('r', '7');
        const dot = document.createElementNS(SVG, 'circle');
        dot.setAttribute('class', 'dot');
        dot.setAttribute('r', '2.5');
        g.append(path, halo, dot);
        g.style.opacity = '0';
        this.svg.appendChild(g);

        const el = document.createElement('div');
        el.className = 'callout';
        el.innerHTML = '<div class="callout-head"><span class="callout-name"></span><span class="callout-price"></span></div><div class="callout-note"></div>';
        this.root.appendChild(el);
        el.addEventListener('pointerenter', () => {
            this.hover = i;
        });
        el.addEventListener('pointerleave', () => {
            if (this.hover === i) this.hover = -1;
        });
        el.addEventListener('click', () => {
            this.pinned = this.pinned === i ? -1 : i;
        });

        return {
            el, g, path, halo, dot,
            name: el.querySelector('.callout-name'),
            price: el.querySelector('.callout-price'),
            note: el.querySelector('.callout-note'),
            def: null,          // callout whose text is showing
            want: null,         // callout that should be showing
            side: 0,            // column the label is in: -1 left, 1 right
            wantSide: 0,
            vis: 0,             // target visibility
            alpha: 0,           // current visibility
            text: 0,            // 0..1, dips to 0 while the text or side changes
            snap: true,         // jump to the target position instead of gliding
            d: 0,               // anchor's offset across the view from the figure's axis, metres
            ax: 0, ay: 0,       // anchor on screen
            tx: 0, ty: 0,       // target for the label's inner bottom corner
            x: 0, y: 0,
            w: 0, h: 0, lw: 0
        };
    }

    _show(slot, def, side) {
        slot.def = def;
        slot.side = side;
        slot.snap = true;
        if (!def) return;
        slot.name.textContent = def.name;
        slot.price.textContent = def.price ? this.formatPrice(def.price) : '';
        slot.note.textContent = def.note ?? '';
        slot.el.classList.toggle('left', side < 0);
        slot.w = slot.el.offsetWidth;
        slot.h = slot.el.offsetHeight;
        if (slot.lw === 0) slot.lw = slot.w;
    }

    /**
     * @param {number} dt - Frame time in seconds.
     * @param {object} o - Scene state.
     * @param {import('playcanvas').Entity} o.camera - Camera entity.
     * @param {import('playcanvas').Entity} o.figure - Entity the figure is rendered on.
     * @param {import('./rig.js').Rig} o.rig - Rig, already updated for this frame.
     * @param {import('./morph.js').Morph} o.morph - Morph, already updated for this frame.
     */
    update(dt, { camera, figure, rig, morph }) {
        const W = this.root.clientWidth, H = this.root.clientHeight;

        // a narrow window (a phone) gets smaller labels that stand closer to the body
        const compact = W < 560;
        if (W !== this._width) {
            // the labels' size depends on the width through the stylesheet: measure again
            this._width = W;
            for (const slot of this.slots) {
                if (!slot.def) continue;
                slot.w = slot.el.offsetWidth;
                slot.h = slot.el.offsetHeight;
            }
        }
        const cam = camera.camera;
        const camPos = camera.getPosition();
        const right = camera.right;
        const forward = camera.forward;
        const M = figure.getWorldTransform();
        const from = this.defs[morph.from].callouts;
        const to = this.defs[morph.to].callouts;

        // where the figure's axis is on screen and how big a metre is there, so the two columns
        // of labels can stand just clear of the body
        M.transformPoint(tmp.set(0, 1, 0), axis);
        cam.worldToScreen(axis, screen);
        const cx = screen.x;
        cam.worldToScreen(tmp.copy(axis).add(right), screen);
        const reach = (compact ? 0.31 : 0.36) * Math.abs(screen.x - cx) + (compact ? 12 : 26);
        const inset = compact ? Math.min(104, W * 0.3) : Math.min(170, W * 0.42);
        const colL = Math.max(cx - reach, inset);
        const colR = Math.min(cx + reach, W - inset);

        // ---- where each anchor is, and whether it can be seen ---------------------------------
        this.slots.forEach((slot, i) => {
            const a = from[i], b = to[i];
            const ref = a ?? b;
            slot.want = a;
            slot.vis = 0;
            if (!ref) return;

            if (morph.busy) {
                const s = morph.progressAt(ref.pos[1]);
                slot.want = s < 0.5 ? a : b;
                if (a && b) {
                    rest.set(a.pos[0] + (b.pos[0] - a.pos[0]) * s, a.pos[1] + (b.pos[1] - a.pos[1]) * s, a.pos[2] + (b.pos[2] - a.pos[2]) * s);
                    normal.set(a.normal[0] + (b.normal[0] - a.normal[0]) * s, a.normal[1] + (b.normal[1] - a.normal[1]) * s, a.normal[2] + (b.normal[2] - a.normal[2]) * s);
                } else {
                    rest.set(ref.pos[0], ref.pos[1], ref.pos[2]);
                    normal.set(ref.normal[0], ref.normal[1], ref.normal[2]);
                }
            } else {
                rest.set(ref.pos[0], ref.pos[1], ref.pos[2]);
                normal.set(ref.normal[0], ref.normal[1], ref.normal[2]);
            }
            if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
            normal.normalize();

            // pose the anchor, and a point just off the surface to carry the normal along
            rig.skin(tip.copy(normal).mulScalar(0.05).add(rest), tip);
            rig.skin(rest, posed);
            normal.sub2(tip, posed).normalize();
            M.transformPoint(posed, world);
            M.transformVector(normal, normal);
            normal.normalize();

            toCam.sub2(camPos, world);
            const depth = -toCam.dot(forward);
            toCam.normalize();
            const facing = normal.dot(toCam);

            cam.worldToScreen(world, screen);
            slot.ax = screen.x;
            slot.ay = screen.y;
            const onScreen = depth > 0.1 && screen.x > -20 && screen.x < W + 20 && screen.y > -20 && screen.y < H + 20;
            if (this.enabled && slot.want && onScreen) slot.vis = smoothstep(0.02, 0.3, facing);

            // how far across the view the anchor is from the figure's axis, metres
            slot.d = (world.x - axis.x) * right.x + (world.z - axis.z) * right.z;
        });

        // split the labels between the two columns: each goes to the side of the visible
        // group's centre that its anchor is on, which keeps the columns balanced from any
        // angle. A little slack stops a label flickering between sides.
        let sum = 0, weight = 0;
        for (const s of this.slots) {
            sum += s.d * s.vis;
            weight += s.vis;
        }
        const mid = weight > 0 ? sum / weight : 0;
        for (const s of this.slots) {
            if (s.vis === 0 && s.wantSide !== 0) continue;
            const d = s.d - mid;
            if (s.wantSide === 0 || d * s.wantSide < -0.03) s.wantSide = d >= 0 ? 1 : -1;
        }

        // ---- stack the labels in their columns ------------------------------------------------
        const rects = this.avoid.map(e => e.getBoundingClientRect()).filter(r => r.width > 0);
        for (const side of [-1, 1]) {
            const col = side < 0 ? colL : colR;
            const list = this.slots.filter(s => s.wantSide === side && (s.vis > 0 || s.alpha > 0.01));
            list.sort((p, q) => p.ay - q.ay);
            let prev = -Infinity;
            for (const s of list) {
                let y = s.ay - (compact ? 10 : 16);
                const x0 = side < 0 ? col - s.w : col;
                const x1 = x0 + s.w;
                for (const r of rects) {
                    if (x1 < r.left - GAP || x0 > r.right + GAP) continue;
                    if (y > r.top - GAP && y - s.h < r.bottom + GAP) {
                        // step past it, away from the nearer screen edge
                        y = r.top + r.bottom < H ? r.bottom + GAP + s.h : r.top - GAP;
                    }
                }
                y = Math.max(y, prev + s.h + GAP, s.h + GAP);
                prev = y;
                s.tx = col;
                s.ty = y;
            }
            let limit = H - GAP;
            for (let k = list.length - 1; k >= 0; k--) {
                const s = list[k];
                if (s.ty > limit) s.ty = limit;
                limit = s.ty - s.h - GAP;
            }
        }

        // ---- the label pointed at or picked stands out: the others are drawn fainter ------------
        if (morph.busy) this.pinned = -1;
        let active = morph.busy ? -1 : (this.hover >= 0 ? this.hover : this.pinned);
        if (active >= 0 && this.slots[active].alpha < 0.5) active = -1;

        // ---- animate and draw -----------------------------------------------------------------
        this.slots.forEach((slot, i) => {
            slot.alpha += (slot.vis - slot.alpha) * ease(slot.vis > slot.alpha ? 6 : 14, dt);
            if (slot.alpha < 0.004 && slot.vis === 0) slot.alpha = 0;

            const sideChange = slot.side !== slot.wantSide;
            if (slot.def !== slot.want || sideChange) {
                // fade the text out, change it while it cannot be seen, and let it fade back in
                slot.text = Math.max(0, slot.text - dt / 0.12);
                if (slot.text === 0 || slot.alpha < 0.02) {
                    slot.text = 0;
                    this._show(slot, slot.want, slot.wantSide);
                }
            } else {
                slot.text = Math.min(1, slot.text + dt / 0.16);
                if (slot.snap || slot.alpha < 0.02) {
                    slot.x = slot.tx;
                    slot.y = slot.ty;
                    slot.lw = slot.w;
                    slot.snap = false;
                } else {
                    const k = ease(10, dt);
                    slot.x += (slot.tx - slot.x) * k;
                    slot.y += (slot.ty - slot.y) * k;
                    slot.lw += (slot.w - slot.lw) * k;
                }
            }

            const dim = active >= 0 && active !== i ? 0.4 : 1;
            const { el, g } = slot;
            if (slot.alpha === 0) {
                if (el.style.opacity !== '0') {
                    el.style.opacity = '0';
                    el.style.pointerEvents = 'none';
                    g.style.opacity = '0';
                }
                return;
            }
            el.style.opacity = (slot.alpha * slot.text * dim).toFixed(3);
            el.style.pointerEvents = slot.alpha > 0.5 ? 'auto' : 'none';
            const left = slot.side < 0 ? slot.x - slot.w : slot.x;
            el.style.transform = `translate(${left.toFixed(1)}px, ${(slot.y - slot.h).toFixed(1)}px)`;

            // the line holds while the text changes, but not while the label swaps sides
            g.style.opacity = (slot.alpha * (sideChange ? slot.text : 1) * dim).toFixed(3);
            const ax = slot.ax.toFixed(1), ay = slot.ay.toFixed(1);
            slot.path.setAttribute('d', `M${ax} ${ay}L${slot.x.toFixed(1)} ${slot.y.toFixed(1)}L${(slot.x + slot.side * slot.lw).toFixed(1)} ${slot.y.toFixed(1)}`);
            slot.dot.setAttribute('cx', ax);
            slot.dot.setAttribute('cy', ay);
            slot.halo.setAttribute('cx', ax);
            slot.halo.setAttribute('cy', ay);
        });
    }
}
