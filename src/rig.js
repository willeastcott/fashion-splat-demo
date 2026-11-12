import { Mat4, Quat, Vec3 } from 'playcanvas';

import { BONE_COUNT } from './rig-shader.js';

const TAU = Math.PI * 2;
const RAD2DEG = 180 / Math.PI;

// bone indices (must match rig-shader.js)
const FOOT = 0, PELVIS = 1, SPINE = 2, CHEST = 3, HEAD = 4, THIGH_L = 5, SHIN_L = 6, THIGH_R = 7, SHIN_R = 8;

const tmpA = new Vec3();
const tmpB = new Vec3();
const tmpC = new Vec3();

// shortest-arc rotation taking direction a onto direction b
const arc = (out, a, b) => {
    tmpA.copy(a).normalize();
    tmpB.copy(b).normalize();
    tmpC.cross(tmpA, tmpB);
    return out.set(tmpC.x, tmpC.y, tmpC.z, 1 + tmpA.dot(tmpB)).normalize();
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
};

const tmpW = new Float32Array(BONE_COUNT);
const tmpS = new Vec3();

/** A rigid transform in rig space: p' = rotate(q, p) + t. */
class Bone {
    q = new Quat();

    t = new Vec3();

    /** Rotate by q about the rest-pose pivot, then carry the pivot to newPivot. */
    setPivot(q, pivot, newPivot) {
        this.q.copy(q);
        q.transformVector(pivot, tmpA);
        this.t.sub2(newPivot, tmpA);
    }

    apply(p, out) {
        this.q.transformVector(p, out);
        return out.add(this.t);
    }
}

/**
 * Procedural idle for a standing figure: weight shift over planted feet, breathing, a slow
 * drift of the head, and an optional turn of the head towards the camera.
 */
export class Rig {
    constructor(def) {
        this.j = Object.fromEntries(Object.keys(def.joints).map(k => [k, new Vec3()]));
        this.setPose(def, def, 0);
        this.bones = Array.from({ length: BONE_COUNT }, () => new Bone());
        this.boneQ = new Float32Array(BONE_COUNT * 4);
        this.boneT = new Float32Array(BONE_COUNT * 4);
        this.breath = 0;
        this.time = 0;
        this.followYaw = 0;
        this.followPitch = 0;
        this.rigInv = new Mat4();
    }

    /**
     * Set the rest pose, blended between two figure definitions. Used while one outfit morphs
     * into another, since every figure has its own proportions.
     *
     * @param {object} a - Figure definition blended from.
     * @param {object} b - Figure definition blended to.
     * @param {number} t - Blend, 0..1.
     */
    setPose(a, b, t) {
        const mix = (x, y) => x + (y - x) * t;
        for (const k in this.j) {
            const p = a.joints[k], q = b.joints[k];
            this.j[k].set(mix(p[0], q[0]), mix(p[1], q[1]), mix(p[2], q[2]));
        }
        this.crotchY = mix(a.crotchY, b.crotchY);
        this.splitX = [mix(a.splitX[0], b.splitX[0]), mix(a.splitX[1], b.splitX[1])];
        this.headYawLimit = mix(a.headYawLimit, b.headYawLimit);
    }

    /**
     * @param {number} dt - Frame time in seconds.
     * @param {object} o - Options.
     * @param {boolean} o.idle - Whether the idle animation runs.
     * @param {number} o.intensity - Multiplier on all idle amplitudes.
     * @param {boolean} o.follow - Whether the head turns towards the camera.
     * @param {Vec3} o.cameraPos - Camera position in rig space.
     */
    update(dt, o) {
        if (o.idle) this.time += dt;
        const t = this.time;
        const k = o.idle ? o.intensity : 0;
        const j = this.j;
        const b = this.bones;

        // ---- signals -----------------------------------------------------------------------
        const sway = 0.6 * Math.sin(TAU * t / 9.0) + 0.4 * Math.sin(TAU * t / 5.3 + 1.3);   // -1..1
        const breath = 0.5 - 0.5 * Math.cos(TAU * t / 4.2);                                // 0..1
        this.breath = 0.012 * breath * k;

        // ---- head follow -------------------------------------------------------------------
        let yawTarget = 0;
        let pitchTarget = 0;
        if (o.follow && o.cameraPos) {
            const dx = o.cameraPos.x - j.neck.x;
            const dz = o.cameraPos.z - j.neck.z;
            const dy = o.cameraPos.y - (j.neck.y + 0.12);
            const az = Math.atan2(dx, dz) * RAD2DEG;
            const limit = this.headYawLimit;
            // ease back to neutral once the camera is well behind the figure
            const behind = clamp((150 - Math.abs(az)) / 40, 0, 1);
            yawTarget = clamp(az, -limit, limit) * behind;
            pitchTarget = clamp(-Math.atan2(dy, Math.hypot(dx, dz)) * RAD2DEG, -8, 8) * behind;
        }
        const ease = 1 - Math.exp(-dt * 2.5);
        this.followYaw += (yawTarget - this.followYaw) * ease;
        this.followPitch += (pitchTarget - this.followPitch) * ease;

        // ---- pelvis: shifts over the standing leg, tips a little -------------------------------
        const pelvisRoll = 1.0 * k * sway;
        const qPelvis = new Quat().setFromEulerAngles(0, 0.6 * k * Math.sin(TAU * t / 11.0 + 2.0), pelvisRoll);
        const pelvisPos = new Vec3(
            j.pelvis.x + 0.012 * k * sway,
            j.pelvis.y - 0.003 * k * Math.abs(sway),
            j.pelvis.z + 0.004 * k * Math.sin(TAU * t / 7.1 + 0.7)
        );
        b[PELVIS].setPivot(qPelvis, j.pelvis, pelvisPos);

        // ---- spine and chest counter the pelvis so the shoulders stay roughly over the feet --------
        const qSpine = new Quat().mul2(qPelvis, new Quat().setFromEulerAngles(0, 0, -1.3 * pelvisRoll));
        b[SPINE].setPivot(qSpine, j.spine, b[PELVIS].apply(j.spine, new Vec3()));

        const chestYaw = 1.2 * k * Math.sin(TAU * t / 13.0 + 0.5) + 0.25 * this.followYaw;
        const qChest = new Quat().mul2(qSpine, new Quat().setFromEulerAngles(-0.5 * k * breath, chestYaw, 0));
        b[CHEST].setPivot(qChest, j.chest, b[SPINE].apply(j.chest, new Vec3()));

        // ---- head ----------------------------------------------------------------------------
        const headYaw = 0.75 * this.followYaw + 3.0 * k * (Math.sin(t * 0.31) + 0.6 * Math.sin(t * 0.73 + 2.0)) / 1.6;
        const headPitch = this.followPitch + 1.5 * k * Math.sin(t * 0.47 + 1.0) - 0.6 * k * breath;
        const headRoll = 0.3 * pelvisRoll + 1.0 * k * Math.sin(t * 0.39 + 4.0);
        const qHead = new Quat().mul2(qChest, new Quat().setFromEulerAngles(headPitch, headYaw, headRoll));
        b[HEAD].setPivot(qHead, j.neck, b[CHEST].apply(j.neck, new Vec3()));

        // ---- legs: feet stay planted, hips follow the pelvis, the unloaded knee relaxes forward ---
        this._leg(THIGH_L, SHIN_L, j.hipL, j.kneeL, j.ankleL, 0.02 * k * Math.max(0, -sway));
        this._leg(THIGH_R, SHIN_R, j.hipR, j.kneeR, j.ankleR, 0.02 * k * Math.max(0, sway));

        // foot bone stays at identity
        b[FOOT].q.set(0, 0, 0, 1);
        b[FOOT].t.set(0, 0, 0);

        // ---- pack ------------------------------------------------------------------------------
        for (let i = 0; i < BONE_COUNT; i++) {
            const q = b[i].q;
            const s = q.w < 0 ? -1 : 1;
            this.boneQ.set([q.x * s, q.y * s, q.z * s, q.w * s], i * 4);
            this.boneT.set([b[i].t.x, b[i].t.y, b[i].t.z, 0], i * 4);
        }
    }

    _leg(thigh, shin, hip, knee, ankle, flex) {
        const b = this.bones;
        const hipNew = b[PELVIS].apply(hip, new Vec3());
        // the knee carries half of the hip's travel, plus a little forward flex
        const kneeNew = new Vec3().sub2(hipNew, hip).mulScalar(0.5).add(knee);
        kneeNew.z += flex;

        const q = new Quat();
        arc(q, new Vec3().sub2(knee, hip), new Vec3().sub2(kneeNew, hipNew));
        b[thigh].setPivot(q, hip, hipNew);

        arc(q, new Vec3().sub2(knee, ankle), new Vec3().sub2(kneeNew, ankle));
        b[shin].setPivot(q, ankle, ankle);
    }

    /**
     * Bone weights at a rest position. Must stay identical to rigWeights in rig-shader.js.
     *
     * @param {Vec3} p - Rest position in rig space.
     * @param {Float32Array} w - Receives the 9 weights.
     * @returns {Float32Array} w.
     */
    weights(p, w) {
        const j = this.j;
        const yAnkle = (j.ankleL.y + j.ankleR.y) * 0.5;
        const yKnee = (j.kneeL.y + j.kneeR.y) * 0.5;
        const yCrotch = this.crotchY;

        const sAnkle = smoothstep(yAnkle - 0.04, yAnkle + 0.06, p.y);
        const sKnee = smoothstep(yKnee - 0.09, yKnee + 0.09, p.y);
        const sUpper = smoothstep(yCrotch - 0.07, yCrotch + 0.09, p.y);
        const sSpine = smoothstep(j.spine.y - 0.08, j.spine.y + 0.08, p.y);
        const sChest = smoothstep(j.chest.y - 0.08, j.chest.y + 0.08, p.y);
        const sHead = smoothstep(j.neck.y - 0.035, j.neck.y + 0.045, p.y);

        const t = clamp((p.y - yAnkle) / (yCrotch - yAnkle), 0, 1);
        const sLeft = smoothstep(-0.02, 0.02, p.x - (this.splitX[0] + (this.splitX[1] - this.splitX[0]) * t));

        const leg = 1 - sUpper;
        const thigh = leg * sKnee;
        const shin = leg * (1 - sKnee) * sAnkle;

        w[FOOT] = leg * (1 - sKnee) * (1 - sAnkle);
        w[PELVIS] = sUpper * (1 - sSpine);
        w[SPINE] = sUpper * sSpine * (1 - sChest);
        w[CHEST] = sUpper * sChest * (1 - sHead);
        w[HEAD] = sUpper * sHead;
        w[THIGH_L] = thigh * sLeft;
        w[SHIN_L] = shin * sLeft;
        w[THIGH_R] = thigh * (1 - sLeft);
        w[SHIN_R] = shin * (1 - sLeft);
        return w;
    }

    /**
     * Where the current pose carries a rest-pose point. Mirrors rigSkin in rig-shader.js, so
     * anything pinned to the figure moves exactly as the gaussians around it do.
     *
     * @param {Vec3} p - Rest position in rig space.
     * @param {Vec3} out - Receives the posed position (may be p itself).
     * @returns {Vec3} out.
     */
    skin(p, out) {
        const w = this.weights(p, tmpW);
        let x = 0, y = 0, z = 0;
        for (let i = 0; i < BONE_COUNT; i++) {
            if (w[i] === 0) continue;
            this.bones[i].apply(p, tmpS);
            x += w[i] * tmpS.x;
            y += w[i] * tmpS.y;
            z += w[i] * tmpS.z;
        }
        const b = this.breath * (w[CHEST] + 0.5 * w[SPINE]);
        x += (p.x - this.j.chest.x) * b;
        z += (p.z - this.j.chest.z) * b;
        y += b * 0.25;
        return out.set(x, y, z);
    }

    /** Push the rig state to a gsplat material. */
    apply(material, entity, debug, enabled) {
        const j = this.j;
        const world = entity.getWorldTransform();
        this.rigInv.copy(world).invert();
        const r = entity.getRotation();

        material.setParameter('uRig', world.data);
        material.setParameter('uRigInv', this.rigInv.data);
        material.setParameter('uRigRot', [r.x, r.y, r.z, r.w]);
        material.setParameter('uBoneQ[0]', this.boneQ);
        material.setParameter('uBoneT[0]', this.boneT);
        material.setParameter('uRigA', [(j.ankleL.y + j.ankleR.y) * 0.5, (j.kneeL.y + j.kneeR.y) * 0.5, this.crotchY, j.spine.y]);
        material.setParameter('uRigB', [j.chest.y, j.neck.y, this.splitX[0], this.splitX[1]]);
        material.setParameter('uRigC', [this.breath, debug ? 1 : 0, j.chest.x, j.chest.z]);
        material.setParameter('uRigOn', enabled ? 1 : 0);
    }
}
