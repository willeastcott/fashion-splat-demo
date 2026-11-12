import {
    CameraFrame,
    Color,
    Entity,
    SEMANTIC_POSITION,
    ShaderMaterial,
    TONEMAP_LINEAR,
    Vec3
} from 'playcanvas';

// The studio the figure stands in: a floor with a pool of light that fades into the backdrop
// (so the floor has no visible edge), contact shadows under the shoes and the body, light on
// the floor from the glowing wave of a morph, and bloom and a vignette over the frame.
//
// The shadows are not cast by the splats. They are soft shapes drawn into the floor at the
// rig's ankle joints, which is cheap and holds up because the feet never leave the floor.

const vertexGLSL = /* glsl */`
attribute vec4 vertex_position;

uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;

varying vec3 vWorld;

void main(void) {
    vec4 world = matrix_model * vertex_position;
    vWorld = world.xyz;
    gl_Position = matrix_viewProjection * world;
}
`;

const fragmentGLSL = /* glsl */`
#include "gammaPS"

uniform vec3 uBackdrop;     // colour the floor fades to; the camera clears to the same (sRGB)
uniform vec3 uPool;         // colour of the floor in the pool of light (sRGB)
uniform vec4 uPoolShape;    // centre x, z; radius where it starts to fall off, radius where it is gone
uniform vec4 uFeet;         // left shoe x, z; right shoe x, z
uniform vec4 uBody;         // body x, z; the way the figure faces x, z
uniform vec4 uRingLight;    // radius of the morph wave's light, its height above the floor (m), its strength 0..1
uniform vec3 uGlow;         // colour of that light

varying vec3 vWorld;

float floorHash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// soft shadow of one shoe: longer along the way the figure faces than across it
float floorShoe(vec2 d, vec2 fwd, vec2 side) {
    float a = dot(d, fwd) / 0.15;
    float b = dot(d, side) / 0.075;
    return exp(-(a * a + b * b));
}

void main(void) {
    vec2 p = vWorld.xz;

    float d = length(p - uPoolShape.xy);
    float lit = 1.0 - smoothstep(uPoolShape.z, uPoolShape.w, d);
    vec3 col = mix(uBackdrop, uPool, lit * lit);

    vec2 fwd = uBody.zw;
    vec2 side = vec2(fwd.y, -fwd.x);
    float shoes = max(floorShoe(p - uFeet.xy, fwd, side), floorShoe(p - uFeet.zw, fwd, side));
    vec2 c = p - uBody.xy;
    float body = exp(-dot(c, c) / 0.17);
    col *= (1.0 - 0.72 * shoes) * (1.0 - 0.36 * body);

    // light from the morph's wave: a wide faint band while it is high, a tight bright one as it lands
    float h = uRingLight.y;
    float e = (length(c) - uRingLight.x) / (0.09 + 0.55 * h);
    col += uGlow * uRingLight.z * 0.6 * exp(-e * e) / (1.0 + h * h * 11.0);

    // a little grain, so the slow gradient does not show as bands
    col += (floorHash(p * 913.7) - 0.5) * (1.5 / 255.0);

    gl_FragColor = vec4(gammaCorrectOutput(decodeGamma(max(col, vec3(0.0)))), 1.0);
}
`;

const vertexWGSL = /* wgsl */`
attribute vertex_position: vec4f;

uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;

varying vWorld: vec3f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let world = uniform.matrix_model * input.vertex_position;
    output.vWorld = world.xyz;
    output.position = uniform.matrix_viewProjection * world;
    return output;
}
`;

const fragmentWGSL = /* wgsl */`
#include "gammaPS"

uniform uBackdrop: vec3f;
uniform uPool: vec3f;
uniform uPoolShape: vec4f;
uniform uFeet: vec4f;
uniform uBody: vec4f;
uniform uRingLight: vec4f;
uniform uGlow: vec3f;

varying vWorld: vec3f;

fn floorHash(p: vec2f) -> f32 {
    return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

fn floorShoe(d: vec2f, fwd: vec2f, side: vec2f) -> f32 {
    let a = dot(d, fwd) / 0.15;
    let b = dot(d, side) / 0.075;
    return exp(-(a * a + b * b));
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let p = input.vWorld.xz;

    let d = length(p - uniform.uPoolShape.xy);
    let lit = 1.0 - smoothstep(uniform.uPoolShape.z, uniform.uPoolShape.w, d);
    var col = mix(uniform.uBackdrop, uniform.uPool, lit * lit);

    let fwd = uniform.uBody.zw;
    let side = vec2f(fwd.y, -fwd.x);
    let shoes = max(floorShoe(p - uniform.uFeet.xy, fwd, side), floorShoe(p - uniform.uFeet.zw, fwd, side));
    let c = p - uniform.uBody.xy;
    let body = exp(-dot(c, c) / 0.17);
    col *= (1.0 - 0.72 * shoes) * (1.0 - 0.36 * body);

    let h = uniform.uRingLight.y;
    let e = (length(c) - uniform.uRingLight.x) / (0.09 + 0.55 * h);
    col += uniform.uGlow * uniform.uRingLight.z * 0.6 * exp(-e * e) / (1.0 + h * h * 11.0);

    col += vec3f((floorHash(p * 913.7) - 0.5) * (1.5 / 255.0));

    output.color = vec4f(gammaCorrectOutput(decodeGamma3(max(col, vec3f(0.0)))), 1.0);
    return output;
}
`;

// exact inverse of the sRGB curve the engine writes its output with
const toLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const p = new Vec3();
const q = new Vec3();

export class Stage {
    /** Colour of the backdrop and of the floor away from the figure, sRGB. */
    backdrop = [0.075, 0.078, 0.086];

    /** Colour of the floor in the pool of light, sRGB. */
    pool = [0.2, 0.205, 0.22];

    /** Radius where the pool of light starts to fall off, and where it is gone, metres. */
    poolRadius = [0.3, 4.2];

    /**
     * @param {import('playcanvas').AppBase} app - The app.
     * @param {Entity} camera - Camera entity.
     */
    constructor(app, camera) {
        this.camera = camera;

        const material = new ShaderMaterial({
            uniqueName: 'StudioFloor',
            vertexGLSL,
            fragmentGLSL,
            vertexWGSL,
            fragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        material.update();
        this.material = material;

        // a touch below the soles, so the floor does not cut into the shoes
        const floor = new Entity('floor');
        floor.addComponent('render', { type: 'plane', material, castShadows: false, receiveShadows: false });
        floor.setLocalScale(24, 1, 24);
        floor.setLocalPosition(0, -0.004, 0);
        app.root.addChild(floor);
        this.floor = floor;

        // Bloom and the vignette render the scene to a linear-light target first. On WebGPU
        // the splats come through that unchanged. On WebGL2 they do not: dark, faintly
        // layered cloth comes out washed and grainy (seen in iOS Safari and in Chrome's
        // WebGL2 alike). So on WebGL2 the scene is drawn straight to the screen, and the page
        // lays a plain vignette over the canvas instead (see #vignette in index.html).
        this.capable = app.graphicsDevice.isWebGPU;

        // bloom picks out what is brighter than white, which is the dots and waves of a morph
        const frame = new CameraFrame(app, camera.camera);
        frame.rendering.samples = 1;
        frame.rendering.toneMapping = TONEMAP_LINEAR;
        frame.bloom.intensity = 0.05;
        frame.bloom.threshold = 1.0;
        frame.vignette.intensity = 0.45;
        frame.vignette.inner = 0.55;
        frame.vignette.outer = 1.45;
        frame.vignette.curvature = 0.7;
        frame.enabled = this.capable;
        frame.update();
        this.frame = frame;
        this._applyBackdrop();
    }

    /** Whether bloom and the vignette are on. They can only be on where `capable` is true. */
    get effects() {
        return this.frame.enabled;
    }

    set effects(on) {
        on = on && this.capable;
        if (on === this.frame.enabled) return;
        this.frame.enabled = on;
        this.frame.update();
        this._applyBackdrop();
    }

    // With the effects on, the scene is rendered in linear light and the clear colour is taken
    // as it is; without them it is rendered for the display directly.
    _applyBackdrop() {
        const [r, g, b] = this.backdrop;
        const c = this.frame.enabled ? new Color(toLinear(r), toLinear(g), toLinear(b)) : new Color(r, g, b);
        this.camera.camera.clearColor = c;
    }

    /**
     * @param {object} o - Scene state.
     * @param {Entity} o.figure - Entity the figure is rendered on.
     * @param {import('./rig.js').Rig} o.rig - Rig, already updated for this frame.
     * @param {import('./morph.js').Morph} o.morph - Morph, already updated for this frame.
     */
    update({ figure, rig, morph }) {
        const m = this.material;
        const M = figure.getWorldTransform();
        const j = rig.j;

        // shoes reach forward of the ankle
        M.transformPoint(p.set(j.ankleL.x, 0, j.ankleL.z + 0.05), p);
        M.transformPoint(q.set(j.ankleR.x, 0, j.ankleR.z + 0.05), q);
        m.setParameter('uFeet', [p.x, p.z, q.x, q.z]);

        M.transformPoint(p.set(j.pelvis.x, 0, j.pelvis.z), p);
        M.transformVector(q.set(0, 0, 1), q);
        const l = Math.hypot(q.x, q.z) || 1;
        m.setParameter('uBody', [p.x, p.z, q.x / l, q.z / l]);

        m.setParameter('uBackdrop', this.backdrop);
        m.setParameter('uPool', this.pool);
        m.setParameter('uPoolShape', [p.x, p.z, this.poolRadius[0], this.poolRadius[1]]);
        // the wave that re-forms the cloth lights the floor round the feet as it comes down
        m.setParameter('uRingLight', [0.3, Math.max(0, morph.waveHeight), morph.waveAmount, 0]);
        m.setParameter('uGlow', morph.glow);
    }
}
