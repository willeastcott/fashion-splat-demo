import { Vec3 } from 'playcanvas';

// The demo running itself: the camera drifts slowly round the front of the figure, goes in to
// each piece of the outfit in turn, pulls back, then the outfit changes and it starts again.
// It runs when nobody is touching the page, and in presentation mode for recording. The user's
// camera controls are switched off while it runs.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const OPENING = 2.4;        // seconds before the very first outfit change
const SETTLE = 2;           // seconds to ease into the scripted path when the show starts
const LEAD_IN = 1.4;        // seconds an outfit is shown whole before the camera goes in
const GLIDE = 0.9;          // seconds the camera takes to reach a piece, or to pull back
const PER_PIECE = 2.2;      // seconds given to each piece, the glide to it included
const LEAD_OUT = 0.5;       // seconds between pulling back and the change of outfit

const smooth = (t) => {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
};

const offset = new Vec3();

export class Director {
    active = false;

    /** How far back the camera stands to show the whole figure, metres. */
    distance = 4.55;

    /**
     * @param {object} o - What the director drives.
     * @param {import('playcanvas').Entity} o.camera - Camera entity.
     * @param {object} o.controls - The camera's CameraControls script.
     * @param {Vec3} o.pivot - Point the camera looks at to show the whole figure.
     * @param {import('./callouts.js').Callouts} o.callouts - Callouts.
     * @param {import('./closeup.js').Closeup} o.closeup - Frames a piece, and takes the camera
     * over if the show is stopped while it is at one.
     * @param {object[]} o.bodies - What Closeup.frame needs to know of each figure, in outfit
     * order.
     * @param {import('./morph.js').Morph} o.morph - Morph.
     * @param {(index: number) => void} o.change - Changes outfit.
     * @param {object[]} o.defs - Figure definitions in outfit order.
     */
    constructor({ camera, controls, pivot, callouts, closeup, bodies, morph, change, defs }) {
        Object.assign(this, { camera, controls, pivot, callouts, closeup, bodies, morph, change, defs });
        this.focus = new Vec3();        // what the camera is looking at now
        this.dist = this.distance;      // how far from it the camera is now
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.time = 0;
        this.shown = 0;
        // open with an outfit change, since that is what a visitor came to see; the tour of
        // the pieces starts on the second outfit
        this.opening = true;

        // Ease into the scripted path from wherever the camera is now and whatever it is
        // looking at, which is a piece if one was picked. (While the close-up is moving the
        // camera the controls are off and do not know where it is looking.)
        const moving = this.closeup.state === 'in' || this.closeup.state === 'out';
        this.focus.copy(moving ? this.closeup.focus : this.controls.focusPoint);
        offset.sub2(this.camera.getPosition(), this.focus);
        this.dist = offset.length() || 1;
        this.from = {
            yaw: Math.atan2(offset.x, offset.z),
            pitch: -Math.asin(offset.y / this.dist)
        };
        // the piece the camera is at, or was last at
        this.aimed = -1;
        this.last = this.closeup.def && this.callouts.pinned >= 0 ? { def: this.closeup.def, index: this.callouts.pinned } : null;
        this._glide(this.pivot, null, SETTLE);
        this.controls.enabled = false;
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        this.controls.enabled = true;
        if (this.focus.distance(this.pivot) > 1e-3) {
            // The camera is at a piece, or on its way to or from one. Leave it there as though
            // the piece had been picked by hand: it can be looked round, and letting go of it
            // takes the camera back out to the whole figure.
            offset.sub2(this.camera.getPosition(), this.focus).normalize().mulScalar(this.distance).add(this.pivot);
            this.callouts.pinned = this.last ? this.last.index : -1;
            this.closeup.adopt(this.last ? this.last.def : null, this.focus, offset);
        } else {
            // Hand the camera back where it is. Setting the focus point makes the controls
            // take it up exactly where it stands; controls.reset would ease to here from
            // wherever the controls last had the camera, which is where it was before the
            // show began.
            this.callouts.pinned = -1;
            this.controls.focusPoint = this.pivot;
        }
    }

    // start moving what the camera looks at, and how far back it stands, to somewhere new;
    // a distance of null is the distance that shows the whole figure
    _glide(focus, dist, duration) {
        this.seg = { t0: this.time, duration, fromFocus: this.focus.clone(), fromDist: this.dist, toFocus: focus, toDist: dist };
    }

    // go in to the piece of callout `index` of the outfit that is showing, or pull back to
    // the whole figure for -1
    _aim(index) {
        this.callouts.pinned = index;
        if (index === this.aimed) return;
        this.aimed = index;
        if (index < 0) {
            this._glide(this.pivot, null, GLIDE);
            return;
        }
        const def = this.defs[this.morph.from].callouts[index];
        const centre = new Vec3();
        const dist = this.closeup.frame(def, this.bodies[this.morph.from], centre);
        this.last = { def, index };
        this._glide(centre, Math.min(dist, this.distance), GLIDE);
    }

    update(dt) {
        if (!this.active) return;
        this.time += dt;
        const t = this.time;

        // ---- camera: a slow drift across the front of whatever it is looking at -------------
        const k = smooth(t / SETTLE);
        let yaw = (16 + 20 * Math.sin(TAU * t / 26)) * DEG;
        const pitch = this.from.pitch + ((-5 + 2.5 * Math.sin(TAU * t / 19 + 1)) * DEG - this.from.pitch) * k;
        // turn the short way round from the starting angle
        let turn = yaw - this.from.yaw;
        turn -= TAU * Math.round(turn / TAU);
        yaw = this.from.yaw + turn * k;

        // what it is looking at and how far back it stands: the whole figure, or a piece
        const seg = this.seg;
        const s = smooth((t - seg.t0) / seg.duration);
        const whole = this.distance + 0.2 * Math.sin(TAU * t / 31 + 2);
        this.focus.lerp(seg.fromFocus, seg.toFocus, s);
        this.dist = seg.fromDist + ((seg.toDist ?? whole) - seg.fromDist) * s;

        const c = Math.cos(pitch);
        this.camera.setPosition(
            this.focus.x + Math.sin(yaw) * c * this.dist,
            this.focus.y - Math.sin(pitch) * this.dist,
            this.focus.z + Math.cos(yaw) * c * this.dist
        );
        this.camera.lookAt(this.focus);

        // ---- the show: go in to each piece, pull back, then change outfit ----------------------
        if (this.morph.busy) {
            this.shown = 0;
            this._aim(-1);
            return;
        }
        this.shown += dt;
        if (this.opening) {
            if (this.shown < OPENING) return;
            this.opening = false;
            const next = this.morph.nextReady(this.morph.from);
            if (next >= 0) {
                this.change(next);
                return;
            }
            // nothing else has loaded yet: tour this outfit's pieces while waiting
            this.shown = 0;
        }
        const pieces = [];
        this.defs[this.morph.from].callouts.forEach((def, i) => {
            if (def.id && !def.of) pieces.push(i);
        });

        const u = this.shown - LEAD_IN;
        const step = Math.floor(u / PER_PIECE);
        if (u >= 0 && step < pieces.length) {
            this._aim(pieces[step]);
        } else {
            this._aim(-1);
            if (u > pieces.length * PER_PIECE + GLIDE + LEAD_OUT) {
                const next = this.morph.nextReady(this.morph.from);
                // while the other outfits are still loading, go round the pieces again
                if (next < 0) this.shown = 0;
                else this.change(next);
            }
        }
    }
}
