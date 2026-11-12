import { Vec3 } from 'playcanvas';

import { ease, glideTime, panned, zoomed } from './closeup.js';

// The demo running itself: the camera drifts slowly round the front of the figure, goes in to
// each piece of the outfit in turn, pulls back, then the outfit changes and it starts again.
// It runs when nobody is touching the page, and in presentation mode for recording. While it
// runs it places the camera every frame, and keeps the viewer's camera controls in step with
// where it has put it (see the top of src/closeup.js for why they are not switched off).

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const SETTLE = 2;           // seconds to ease into the scripted path when the show starts
const LEAD_IN = 1.4;        // seconds an outfit is shown whole before the camera goes in
const HOLD = 1.2;           // seconds the camera stays with a piece once it has reached it
const LEAD_OUT = 0.5;       // seconds between pulling back and the change of outfit

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
        // The show starts with the outfit that is showing: its pieces, then the change to the
        // next. The camera eases into its path first, so this first tour begins a moment
        // after that has finished, a little later than a tour that follows a change of outfit.
        this.shown = LEAD_IN - (SETTLE + 0.4);
        this.step = -1;         // which of the outfit's pieces the tour has reached; -1 before it

        // Ease into the scripted path from wherever the camera is now and whatever it is
        // looking at, which is a piece if one was picked.
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
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        if (this.focus.distance(this.pivot) > 1e-3) {
            // The camera is at a piece, or on its way to or from one. Leave it there as though
            // the piece had been picked by hand: it can be looked round, and letting go of it
            // takes the camera back out to the whole figure.
            offset.sub2(this.camera.getPosition(), this.focus).normalize().mulScalar(this.distance).add(this.pivot);
            this.callouts.pinned = this.last ? this.last.index : -1;
            this.closeup.adopt(this.last ? this.last.def : null, this.focus, offset);
        } else {
            // the controls have been kept in step, so the camera is theirs where it stands
            this.callouts.pinned = -1;
        }
    }

    // Start moving what the camera looks at, and how far back it stands, to somewhere new. A
    // distance of null is the distance that shows the whole figure. Left to itself the move
    // takes as long as its length calls for.
    _glide(focus, dist, duration) {
        const to = dist ?? this.distance;
        this.seg = {
            t0: this.time,
            duration: duration ?? glideTime(this.dist, to, this.focus.distance(focus), 0, this.camera.camera.fov),
            fromFocus: this.focus.clone(),
            fromDist: this.dist,
            toFocus: focus,
            toDist: dist
        };
    }

    // go in to the piece of callout `index` of the outfit that is showing, or pull back to
    // the whole figure for -1
    _aim(index) {
        this.callouts.pinned = index;
        if (index === this.aimed) return;
        this.aimed = index;
        if (index < 0) {
            this._glide(this.pivot, null);
            return;
        }
        const def = this.defs[this.morph.from].callouts[index];
        const centre = new Vec3();
        const dist = this.closeup.frame(def, this.bodies[this.morph.from], centre);
        this.last = { def, index };
        this._glide(centre, Math.min(dist, this.distance));
    }

    update(dt) {
        if (!this.active) return;
        this.time += dt;
        const t = this.time;

        // ---- camera: a slow drift across the front of whatever it is looking at -------------
        const k = ease(t / SETTLE);
        let yaw = (16 + 20 * Math.sin(TAU * t / 26)) * DEG;
        const pitch = this.from.pitch + ((-5 + 2.5 * Math.sin(TAU * t / 19 + 1)) * DEG - this.from.pitch) * k;
        // turn the short way round from the starting angle
        let turn = yaw - this.from.yaw;
        turn -= TAU * Math.round(turn / TAU);
        yaw = this.from.yaw + turn * k;

        // what it is looking at and how far back it stands: the whole figure, or a piece
        const seg = this.seg;
        const s = ease((t - seg.t0) / seg.duration);
        const to = seg.toDist ?? this.distance + 0.2 * Math.sin(TAU * t / 31 + 2);
        this.focus.lerp(seg.fromFocus, seg.toFocus, panned(seg.fromDist, to, s));
        this.dist = zoomed(seg.fromDist, to, s);

        const c = Math.cos(pitch);
        this.camera.setPosition(
            this.focus.x + Math.sin(yaw) * c * this.dist,
            this.focus.y - Math.sin(pitch) * this.dist,
            this.focus.z + Math.cos(yaw) * c * this.dist
        );
        this.camera.lookAt(this.focus);
        // keep the viewer's controls holding the camera where the show has put it
        this.controls.focusPoint = this.focus;

        // ---- the show: go in to each piece, pull back, then change outfit ----------------------
        if (this.morph.busy) {
            this.shown = 0;
            this.step = -1;
            this._aim(-1);
            return;
        }
        this.shown += dt;
        const pieces = [];
        this.defs[this.morph.from].callouts.forEach((def, i) => {
            if (def.id && !def.of) pieces.push(i);
        });
        // seconds since the camera got to where it was last sent
        const arrived = t - seg.t0 - seg.duration;

        if (this.step < 0) {
            // the outfit is shown whole first
            this._aim(-1);
            if (this.shown >= LEAD_IN) {
                this.step = 0;
                if (pieces.length) this._aim(pieces[0]);
            }
        } else if (this.step < pieces.length) {
            // with a piece: stay a while, then on to the next, or back out after the last
            this._aim(pieces[this.step]);
            if (arrived > HOLD) {
                this.step++;
                this._aim(this.step < pieces.length ? pieces[this.step] : -1);
            }
        } else {
            this._aim(-1);
            if (arrived > LEAD_OUT) {
                const next = this.morph.nextReady(this.morph.from);
                if (next >= 0) {
                    this.change(next);
                } else {
                    // while the other outfits are still loading, go round the pieces again
                    this.shown = 0;
                    this.step = -1;
                }
            }
        }
    }
}
