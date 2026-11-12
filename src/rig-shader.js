// Skinning for gaussian splats, applied through the engine's gsplatModifyVS hooks.
//
// There is no mesh, so there are no authored skin weights. Weights are a pure function of each
// gaussian's rest position: a vertical chain (pelvis > spine > chest > head) blended by height,
// and two legs (thigh > shin > foot) separated by a plane between them. Arms get whatever the
// torso gets at the same height, so they shear with the body and never separate from it.
//
// Bones: 0 foot (static), 1 pelvis, 2 spine, 3 chest, 4 head, 5 thighL, 6 shinL, 7 thighR, 8 shinR
// Each bone is a rigid transform in rig space: p' = rotate(q, p) + t.

export const BONE_COUNT = 9;

export const rigGLSL = /* glsl */`
uniform mat4 uRigInv;      // world -> rig space
uniform mat4 uRig;         // rig space -> world
uniform vec4 uRigRot;      // world rotation of the rig (x,y,z,w)
uniform vec4 uBoneQ[9];
uniform vec4 uBoneT[9];
uniform vec4 uRigA;        // y of: ankle, knee, crotch, spine joint
uniform vec4 uRigB;        // y of: chest joint, neck joint; leg split x at ankle, at crotch
uniform vec4 uRigC;        // breath amount, debug view, chest centre x, chest centre z
uniform float uRigOn;

// rest position in rig space, kept from the centre hook for the colour hook (which is handed
// the already-skinned centre)
vec3 gRigRest;

vec3 rigRotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

vec4 rigQuatMul(vec4 a, vec4 b) {
    return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

bool rigInside(vec3 p) {
    return uRigOn > 0.5 && abs(p.x) < 0.7 && abs(p.z) < 0.7 && p.y > -0.1 && p.y < 2.3;
}

// weights for the 9 bones at rest position p
void rigWeights(vec3 p, out float w[9]) {
    float yAnkle = uRigA.x, yKnee = uRigA.y, yCrotch = uRigA.z, ySpine = uRigA.w;
    float yChest = uRigB.x, yNeck = uRigB.y;

    float sAnkle = smoothstep(yAnkle - 0.04, yAnkle + 0.06, p.y);
    float sKnee  = smoothstep(yKnee - 0.09, yKnee + 0.09, p.y);
    float sUpper = smoothstep(yCrotch - 0.07, yCrotch + 0.09, p.y);
    float sSpine = smoothstep(ySpine - 0.08, ySpine + 0.08, p.y);
    float sChest = smoothstep(yChest - 0.08, yChest + 0.08, p.y);
    float sHead  = smoothstep(yNeck - 0.035, yNeck + 0.045, p.y);

    float t = clamp((p.y - yAnkle) / (yCrotch - yAnkle), 0.0, 1.0);
    float sLeft = smoothstep(-0.02, 0.02, p.x - mix(uRigB.z, uRigB.w, t));

    float leg = 1.0 - sUpper;
    float thigh = leg * sKnee;
    float shin = leg * (1.0 - sKnee) * sAnkle;

    w[0] = leg * (1.0 - sKnee) * (1.0 - sAnkle);
    w[1] = sUpper * (1.0 - sSpine);
    w[2] = sUpper * sSpine * (1.0 - sChest);
    w[3] = sUpper * sChest * (1.0 - sHead);
    w[4] = sUpper * sHead;
    w[5] = thigh * sLeft;
    w[6] = shin * sLeft;
    w[7] = thigh * (1.0 - sLeft);
    w[8] = shin * (1.0 - sLeft);
}

void rigSkin(vec3 p, out vec3 pos, out vec4 q) {
    float w[9];
    rigWeights(p, w);
    pos = vec3(0.0);
    q = vec4(0.0);
    for (int i = 0; i < 9; i++) {
        vec4 bq = uBoneQ[i];
        pos += w[i] * (rigRotate(bq, p) + uBoneT[i].xyz);
        q += w[i] * bq;
    }
    q = normalize(q);

    // breathing: the rib cage widens and lifts a touch
    float b = uRigC.x * (w[3] + 0.5 * w[2]);
    pos.xz += (p.xz - uRigC.zw) * b;
    pos.y += b * 0.25;
}

void modifySplatCenter(inout vec3 center) {
    vec3 p = (uRigInv * vec4(center, 1.0)).xyz;
    gRigRest = p;
    if (!rigInside(p)) return;
    vec3 pos;
    vec4 q;
    rigSkin(p, pos, q);
    center = (uRig * vec4(pos, 1.0)).xyz;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    vec3 p = (uRigInv * vec4(originalCenter, 1.0)).xyz;
    if (!rigInside(p)) return;
    vec3 pos;
    vec4 q;
    rigSkin(p, pos, q);
    // bring the bone rotation from rig space into world space, then apply it to the gaussian
    vec4 conj = vec4(-uRigRot.xyz, uRigRot.w);
    vec4 qw = rigQuatMul(rigQuatMul(uRigRot, q), conj);
    rotation = normalize(rigQuatMul(qw, rotation));
    if (rotation.w < 0.0) rotation = -rotation;
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 p = gRigRest;
    if (!rigInside(p)) return;
    float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));

    // debug view: tint by bone weight
    if (uRigC.y > 0.5) {
        float w[9];
        rigWeights(p, w);
        vec3 c = w[0] * vec3(0.35) +
                 w[1] * vec3(1.0, 0.25, 0.2) +
                 w[2] * vec3(1.0, 0.7, 0.1) +
                 w[3] * vec3(0.3, 0.9, 0.3) +
                 w[4] * vec3(0.2, 0.8, 1.0) +
                 w[5] * vec3(0.3, 0.4, 1.0) +
                 w[6] * vec3(0.7, 0.3, 1.0) +
                 w[7] * vec3(1.0, 0.3, 0.8) +
                 w[8] * vec3(1.0, 0.9, 0.3);
        color.rgb = mix(color.rgb, c * (0.35 + luma), 0.75);
    }
}
`;

export const rigWGSL = /* wgsl */`
uniform uRigInv: mat4x4f;
uniform uRig: mat4x4f;
uniform uRigRot: vec4f;
uniform uBoneQ: array<vec4f, 9>;
uniform uBoneT: array<vec4f, 9>;
uniform uRigA: vec4f;
uniform uRigB: vec4f;
uniform uRigC: vec4f;
uniform uRigOn: f32;

var<private> gRigRest: vec3f;

fn rigRotate(q: vec4f, v: vec3f) -> vec3f {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

fn rigQuatMul(a: vec4f, b: vec4f) -> vec4f {
    return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

fn rigInside(p: vec3f) -> bool {
    return uniform.uRigOn > 0.5 && abs(p.x) < 0.7 && abs(p.z) < 0.7 && p.y > -0.1 && p.y < 2.3;
}

fn rigWeights(p: vec3f) -> array<f32, 9> {
    let yAnkle = uniform.uRigA.x;
    let yKnee = uniform.uRigA.y;
    let yCrotch = uniform.uRigA.z;
    let ySpine = uniform.uRigA.w;
    let yChest = uniform.uRigB.x;
    let yNeck = uniform.uRigB.y;

    let sAnkle = smoothstep(yAnkle - 0.04, yAnkle + 0.06, p.y);
    let sKnee  = smoothstep(yKnee - 0.09, yKnee + 0.09, p.y);
    let sUpper = smoothstep(yCrotch - 0.07, yCrotch + 0.09, p.y);
    let sSpine = smoothstep(ySpine - 0.08, ySpine + 0.08, p.y);
    let sChest = smoothstep(yChest - 0.08, yChest + 0.08, p.y);
    let sHead  = smoothstep(yNeck - 0.035, yNeck + 0.045, p.y);

    let t = clamp((p.y - yAnkle) / (yCrotch - yAnkle), 0.0, 1.0);
    let sLeft = smoothstep(-0.02, 0.02, p.x - mix(uniform.uRigB.z, uniform.uRigB.w, t));

    let leg = 1.0 - sUpper;
    let thigh = leg * sKnee;
    let shin = leg * (1.0 - sKnee) * sAnkle;

    var w: array<f32, 9>;
    w[0] = leg * (1.0 - sKnee) * (1.0 - sAnkle);
    w[1] = sUpper * (1.0 - sSpine);
    w[2] = sUpper * sSpine * (1.0 - sChest);
    w[3] = sUpper * sChest * (1.0 - sHead);
    w[4] = sUpper * sHead;
    w[5] = thigh * sLeft;
    w[6] = shin * sLeft;
    w[7] = thigh * (1.0 - sLeft);
    w[8] = shin * (1.0 - sLeft);
    return w;
}

struct RigSkin {
    pos: vec3f,
    q: vec4f
}

fn rigSkin(p: vec3f) -> RigSkin {
    let w = rigWeights(p);
    var pos = vec3f(0.0);
    var q = vec4f(0.0);
    for (var i = 0; i < 9; i++) {
        let bq = uniform.uBoneQ[i];
        pos += w[i] * (rigRotate(bq, p) + uniform.uBoneT[i].xyz);
        q += w[i] * bq;
    }
    let b = uniform.uRigC.x * (w[3] + 0.5 * w[2]);
    let xz = pos.xz + (p.xz - uniform.uRigC.zw) * b;
    var out: RigSkin;
    out.pos = vec3f(xz.x, pos.y + b * 0.25, xz.y);
    out.q = normalize(q);
    return out;
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let p = (uniform.uRigInv * vec4f(*center, 1.0)).xyz;
    gRigRest = p;
    if (!rigInside(p)) { return; }
    let s = rigSkin(p);
    *center = (uniform.uRig * vec4f(s.pos, 1.0)).xyz;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let p = (uniform.uRigInv * vec4f(originalCenter, 1.0)).xyz;
    if (!rigInside(p)) { return; }
    let s = rigSkin(p);
    let conj = vec4f(-uniform.uRigRot.xyz, uniform.uRigRot.w);
    let qw = rigQuatMul(rigQuatMul(uniform.uRigRot, s.q), conj);
    var r = normalize(rigQuatMul(qw, *rotation));
    if (r.w < 0.0) { r = -r; }
    *rotation = r;
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let p = gRigRest;
    if (!rigInside(p)) { return; }
    var rgb = (*color).rgb;
    let luma = dot(rgb, vec3f(0.299, 0.587, 0.114));

    if (uniform.uRigC.y > 0.5) {
        let w = rigWeights(p);
        let c = w[0] * vec3f(0.35) +
                w[1] * vec3f(1.0, 0.25, 0.2) +
                w[2] * vec3f(1.0, 0.7, 0.1) +
                w[3] * vec3f(0.3, 0.9, 0.3) +
                w[4] * vec3f(0.2, 0.8, 1.0) +
                w[5] * vec3f(0.3, 0.4, 1.0) +
                w[6] * vec3f(0.7, 0.3, 1.0) +
                w[7] * vec3f(1.0, 0.3, 0.8) +
                w[8] * vec3f(1.0, 0.9, 0.3);
        rgb = mix(rgb, c * (0.35 + luma), 0.75);
    }

    *color = vec4f(rgb, (*color).a);
}
`;
