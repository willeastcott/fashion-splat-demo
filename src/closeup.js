import { Vec3 } from 'playcanvas';

// Picking a piece (clicking or tapping its callout) brings the camera in to frame it, and
// letting go of it takes the camera back to where it was. The camera keeps the angle it is
// looking from; only what it looks at and how far away it stands change. Once it has arrived
// the viewer's camera controls are handed back, turning about the piece, so it can be looked
// round and zoomed further.

const TAU = Math.PI * 2;
const DURATION = 0.9;       // seconds for the move in, and for the move back
const MARGIN = 1.18;        // room left round the piece
const NEAREST = 1.15;       // metres: closer than this the gaussians start to show
const HEADROOM = 0.16;      // most of the view's height to leave empty above the figure

const smooth = (t) => {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
};

const offset = new Vec3();

// where a camera at pos is, as seen from the point it looks at
const polar = (pos, focus) => {
    offset.sub2(pos, focus);
    const dist = offset.length() || 1;
    return { dist, yaw: Math.atan2(offset.x, offset.z), pitch: -Math.asin(offset.y / dist) };
};

export class Closeup {
    /** Whether picking a piece moves the camera at all. */
    enabled = true;

    /** 'idle', 'in' (moving to a piece), 'held' (at a piece) or 'out' (moving back). */
    state = 'idle';

    /** The callout the camera is at or moving to, or null. */
    def = null;

    /**
     * @param {object} o - What it drives.
     * @param {import('playcanvas').Entity} o.camera - Camera entity.
     * @param {object} o.controls - The camera's CameraControls script.
     * @param {Vec3} o.pivot - Point the camera looks at when no piece is picked.
     * @param {() => number} o.aspect - Width of the view over its height.
     */
    constructor({ camera, controls, pivot, aspect }) {
        Object.assign(this, { camera, controls, pivot, aspect });
        this.focus = new Vec3();        // what the camera is looking at now
        this.home = new Vec3();         // where the camera was before the first piece was picked
        this.fromFocus = new Vec3();
        this.toFocus = new Vec3();
    }

    get active() {
        return this.state !== 'idle';
    }

    /**
     * Where to look and how far back to stand to frame a callout's piece. A piece is given as a
     * band of heights, a sphere round the callout, or (failing both) just the callout's point.
     *
     * @param {object} def - Callout definition (see src/figures.js).
     * @param {{top: number, box: (def: object) => ({min: number[], max: number[]}|null)}} body -
     * The figure wearing the piece: the height of its top, metres, and the box its gaussians
     * fill within a callout's band of heights (null if that has not been measured).
     * @param {Vec3} centre - Receives the point to look at.
     * @returns {number} Distance to stand back, metres.
     */
    frame(def, body, centre) {
        const r = def.focus?.r;
        const box = def.focus?.y ? body.box(def) : null;
        let w, h;
        if (box) {
            // A band of heights: frame what the outfit really fills of it, which is seldom
            // centred on the figure's axis (feet stand apart, and to one side). How wide that
            // is depends on where it is seen from: take it for an ellipse seen from above.
            const { min, max } = box;
            centre.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
            const p = this.camera.getPosition();
            const yaw = Math.atan2(p.x - centre.x, p.z - centre.z);
            w = Math.hypot((max[0] - min[0]) * Math.cos(yaw), (max[2] - min[2]) * Math.sin(yaw));
            h = max[1] - min[1];
        } else if (r) {
            centre.set(def.pos[0], def.pos[1], def.pos[2]);
            w = h = r * 2.6;
        } else {
            centre.set(def.pos[0], def.pos[1], def.pos[2]);
            w = h = 0.5;
        }
        const t = Math.tan(this.camera.camera.fov * Math.PI / 360);
        const dist = Math.max(NEAREST, MARGIN * Math.max(h / 2 / t, w / 2 / (t * this.aspect())));

        // A small piece at the top of the figure (a hat) would otherwise sit in the middle of
        // the view with nothing but backdrop above it and the head cut off below. Look lower,
        // so that no more than a little of the view is above the figure.
        const half = dist * t;
        centre.y = Math.min(centre.y, body.top + HEADROOM * 2 * half - half);
        return dist;
    }

    /**
     * Say which piece is picked, every frame. The camera moves when the answer changes.
     *
     * @param {object|null} def - The picked callout's definition, or null for none.
     * @param {object} body - The figure wearing it (see frame).
     */
    follow(def, body) {
        if (!this.enabled) def = null;
        if (def === this.def) return;
        this.def = def;
        if (def) {
            if (this.state === 'idle') {
                this.focus.copy(this.pivot);
                this.home.copy(this.camera.getPosition());
            }
            const dist = this.frame(def, body, this.toFocus);
            this._move('in', this.toFocus, null, dist);
        } else if (this.active) {
            this._move('out', this.pivot, this.home, 0);
        }
    }

    /**
     * Take over a view that the show has left the camera in: looking at `focus`, at a piece
     * or on its way to or from one. From here it is as though the piece had been picked by
     * hand: it can be looked round, and letting go of it takes the camera to `home`.
     *
     * @param {object|null} def - The callout whose piece the camera is at, or null if there
     * is none to speak of, in which case the camera goes home straight away.
     * @param {Vec3} focus - The point the camera is looking at.
     * @param {Vec3} home - Where the camera goes back to.
     */
    adopt(def, focus, home) {
        this.focus.copy(focus);
        this.home.copy(home);
        this.def = def;
        this.state = 'held';
        this.controls.enabled = true;
        this.controls.focusPoint = this.focus;
        if (!def) this._move('out', this.pivot, this.home, 0);
    }

    /** Forget the piece without moving: something else is taking the camera over. */
    cancel() {
        this.state = 'idle';
        this.def = null;
    }

    // start a move to looking at `focus`: from `pos` if given, otherwise from the angle the
    // camera has now and `dist` away
    _move(state, focus, pos, dist) {
        const here = this.camera.getPosition();
        this.from = polar(here, this.focus);
        if (pos) {
            this.to = polar(pos, focus);
        } else {
            this.to = { dist, yaw: this.from.yaw, pitch: this.from.pitch };
        }
        // turn the short way round
        let turn = this.to.yaw - this.from.yaw;
        turn -= TAU * Math.round(turn / TAU);
        this.to.yaw = this.from.yaw + turn;
        this.fromFocus.copy(this.focus);
        this.toFocus.copy(focus);
        this.state = state;
        this.time = 0;
        this.controls.enabled = false;
    }

    update(dt) {
        if (this.state !== 'in' && this.state !== 'out') return;
        this.time += dt;
        const k = smooth(this.time / DURATION);
        const { from, to } = this;
        const dist = from.dist + (to.dist - from.dist) * k;
        const yaw = from.yaw + (to.yaw - from.yaw) * k;
        const pitch = from.pitch + (to.pitch - from.pitch) * k;
        this.focus.lerp(this.fromFocus, this.toFocus, k);
        const c = Math.cos(pitch);
        this.camera.setPosition(
            this.focus.x + Math.sin(yaw) * c * dist,
            this.focus.y - Math.sin(pitch) * dist,
            this.focus.z + Math.cos(yaw) * c * dist
        );
        this.camera.lookAt(this.focus);

        if (k >= 1) {
            // Hand the camera back, turning about whatever it is looking at now. Setting the
            // focus point makes the controls take up the camera exactly where it stands.
            // (controls.reset would not do: it eases to the new view from wherever the controls
            // last had the camera, which is where this move began, so the camera would leap
            // back there and come in a second time.)
            this.state = this.state === 'in' ? 'held' : 'idle';
            this.controls.enabled = true;
            this.controls.focusPoint = this.focus;
        }
    }
}
