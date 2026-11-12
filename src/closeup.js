import { Vec3 } from 'playcanvas';

// Picking a piece (clicking or tapping its callout) brings the camera in to frame it, and
// letting go of it takes the camera back to where it was. The camera keeps the angle it is
// looking from; only what it looks at and how far away it stands change. Once it has arrived
// the viewer's camera controls turn it about the piece, so it can be looked round and zoomed
// further.
//
// The controls are never switched off while the camera is moved for them. They keep a count
// of button presses against releases, and a press or a release made while they were off was
// lost to them: press during a move, let go after it, and the count was left one short, with
// the camera deaf to dragging from then on. Instead they are told where the camera is on
// every frame of a move (their focusPoint). That overrides whatever they made of the input,
// and leaves them holding the camera, exactly where it stands, the moment the move ends.

const TAU = Math.PI * 2;
const MARGIN = 1.18;        // room left round the piece
const NEAREST = 1.15;       // metres: closer than this the gaussians start to show
const HEADROOM = 0.16;      // most of the view's height to leave empty above the figure

/**
 * How far through a move the camera is, a fraction t of the way through the move's time. It
 * sets off and arrives with no speed and no acceleration, so it neither jolts into motion nor
 * stops dead.
 *
 * @param {number} t - Time gone, as a fraction of the time the move takes.
 * @returns {number} How far through the move, 0 to 1.
 */
export const ease = (t) => {
    const x = Math.min(1, Math.max(0, t));
    return x * x * x * (x * (x * 6 - 15) + 10);
};

/**
 * How far back the camera stands, part of the way through a change of distance. The distance
 * changes by equal ratios in equal steps, not by equal amounts, so what is seen grows or
 * shrinks at a steady rate. By equal amounts, a move in would dawdle at the far end and rush
 * the near one, and a move out would lurch away and then crawl.
 *
 * @param {number} from - Distance at the start, metres.
 * @param {number} to - Distance at the end, metres.
 * @param {number} k - How far through the move, 0 to 1.
 * @returns {number} Distance now, metres.
 */
export const zoomed = (from, to, k) => (k >= 1 ? to : from * Math.pow(to / from, k));

/**
 * How far along its way the point the camera looks at is, part of the way through that same
 * change of distance. Going in, it is worked out so that the place the camera is heading for
 * drifts to the middle of the screen at an even pace while it grows: the point has to cover
 * most of its ground early, while the camera is far back and a shift on the screen is a lot
 * of ground. Coming out is that film run backwards: the place the camera is leaving drifts
 * evenly from the middle of the screen to where it belongs in the wider view.
 *
 * @param {number} from - Distance at the start, metres.
 * @param {number} to - Distance at the end, metres.
 * @param {number} k - How far through the move, 0 to 1.
 * @returns {number} How far the point has gone, 0 to 1.
 */
export const panned = (from, to, k) => {
    const ratio = to / from;
    return ratio < 1 ? 1 - (1 - k) * Math.pow(ratio, k) : k * Math.pow(ratio, k - 1);
};

/**
 * How long a move should take: longer the more it zooms, shifts across the view or turns.
 *
 * @param {number} from - Distance at the start, metres.
 * @param {number} to - Distance at the end, metres.
 * @param {number} shift - How far the point looked at moves, metres.
 * @param {number} turn - How far the camera swings round that point, radians.
 * @param {number} fov - The camera's vertical field of view, degrees.
 * @returns {number} Seconds.
 */
export const glideTime = (from, to, shift, turn, fov) => {
    // the height of what is in view half way through, metres
    const view = (from + to) * Math.tan(fov * Math.PI / 360);
    const travel = Math.abs(Math.log(to / from)) + shift / view + turn;
    return Math.min(1.5, Math.max(0.7, 0.55 + 0.32 * travel));
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
     * @param {Vec3} o.pivot - Point the camera looks at to show the whole figure.
     * @param {() => number} o.aspect - Width of the view over its height.
     */
    constructor({ camera, controls, pivot, aspect }) {
        Object.assign(this, { camera, controls, pivot, aspect });
        this.focus = new Vec3();        // what the camera is looking at now
        // the view to go back to: where the camera was, and what it was looking at, before
        // the first piece was picked
        this.home = new Vec3();
        this.homeFocus = new Vec3();
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
                this.home.copy(this.camera.getPosition());
                this.homeFocus.copy(this.controls.focusPoint);
            }
            const dist = this.frame(def, body, this.toFocus);
            this._move('in', this.toFocus, null, dist);
        } else if (this.active) {
            this._move('out', this.homeFocus, this.home, 0);
        }
    }

    /**
     * Take over a view that the show has left the camera in: looking at `focus`, at a piece
     * or on its way to or from one. From here it is as though the piece had been picked by
     * hand: it can be looked round, and letting go of it takes the camera to `home`, looking
     * at the whole figure.
     *
     * @param {object|null} def - The callout whose piece the camera is at, or null if there
     * is none to speak of, in which case the camera goes home straight away.
     * @param {Vec3} focus - The point the camera is looking at.
     * @param {Vec3} home - Where the camera goes back to.
     */
    adopt(def, focus, home) {
        this.focus.copy(focus);
        this.home.copy(home);
        this.homeFocus.copy(this.pivot);
        this.def = def;
        this.state = 'held';
        this.controls.focusPoint = this.focus;
        if (!def) this._move('out', this.homeFocus, this.home, 0);
    }

    /** Forget the piece without moving: something else is taking the camera over. */
    cancel() {
        this.state = 'idle';
        this.def = null;
    }

    // start a move to looking at `focus`: from `pos` if given, otherwise from the angle the
    // camera has now and `dist` away
    _move(state, focus, pos, dist) {
        // unless a move is being cut short, the viewer has the camera, and may have shifted
        // what it looks at as well as turned it
        if (this.state === 'idle' || this.state === 'held') this.focus.copy(this.controls.focusPoint);
        this.from = polar(this.camera.getPosition(), this.focus);
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
        this.duration = glideTime(
            this.from.dist, this.to.dist, this.fromFocus.distance(this.toFocus),
            Math.abs(turn) + Math.abs(this.to.pitch - this.from.pitch), this.camera.camera.fov
        );
        this.state = state;
        this.time = 0;
    }

    update(dt) {
        if (this.state !== 'in' && this.state !== 'out') return;
        this.time += dt;
        const k = ease(this.time / this.duration);
        const { from, to } = this;
        const dist = zoomed(from.dist, to.dist, k);
        const yaw = from.yaw + (to.yaw - from.yaw) * k;
        const pitch = from.pitch + (to.pitch - from.pitch) * k;
        this.focus.lerp(this.fromFocus, this.toFocus, panned(from.dist, to.dist, k));
        const c = Math.cos(pitch);
        this.camera.setPosition(
            this.focus.x + Math.sin(yaw) * c * dist,
            this.focus.y - Math.sin(pitch) * dist,
            this.focus.z + Math.cos(yaw) * c * dist
        );
        this.camera.lookAt(this.focus);

        // keep the controls holding the camera where it has been put (see the top of the file)
        this.controls.focusPoint = this.focus;
        if (k >= 1) this.state = this.state === 'in' ? 'held' : 'idle';
    }
}
