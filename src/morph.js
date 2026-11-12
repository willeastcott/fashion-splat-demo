import {
    BoundingBox,
    GSplatContainer,
    GSplatFormat,
    PIXELFORMAT_RGBA16F,
    PIXELFORMAT_RGBA32F,
    PIXELFORMAT_RGBA8,
    Texture,
    Vec3,
    WORKBUFFER_UPDATE_ALWAYS,
    WORKBUFFER_UPDATE_ONCE
} from 'playcanvas';

import { PACK_VERSION, decodeOutfit } from './pack.js';

// Every outfit is stored in the same slot order (see tools/build-morph.mjs), so slot i of one
// outfit is the partner of slot i in the others. All outfits live in one splat container and
// the container's read functions blend between two of them, per gaussian.
//
// Streams per outfit n: pos<n> (xyz, float), rot<n> (xyzw, 8 bit), scl<n> (log scale, 8 bit),
// col<n> (rgb + alpha, 8 bit; alpha is 0 for a slot that repeats another gaussian). The data
// arrives packed far smaller than that; see src/pack.js.

const OUTFITS = 3;

const select = (fn, type, glsl) => {
    const body = glsl ?
        `if (i == 0) { return load${fn}0(); } if (i == 1) { return load${fn}1(); } return load${fn}2();` :
        `if (i == 0) { return load${fn}0(); } if (i == 1) { return load${fn}1(); } return load${fn}2();`;
    return glsl ? `${type} morph${fn}(int i) { ${body} }` : `fn morph${fn}(i: i32) -> ${type} { ${body} }`;
};

// The four read functions the engine calls (centre, rotation, scale, colour) all need the same
// working out, so it is done once per gaussian and kept in globals.
//
// A morph is two waves running down the body, one after the other, in the manner of the
// engine's splat reveal effects. Each gaussian has its own clock, "raw": at 0 the first wave
// reaches it and at 1 the second has left it.
//   1. The first wave draws the old outfit's cloth in to small round dots, with a bright edge.
//   2. Between the waves the figure is a cloud of dots, and each dot glides to its partner on
//      the new outfit. The move is hidden in plain sight: dots stay crisp where blended cloth
//      would smear.
//   3. The second wave opens the dots out into the new outfit's cloth, with a swell and a glow.
// The waves cross the body on a slight diagonal rather than straight across.
const readGLSL = /* glsl */`
uniform vec4 uMorph;        // from outfit, to outfit, progress 0..1, stagger
uniform vec4 uMorphFx;      // tilt of the wave along x and z, figure height (m), noise in the wave
uniform vec4 uMorphFx2;     // dot size (m, std dev), swell of the cloth as it re-forms (m), time (s), dot opacity boost
uniform vec4 uMorphDot;     // tint of the dots, strength
uniform vec4 uMorphGlow;    // tint of the second wave, strength
uniform vec4 uMorphScale;   // log-scale range: min, max

${select('Pos', 'vec4', true)}
${select('Rot', 'vec4', true)}
${select('Scl', 'vec4', true)}
${select('Col', 'vec4', true)}

#ifdef MORPH_SH
uniform vec4 uShCam;        // camera position in the figure's frame; strength of the view-dependent colour
uniform vec4 uShFrame[3];   // per outfit: rotation from the capture's axes to the figure's (x,y,z,w)

// The part of a gaussian's colour that changes with the direction it is seen from: bands 1 to
// 3 of the capture's spherical harmonics, read from outfit i's rows of the palette. "at" is
// the gaussian's position and, in w, its palette entry. The sum is the engine's evalSH.
vec3 morphSH(int i, vec4 at) {
    vec3 v = normalize(at.xyz - uShCam.xyz);
    // the coefficients are in the capture's axes: turn the direction back into them
    vec4 q = vec4(-uShFrame[i].xyz, uShFrame[i].w);
    vec3 d = v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);

    int n = int(at.w + 0.5);
    ivec2 uv = ivec2((n % 64) * 15, n / 64 + i * 1024);
    vec3 sh[15];
    for (int k = 0; k < 15; k++) sh[k] = texelFetch(shPal, uv + ivec2(k, 0), 0).rgb;

    float x = d.x, y = d.y, z = d.z;
    float xx = x * x, yy = y * y, zz = z * z, xy = x * y, yz = y * z, xz = x * z;
    vec3 c = 0.4886025119029199 * (-sh[0] * y + sh[1] * z - sh[2] * x) +
        sh[3] * (1.0925484305920792 * xy) +
        sh[4] * (-1.0925484305920792 * yz) +
        sh[5] * (0.31539156525252005 * (2.0 * zz - xx - yy)) +
        sh[6] * (-1.0925484305920792 * xz) +
        sh[7] * (0.5462742152960396 * (xx - yy)) +
        sh[8] * (-0.5900435899266435 * y * (3.0 * xx - yy)) +
        sh[9] * (2.890611442640554 * xy * z) +
        sh[10] * (-0.4570457994644658 * y * (4.0 * zz - xx - yy)) +
        sh[11] * (0.3731763325901154 * z * (2.0 * zz - 3.0 * xx - 3.0 * yy)) +
        sh[12] * (-0.4570457994644658 * x * (4.0 * zz - xx - yy)) +
        sh[13] * (1.445305721320277 * z * (xx - yy)) +
        sh[14] * (-0.5900435899266435 * x * (xx - 3.0 * yy));
    return c * uShCam.w;
}
#endif

bool gMorphReady = false;
vec3 gMorphCenter;
vec4 gMorphRot;             // x,y,z,w
vec3 gMorphScale;
vec4 gMorphColor;

float morphHash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float morphBump(float x, float centre, float width) {
    float e = (x - centre) / width;
    return exp(-e * e);
}

void morphEval() {
    if (gMorphReady) return;
    gMorphReady = true;

    int ia = int(uMorph.x + 0.5);
    vec4 a4 = morphPos(ia);
    vec3 a = a4.xyz;
    float raw = 0.0;
    float h = 0.0;
    if (uMorph.z > 0.0) {
        // this gaussian's clock: the waves run down a tilted axis, loosened with a little noise
        h = morphHash(a);
        float along = (a.y + uMorphFx.x * a.x + uMorphFx.y * a.z) / uMorphFx.z;
        float order = mix(1.0 - clamp(along, 0.0, 1.0), h, uMorphFx.w);
        raw = uMorph.z * (1.0 + uMorph.w) - order * uMorph.w;
    }

    // not reached yet: exactly the old outfit. Left behind: exactly the new one.
    if (raw <= 0.0 || raw >= 1.0) {
        int i = raw >= 1.0 ? int(uMorph.y + 0.5) : ia;
        vec4 p4 = morphPos(i);
        gMorphCenter = p4.xyz;
        gMorphRot = normalize(morphRot(i) * 2.0 - 1.0);
        gMorphScale = exp(mix(vec3(uMorphScale.x), vec3(uMorphScale.y), morphScl(i).xyz));
        gMorphColor = morphCol(i);
#ifdef MORPH_SH
        gMorphColor.rgb = max(gMorphColor.rgb + morphSH(i, p4), vec3(0.0));
#endif
        return;
    }

    int ib = int(uMorph.y + 0.5);
    vec4 b4 = morphPos(ib);
    vec3 b = b4.xyz;
    vec4 qa = morphRot(ia) * 2.0 - 1.0;
    vec4 qb = morphRot(ib) * 2.0 - 1.0;
    vec3 la = mix(vec3(uMorphScale.x), vec3(uMorphScale.y), morphScl(ia).xyz);
    vec3 lb = mix(vec3(uMorphScale.x), vec3(uMorphScale.y), morphScl(ib).xyz);
    vec4 ca = morphCol(ia);
    vec4 cb = morphCol(ib);
#ifdef MORPH_SH
    ca.rgb = max(ca.rgb + morphSH(ia, a4), vec3(0.0));
    cb.rgb = max(cb.rgb + morphSH(ib, b4), vec3(0.0));
#endif
    float h2 = fract(h * 57.31 + 0.137);

    // the stages on the clock
    float glide = smoothstep(0.08, 0.80, raw);                              // how far across to its partner
    float dots = smoothstep(0.0, 0.16, raw) * (1.0 - smoothstep(0.70, 1.0, raw));   // 1 while it is a dot
    float edge = morphBump(raw, 0.09, 0.07);                                // bright edge of the first wave
    float swell = sin(3.14159265 * smoothstep(0.62, 1.0, raw));             // second wave: cloth re-forming
    float shimmer = sin(uMorphFx2.z * 5.0 + h * 6.2831853) * dots;

    // position: across to the partner, standing a little off the body while a dot, and pushed
    // out as the cloth re-forms
    vec3 p = mix(a, b, glide);
    float r0 = length(p.xz);
    float away = uMorphFx2.y * (0.3 * dots + swell) + 0.004 * shimmer;
    if (r0 > 1e-4) p.xz *= 1.0 + away / r0;
    p.y += 0.003 * shimmer;

    // shape: round and small while a dot, and never larger than the gaussian it came from
    if (dot(qa, qb) < 0.0) qb = -qb;
    vec3 ls = mix(la, lb, glide);
    float dotSize = uMorphFx2.x * (0.75 + 0.5 * h2) * (1.0 + 1.2 * edge);
    float lsDot = min(log(dotSize), max(ls.x, max(ls.y, ls.z)));
    ls = mix(ls, vec3(lsDot), dots);

    // colour: the cloth's own, lifted while a dot, with the first wave's edge and the second
    // wave's glow on top
    vec4 c = mix(ca, cb, glide);
    c.rgb = c.rgb * (1.0 + 0.15 * dots) +
            uMorphDot.rgb * uMorphDot.w * (0.1 * dots + edge) +
            uMorphGlow.rgb * uMorphGlow.w * morphBump(raw, 0.84, 0.08);
    c.a = min(1.0, c.a * mix(1.0, uMorphFx2.w, dots));

    gMorphCenter = p;
    gMorphRot = normalize(mix(qa, qb, glide));
    gMorphScale = exp(ls);
    gMorphColor = c;
}

vec3 getCenter() {
    morphEval();
    return gMorphCenter;
}

// returns w,x,y,z
vec4 getRotation() {
    morphEval();
    return gMorphRot.wxyz;
}

vec3 getScale() {
    morphEval();
    return gMorphScale;
}

vec4 getColor() {
    morphEval();
    return gMorphColor;
}
`;

const readWGSL = /* wgsl */`
uniform uMorph: vec4f;
uniform uMorphFx: vec4f;
uniform uMorphFx2: vec4f;
uniform uMorphDot: vec4f;
uniform uMorphGlow: vec4f;
uniform uMorphScale: vec4f;

${select('Pos', 'vec4f', false)}
${select('Rot', 'vec4f', false)}
${select('Scl', 'vec4f', false)}
${select('Col', 'vec4f', false)}

#ifdef MORPH_SH
uniform uShCam: vec4f;
uniform uShFrame: array<vec4f, 3>;

fn morphSH(i: i32, at: vec4f) -> vec3f {
    let v = normalize(at.xyz - uniform.uShCam.xyz);
    let f = uniform.uShFrame[i];
    let q = vec4f(-f.xyz, f.w);
    let d = v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);

    let n = i32(at.w + 0.5);
    let uv = vec2i((n % 64) * 15, n / 64 + i * 1024);
    var sh: array<vec3f, 15>;
    for (var k = 0; k < 15; k++) {
        sh[k] = textureLoad(shPal, uv + vec2i(k, 0), 0).rgb;
    }

    let x = d.x;
    let y = d.y;
    let z = d.z;
    let xx = x * x;
    let yy = y * y;
    let zz = z * z;
    let xy = x * y;
    let yz = y * z;
    let xz = x * z;
    let c = 0.4886025119029199 * (-sh[0] * y + sh[1] * z - sh[2] * x) +
        sh[3] * (1.0925484305920792 * xy) +
        sh[4] * (-1.0925484305920792 * yz) +
        sh[5] * (0.31539156525252005 * (2.0 * zz - xx - yy)) +
        sh[6] * (-1.0925484305920792 * xz) +
        sh[7] * (0.5462742152960396 * (xx - yy)) +
        sh[8] * (-0.5900435899266435 * y * (3.0 * xx - yy)) +
        sh[9] * (2.890611442640554 * xy * z) +
        sh[10] * (-0.4570457994644658 * y * (4.0 * zz - xx - yy)) +
        sh[11] * (0.3731763325901154 * z * (2.0 * zz - 3.0 * xx - 3.0 * yy)) +
        sh[12] * (-0.4570457994644658 * x * (4.0 * zz - xx - yy)) +
        sh[13] * (1.445305721320277 * z * (xx - yy)) +
        sh[14] * (-0.5900435899266435 * x * (xx - 3.0 * yy));
    return c * uniform.uShCam.w;
}
#endif

var<private> gMorphReady: bool = false;
var<private> gMorphCenter: vec3f;
var<private> gMorphRot: vec4f;
var<private> gMorphScale: vec3f;
var<private> gMorphColor: vec4f;

fn morphHash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

fn morphBump(x: f32, centre: f32, width: f32) -> f32 {
    let e = (x - centre) / width;
    return exp(-e * e);
}

fn morphEval() {
    if (gMorphReady) { return; }
    gMorphReady = true;

    let lo = vec3f(uniform.uMorphScale.x);
    let hi = vec3f(uniform.uMorphScale.y);
    let ia = i32(uniform.uMorph.x + 0.5);
    let ib = i32(uniform.uMorph.y + 0.5);
    let a4 = morphPos(ia);
    let a = a4.xyz;
    var raw = 0.0;
    var h = 0.0;
    if (uniform.uMorph.z > 0.0) {
        h = morphHash(a);
        let along = (a.y + uniform.uMorphFx.x * a.x + uniform.uMorphFx.y * a.z) / uniform.uMorphFx.z;
        let order = mix(1.0 - clamp(along, 0.0, 1.0), h, uniform.uMorphFx.w);
        raw = uniform.uMorph.z * (1.0 + uniform.uMorph.w) - order * uniform.uMorph.w;
    }

    if (raw <= 0.0 || raw >= 1.0) {
        var i = ia;
        if (raw >= 1.0) { i = ib; }
        let p4 = morphPos(i);
        gMorphCenter = p4.xyz;
        gMorphRot = normalize(morphRot(i) * 2.0 - 1.0);
        gMorphScale = exp(mix(lo, hi, morphScl(i).xyz));
        gMorphColor = morphCol(i);
#ifdef MORPH_SH
        gMorphColor = vec4f(max(gMorphColor.rgb + morphSH(i, p4), vec3f(0.0)), gMorphColor.a);
#endif
        return;
    }

    let b4 = morphPos(ib);
    let b = b4.xyz;
    let qa = morphRot(ia) * 2.0 - 1.0;
    var qb = morphRot(ib) * 2.0 - 1.0;
    let la = mix(lo, hi, morphScl(ia).xyz);
    let lb = mix(lo, hi, morphScl(ib).xyz);
    var ca = morphCol(ia);
    var cb = morphCol(ib);
#ifdef MORPH_SH
    ca = vec4f(max(ca.rgb + morphSH(ia, a4), vec3f(0.0)), ca.a);
    cb = vec4f(max(cb.rgb + morphSH(ib, b4), vec3f(0.0)), cb.a);
#endif
    let h2 = fract(h * 57.31 + 0.137);

    let glide = smoothstep(0.08, 0.80, raw);
    let dots = smoothstep(0.0, 0.16, raw) * (1.0 - smoothstep(0.70, 1.0, raw));
    let edge = morphBump(raw, 0.09, 0.07);
    let swell = sin(3.14159265 * smoothstep(0.62, 1.0, raw));
    let shimmer = sin(uniform.uMorphFx2.z * 5.0 + h * 6.2831853) * dots;

    var p = mix(a, b, glide);
    let r0 = length(p.xz);
    let away = uniform.uMorphFx2.y * (0.3 * dots + swell) + 0.004 * shimmer;
    if (r0 > 1e-4) {
        let xz = p.xz * (1.0 + away / r0);
        p = vec3f(xz.x, p.y, xz.y);
    }
    p.y += 0.003 * shimmer;

    if (dot(qa, qb) < 0.0) { qb = -qb; }
    var ls = mix(la, lb, glide);
    let dotSize = uniform.uMorphFx2.x * (0.75 + 0.5 * h2) * (1.0 + 1.2 * edge);
    let lsDot = min(log(dotSize), max(ls.x, max(ls.y, ls.z)));
    ls = mix(ls, vec3f(lsDot), dots);

    let c = mix(ca, cb, glide);
    let rgb = c.rgb * (1.0 + 0.15 * dots) +
              uniform.uMorphDot.rgb * uniform.uMorphDot.w * (0.1 * dots + edge) +
              uniform.uMorphGlow.rgb * uniform.uMorphGlow.w * morphBump(raw, 0.84, 0.08);

    gMorphCenter = p;
    gMorphRot = normalize(mix(qa, qb, glide));
    gMorphScale = exp(ls);
    gMorphColor = vec4f(rgb, min(1.0, c.a * mix(1.0, uniform.uMorphFx2.w, dots)));
}

fn getCenter() -> vec3f {
    morphEval();
    return gMorphCenter;
}

fn getRotation() -> vec4f {
    morphEval();
    return gMorphRot.wxyz;
}

fn getScale() -> vec3f {
    morphEval();
    return gMorphScale;
}

fn getColor() -> vec4f {
    morphEval();
    return gMorphColor;
}
`;

// keep or drop the "#ifdef MORPH_SH ... #endif" parts of the read code (they do not nest)
const resolveSH = (code, on) => code.replace(/^#ifdef MORPH_SH\r?\n([\s\S]*?)^#endif\r?\n/gm, on ? '$1' : '');

// The palette of spherical harmonics: one texture for all outfits, PALETTE_ROWS rows each, 64
// entries to a row and 15 texels (coefficients) to an entry
const SH_COEFFS = 15;
const PALETTE_WIDTH = 64 * SH_COEFFS;
const PALETTE_ROWS = 1024;

const halfScratch = new Float32Array(1);
const halfBits = new Uint32Array(halfScratch.buffer);
// a float as the 16 bits of a half float (finite values in the half range; rounds to nearest)
const toHalf = (value) => {
    halfScratch[0] = value;
    const x = halfBits[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = ((x >>> 23) & 0xff) - 112;
    let mant = x & 0x7fffff;
    if (exp <= 0) {
        if (exp < -10) return sign;
        mant |= 0x800000;
        const shift = 14 - exp;
        return sign | ((mant + (1 << (shift - 1))) >>> shift);
    }
    if (exp >= 31) return sign | 0x7bff;
    return (sign | (exp << 10) | (mant >>> 13)) + ((mant >>> 12) & 1);
};

// How much room an outfit takes up within each of some bands of height, for the camera to
// frame a piece by (see src/closeup.js). Stray gaussians are left out: each side of a box is
// where half a percent of the band's gaussians lie beyond it.
const measureBands = (pos, col, bands) => {
    const BINS = 512, FROM = -1, SPAN = 3.5;       // 7 mm steps over -1 m to 2.5 m
    const hist = bands.map(b => (b ? [new Uint32Array(BINS), new Uint32Array(BINS), new Uint32Array(BINS)] : null));
    const count = new Uint32Array(bands.length);
    for (let k = 0, N = pos.length / 3; k < N; k++) {
        if (col[k * 4 + 3] < 51) continue;          // too faint to matter, or a hidden repeat
        const y = pos[k * 3 + 1];
        for (let j = 0; j < bands.length; j++) {
            const b = bands[j];
            if (!b || y < b[0] || y > b[1]) continue;
            count[j]++;
            for (let a = 0; a < 3; a++) {
                hist[j][a][Math.min(BINS - 1, Math.max(0, Math.floor((pos[k * 3 + a] - FROM) / SPAN * BINS)))]++;
            }
        }
    }
    return bands.map((b, j) => {
        if (!b || count[j] === 0) return null;
        const beyond = count[j] * 0.005;
        const min = [0, 0, 0], max = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
            const h = hist[j][a];
            let lo = 0, hi = BINS - 1;
            for (let n = h[lo]; n <= beyond; n += h[lo]) lo++;
            for (let n = h[hi]; n <= beyond; n += h[hi]) hi--;
            min[a] = FROM + lo / BINS * SPAN;
            max[a] = FROM + (hi + 1) / BINS * SPAN;
        }
        return { min, max };
    });
};

const smooth = t => t * t * (3 - 2 * t);

// height the wave of a morph is measured against, metres (a little above the tallest figure)
const HEIGHT = 1.95;

export class Morph {
    /** Index of the outfit shown, or being left. */
    from = 0;

    /** Index of the outfit being morphed to. */
    to = 0;

    /** Raw progress of the current morph, 0..1. 0 when at rest. */
    progress = 0;

    /** Seconds a morph takes. */
    duration = 3.6;

    /**
     * How much the start of each gaussian's change is staggered down the body. Higher values
     * give a narrower band of dots between the two waves, and a quicker change for each one.
     */
    stagger = 3;

    /** How ragged the waves are, 0..1. */
    noise = 0.05;

    /** How far the waves lean: metres of height per metre across the body (x) and front to back (z). */
    tilt = [0.42, 0.18];

    /** Size of a dot, metres (standard deviation). */
    dot = 0.001;

    /** How much more opaque a gaussian is as a dot than as cloth. */
    dotOpacity = 1.2;

    /** Tint added to the dots, and how strongly. */
    dotTint = [1.0, 0.93, 0.82];

    dotGlow = 0.5;

    /** How far the cloth swells off the body as the second wave re-forms it, metres. */
    swell = 0.035;

    /** Colour of the second wave's glow, and of its light on the floor. */
    glow = [1.0, 0.76, 0.42];

    /** Strength of the second wave's glow. */
    heat = 0.55;

    _viewColour = 1;

    /**
     * Fetch the pack's description and its first outfit, and build the container. The other
     * outfits are fetched afterwards with loadOutfit, so the first can be on screen sooner.
     *
     * @param {import('playcanvas').GraphicsDevice} device - Graphics device.
     * @param {string} baseUrl - Folder holding meta.json and the .pack files.
     * @param {string[]} names - Figure names, in outfit order.
     * @param {(fraction: number) => void} onProgress - Called as the first outfit downloads.
     * @param {(number[]|null)[][]} [bands] - For each outfit, bands of height (bottom, top) to
     * measure it within as it loads; the boxes found are in morph.extents, in the same order.
     * @returns {Promise<Morph>} The morph.
     */
    static async load(device, baseUrl, names, onProgress, bands) {
        if (names.length !== OUTFITS) throw new Error(`expected ${OUTFITS} outfits`);
        const res = await fetch(`${baseUrl}/meta.json`);
        // a dev server answers a missing file with the app's own HTML, so check the type too
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) {
            throw new Error(`no morph pack at ${baseUrl}`);
        }
        const meta = await res.json();
        if (meta.version !== PACK_VERSION) {
            throw new Error(`the pack at ${baseUrl} is in an old format; rebuild it with npm run data`);
        }
        const N = meta.count;

        // A pack with view-dependent colour brings a palette of spherical harmonics, and each
        // gaussian's entry in it rides in the spare fourth component of its position. Its base
        // colours are held as half floats, because they are not clipped to 0..1 (see pack.js).
        const sh = !!meta.sh;
        const streams = [];
        for (let i = 0; i < OUTFITS; i++) {
            streams.push(
                { name: `pos${i}`, format: PIXELFORMAT_RGBA32F },
                { name: `rot${i}`, format: PIXELFORMAT_RGBA8 },
                { name: `scl${i}`, format: PIXELFORMAT_RGBA8 },
                { name: `col${i}`, format: sh ? PIXELFORMAT_RGBA16F : PIXELFORMAT_RGBA8 }
            );
        }
        if (sh) streams.push({ name: 'shPal', format: PIXELFORMAT_RGBA16F });
        const format = new GSplatFormat(device, streams, {
            readGLSL: resolveSH(readGLSL, sh),
            readWGSL: resolveSH(readWGSL, sh)
        });
        const container = new GSplatContainer(device, N, format);

        const morph = new Morph();
        morph.sh = sh;
        if (sh) {
            // the container sizes every stream for one texel per gaussian; the palette has its
            // own size, so swap in a texture of that size before anything is uploaded
            container.streams.textures.get('shPal').destroy();
            morph.palette = Texture.createDataTexture2D(device, 'shPal', PALETTE_WIDTH, PALETTE_ROWS * OUTFITS, PIXELFORMAT_RGBA16F);
            container.streams.textures.set('shPal', morph.palette);
            // tells the engine to work the colours out again as the camera moves round
            container.gsplatData.shBands = 3;
        }
        morph.device = device;
        morph.baseUrl = baseUrl;
        morph.names = names;
        morph.container = container;
        morph.meta = meta;
        morph.count = N;
        morph.centers = names.map(() => null);
        morph.ready = names.map(() => false);
        morph.bands = bands ?? names.map(() => []);
        morph.extents = names.map(() => null);

        await morph.loadOutfit(0, onProgress);

        container.aabb = new BoundingBox(new Vec3(0, 1.07, 0), new Vec3(0.8, 1.15, 0.8));
        if (morph.centers[0]) container.centers = morph.centers[0];
        container.update(N, true);
        return morph;
    }

    /**
     * Fetch one outfit and put it in the container. It can be morphed to once this resolves.
     *
     * @param {number} i - Outfit index.
     * @param {(fraction: number) => void} [onProgress] - Called as it downloads, 0..1.
     */
    async loadOutfit(i, onProgress) {
        if (this.ready[i]) return;
        const fig = this.meta.figures[this.names[i]];
        const gunzip = async r => new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        // the palette is small next to the pack: fetch it alongside
        const paletteBytes = this.sh ? fetch(`${this.baseUrl}/${fig.sh.file}`).then((r) => {
            if (!r.ok) throw new Error(`could not fetch ${fig.sh.file}`);
            return gunzip(r);
        }) : null;
        paletteBytes?.catch(() => {});
        const res = await fetch(`${this.baseUrl}/${fig.file}`);
        if (!res.ok) throw new Error(`could not fetch ${fig.file}`);

        // count the bytes as they arrive, then unzip
        const total = Number(res.headers.get('content-length')) || 0;
        let got = 0;
        const counted = res.body.pipeThrough(new TransformStream({
            transform(chunk, controller) {
                got += chunk.byteLength;
                if (total && onProgress) onProgress(Math.min(1, got / total));
                controller.enqueue(chunk);
            }
        }));
        const bytes = new Uint8Array(await new Response(counted.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        const { pos, rot, scl, col, label, excess } = decodeOutfit(bytes, this.meta, fig);
        this.extents[i] = measureBands(pos, col, this.bands[i]);

        if (this.sh) {
            // this outfit's rows of the palette, as the values the codebook stands for
            const entries = await paletteBytes;
            if (entries.length !== fig.sh.count * SH_COEFFS * 3) throw new Error('outfit palette has an unexpected size');
            const half = Uint16Array.from(fig.sh.codebook, toHalf);
            const texels = this.palette.lock();
            const row0 = i * PALETTE_ROWS * PALETTE_WIDTH;
            for (let t = 0; t < fig.sh.count * SH_COEFFS; t++) {
                const d = (row0 + t) * 4;
                texels[d] = half[entries[t * 3]];
                texels[d + 1] = half[entries[t * 3 + 1]];
                texels[d + 2] = half[entries[t * 3 + 2]];
            }
            this.palette.unlock();
        }

        const N = this.count;
        const posTex = this.container.getTexture(`pos${i}`);
        const dst = posTex.lock();
        for (let k = 0; k < N; k++) {
            dst[k * 4] = pos[k * 3];
            dst[k * 4 + 1] = pos[k * 3 + 1];
            dst[k * 4 + 2] = pos[k * 3 + 2];
            if (label) dst[k * 4 + 3] = label[k];
        }
        posTex.unlock();
        // The engine keeps the array a texture was filled from, so it can fill it again if the
        // graphics context is lost. For these that is a second copy of everything, hundreds of
        // megabytes at full detail and too much for a phone: let them go once they are on the
        // GPU. main.js reloads the page if the context is ever lost.
        posTex.setReleaseSourceAfterUpload();
        for (const [name, data] of [['rot', rot], ['scl', scl], ['col', col]]) {
            const tex = this.container.getTexture(`${name}${i}`);
            if (name === 'col' && excess) {
                // half floats: the 8-bit colour, plus whatever of it was beyond 0..1
                const byteHalf = Uint16Array.from({ length: 256 }, (_, b) => toHalf(b / 255));
                const step = this.meta.sh.excessStep;
                const texels = tex.lock();
                for (let k = 0; k < N; k++) {
                    for (let c = 0; c < 3; c++) {
                        const e = excess[k * 3 + c];
                        texels[k * 4 + c] = e ? toHalf(data[k * 4 + c] / 255 + e * step) : byteHalf[data[k * 4 + c]];
                    }
                    texels[k * 4 + 3] = byteHalf[data[k * 4 + 3]];
                }
            } else {
                tex.lock().set(data);
            }
            tex.unlock();
            tex.setReleaseSourceAfterUpload();
        }

        // WebGL2 sorts on the CPU and needs the positions; WebGPU sorts on the GPU
        if (!this.device.isWebGPU) this.centers[i] = pos;
        this.ready[i] = true;
        // the palette is filled an outfit at a time, so its copy is kept until the last one
        if (this.sh && this.ready.every(Boolean)) this.palette.setReleaseSourceAfterUpload();
        if (onProgress) onProgress(1);
    }

    /** The next outfit after the given one that has loaded, or -1 if there is no other. */
    nextReady(from) {
        for (let d = 1; d < this.ready.length; d++) {
            const i = (from + d) % this.ready.length;
            if (this.ready[i]) return i;
        }
        return -1;
    }

    /** Attach to the gsplat component that renders the container. */
    attach(gsplat) {
        this.gsplat = gsplat;
        this._push();
        gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
    }

    /**
     * Tell the shader where the camera is, for the colour that depends on the view. The engine
     * decides when to work the colours out again (see colorUpdateAngle in main.js); this only
     * has to be current when it does.
     *
     * @param {Vec3} cameraPos - Camera position in the figure's own frame.
     */
    setView(cameraPos) {
        if (!this.sh) return;
        this.gsplat.setParameter('uShCam', [cameraPos.x, cameraPos.y, cameraPos.z, this.viewColour]);
    }

    /** Strength of the view-dependent colour: 1 as captured, 0 for the base colour alone. */
    get viewColour() {
        return this._viewColour;
    }

    set viewColour(value) {
        if (value === this._viewColour) return;
        this._viewColour = value;
        if (this.sh && this.gsplat) {
            const cam = this.gsplat.getParameter('uShCam') ?? [0, 1, 5, 1];
            this.gsplat.setParameter('uShCam', [cam[0], cam[1], cam[2], value]);
            this.gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
        }
    }

    get busy() {
        return this.progress > 0;
    }

    /** Eased overall progress, for anything that should follow the morph as a whole. */
    get blend() {
        return smooth(this.progress);
    }

    /** Progress with a gentle ease in and out, which is what the shader runs on. */
    get eased() {
        const p = this.progress;
        return p + (smooth(p) - p) * 0.5;
    }

    /** A gaussian's clock at a given height (ignoring the tilt of the waves and their noise). */
    _clock(y) {
        const order = 1 - Math.min(1, Math.max(0, y / HEIGHT));
        return this.eased * (1 + this.stagger) - order * this.stagger;
    }

    /**
     * How far the gaussians at a given height have travelled towards the target outfit, 0..1.
     * Matches "glide" in the shader, so anything pinned to the figure can change over as the
     * dots around it do.
     *
     * @param {number} y - Height in the figure frame, metres.
     * @returns {number} Local progress.
     */
    progressAt(y) {
        if (!this.busy) return 0;
        return smooth(Math.min(1, Math.max(0, (this._clock(y) - 0.08) / 0.72)));
    }

    /** Height of the second wave, where the cloth re-forms, metres. Only meaningful during a morph. */
    get waveHeight() {
        return HEIGHT * (1 - (this.eased * (1 + this.stagger) - 0.84) / this.stagger);
    }

    /** How much of the second wave is left, 0..1: it fades as the last of the cloth re-forms. */
    get waveAmount() {
        if (!this.busy) return 0;
        const p = this.eased;
        return smooth(Math.min(1, Math.max(0, (p - 0.1) / 0.2))) * (1 - smooth(Math.min(1, Math.max(0, (p - 0.9) / 0.1))));
    }

    /** Start a morph to the given outfit. Ignored while one is running or before it has loaded. */
    morphTo(index) {
        if (this.busy || index === this.from || !this.ready[index]) return false;
        this.to = index;
        this.progress = 1e-4;
        this._swapped = false;
        return true;
    }

    update(dt) {
        if (!this.busy) return;
        this.progress = Math.min(1, this.progress + dt / this.duration);

        // the CPU sorter orders by rest positions: hand it the target's half way through
        if (!this._swapped && this.progress >= 0.5 && this.centers[this.to]) {
            this._swapped = true;
            this.container.centers = this.centers[this.to];
            this.container.update(this.count, true);
        }

        if (this.progress >= 1) {
            this.from = this.to;
            this.progress = 0;
            this._push();
            this.gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
        } else {
            this._push();
            this.gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ALWAYS;
        }
    }

    _push() {
        const g = this.gsplat;
        g.setParameter('uMorph', [this.from, this.to, this.eased, this.stagger]);
        g.setParameter('uMorphFx', [this.tilt[0], this.tilt[1], HEIGHT, this.noise]);
        g.setParameter('uMorphFx2', [this.dot, this.swell, this.progress * this.duration, this.dotOpacity]);
        g.setParameter('uMorphDot', [this.dotTint[0], this.dotTint[1], this.dotTint[2], this.dotGlow]);
        g.setParameter('uMorphGlow', [this.glow[0], this.glow[1], this.glow[2], this.heat]);
        g.setParameter('uMorphScale', [this.meta.scaleRange[0], this.meta.scaleRange[1], 0, 0]);
        if (this.sh) {
            if (!g.getParameter('uShCam')) g.setParameter('uShCam', [0, 1, 5, this.viewColour]);
            g.setParameter('uShFrame[0]', new Float32Array(this.names.flatMap(name => this.meta.figures[name].sh.frame)));
        }
    }
}
