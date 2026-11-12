import { Vec3 } from 'playcanvas';

// The demo running itself: the camera drifts slowly round the front of the figure, each piece
// of the outfit is picked out in turn, then the outfit changes and it starts again. It runs
// when nobody is touching the page, and in presentation mode for recording. The user's camera
// controls are switched off while it runs.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const LEAD_IN = 1.4;        // seconds an outfit is shown before the first piece is picked out
const PER_PIECE = 1.5;      // seconds given to each piece...
const LIT = 1.15;           // ...of which it is lit for this long
const LEAD_OUT = 0.5;       // seconds between the last piece and the change of outfit

const smooth = (t) => {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
};

const offset = new Vec3();

export class Director {
    active = false;

    /** How far back the camera stands, metres. */
    distance = 4.55;

    /**
     * @param {object} o - What the director drives.
     * @param {import('playcanvas').Entity} o.camera - Camera entity.
     * @param {object} o.controls - The camera's CameraControls script.
     * @param {Vec3} o.pivot - Point the camera looks at.
     * @param {import('./callouts.js').Callouts} o.callouts - Callouts.
     * @param {import('./morph.js').Morph} o.morph - Morph.
     * @param {(index: number) => void} o.change - Changes outfit.
     * @param {object[]} o.defs - Figure definitions in outfit order.
     */
    constructor({ camera, controls, pivot, callouts, morph, change, defs }) {
        Object.assign(this, { camera, controls, pivot, callouts, morph, change, defs });
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.time = 0;
        this.shown = 0;

        // ease into the scripted path from wherever the camera is now
        offset.sub2(this.camera.getPosition(), this.pivot);
        this.from = {
            dist: offset.length(),
            yaw: Math.atan2(offset.x, offset.z),
            pitch: -Math.asin(offset.y / (offset.length() || 1))
        };
        this.controls.enabled = false;
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        this.callouts.pinned = -1;
        // hand the camera back where it is
        this.controls.enabled = true;
        this.controls.reset(this.pivot, this.camera.getPosition());
    }

    update(dt) {
        if (!this.active) return;
        this.time += dt;
        const t = this.time;

        // ---- camera: a slow drift across the front of the figure ----------------------------
        const k = smooth(t / 2);
        let yaw = (16 + 20 * Math.sin(TAU * t / 26)) * DEG;
        const pitch = this.from.pitch + ((-5 + 2.5 * Math.sin(TAU * t / 19 + 1)) * DEG - this.from.pitch) * k;
        const dist = this.from.dist + (this.distance + 0.2 * Math.sin(TAU * t / 31 + 2) - this.from.dist) * k;
        // turn the short way round from the starting angle
        let turn = yaw - this.from.yaw;
        turn -= TAU * Math.round(turn / TAU);
        yaw = this.from.yaw + turn * k;

        const c = Math.cos(pitch);
        this.camera.setPosition(
            this.pivot.x + Math.sin(yaw) * c * dist,
            this.pivot.y - Math.sin(pitch) * dist,
            this.pivot.z + Math.cos(yaw) * c * dist
        );
        this.camera.lookAt(this.pivot);

        // ---- the show: pick out each piece, then change outfit ----------------------------------
        if (this.morph.busy) {
            this.shown = 0;
            return;
        }
        this.shown += dt;
        const pieces = [];
        this.defs[this.morph.from].callouts.forEach((def, i) => {
            if (def.id && !def.of) pieces.push(i);
        });

        const u = this.shown - LEAD_IN;
        const step = Math.floor(u / PER_PIECE);
        if (u < 0) {
            this.callouts.pinned = -1;
        } else if (step < pieces.length) {
            this.callouts.pinned = u - step * PER_PIECE < LIT ? pieces[step] : -1;
        } else {
            this.callouts.pinned = -1;
            if (u > pieces.length * PER_PIECE + LEAD_OUT) {
                const next = this.morph.nextReady(this.morph.from);
                // while the other outfits are still loading, go round the pieces again
                if (next < 0) this.shown = 0;
                else this.change(next);
            }
        }
    }
}
