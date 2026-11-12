import {
    BoundingBox,
    GSplatContainer,
    GSplatFormat,
    PIXELFORMAT_RGBA32F,
    PIXELFORMAT_RGBA8,
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
    vec3 a = morphPos(ia).xyz;
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
        gMorphCenter = morphPos(i).xyz;
        gMorphRot = normalize(morphRot(i) * 2.0 - 1.0);
        gMorphScale = exp(mix(vec3(uMorphScale.x), vec3(uMorphScale.y), morphScl(i).xyz));
        gMorphColor = morphCol(i);
        return;
    }

    int ib = int(uMorph.y + 0.5);
    vec3 b = morphPos(ib).xyz;
    vec4 qa = morphRot(ia) * 2.0 - 1.0;
    vec4 qb = morphRot(ib) * 2.0 - 1.0;
    vec3 la = mix(vec3(uMorphScale.x), vec3(uMorphScale.y), morphScl(ia).xyz);
    vec3 lb = mix(vec3(uMorphScale.x), vec3(uMorphScale.y), morphScl(ib).xyz);
    vec4 ca = morphCol(ia);
    vec4 cb = morphCol(ib);
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
    let a = morphPos(ia).xyz;
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
        gMorphCenter = morphPos(i).xyz;
        gMorphRot = normalize(morphRot(i) * 2.0 - 1.0);
        gMorphScale = exp(mix(lo, hi, morphScl(i).xyz));
        gMorphColor = morphCol(i);
        return;
    }

    let b = morphPos(ib).xyz;
    let qa = morphRot(ia) * 2.0 - 1.0;
    var qb = morphRot(ib) * 2.0 - 1.0;
    let la = mix(lo, hi, morphScl(ia).xyz);
    let lb = mix(lo, hi, morphScl(ib).xyz);
    let ca = morphCol(ia);
    let cb = morphCol(ib);
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

    /**
     * Fetch the pack's description and its first outfit, and build the container. The other
     * outfits are fetched afterwards with loadOutfit, so the first can be on screen sooner.
     *
     * @param {import('playcanvas').GraphicsDevice} device - Graphics device.
     * @param {string} baseUrl - Folder holding meta.json and the .pack files.
     * @param {string[]} names - Figure names, in outfit order.
     * @param {(fraction: number) => void} onProgress - Called as the first outfit downloads.
     * @returns {Promise<Morph>} The morph.
     */
    static async load(device, baseUrl, names, onProgress) {
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

        const streams = [];
        for (let i = 0; i < OUTFITS; i++) {
            streams.push(
                { name: `pos${i}`, format: PIXELFORMAT_RGBA32F },
                { name: `rot${i}`, format: PIXELFORMAT_RGBA8 },
                { name: `scl${i}`, format: PIXELFORMAT_RGBA8 },
                { name: `col${i}`, format: PIXELFORMAT_RGBA8 }
            );
        }
        const format = new GSplatFormat(device, streams, { readGLSL, readWGSL });
        const container = new GSplatContainer(device, N, format);

        const morph = new Morph();
        morph.device = device;
        morph.baseUrl = baseUrl;
        morph.names = names;
        morph.container = container;
        morph.meta = meta;
        morph.count = N;
        morph.centers = names.map(() => null);
        morph.ready = names.map(() => false);

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
        const { pos, rot, scl, col } = decodeOutfit(bytes, this.meta, fig);

        const N = this.count;
        const posTex = this.container.getTexture(`pos${i}`);
        const dst = posTex.lock();
        for (let k = 0; k < N; k++) {
            dst[k * 4] = pos[k * 3];
            dst[k * 4 + 1] = pos[k * 3 + 1];
            dst[k * 4 + 2] = pos[k * 3 + 2];
        }
        posTex.unlock();
        for (const [name, data] of [['rot', rot], ['scl', scl], ['col', col]]) {
            const tex = this.container.getTexture(`${name}${i}`);
            tex.lock().set(data);
            tex.unlock();
        }

        // WebGL2 sorts on the CPU and needs the positions; WebGPU sorts on the GPU
        if (!this.device.isWebGPU) this.centers[i] = pos;
        this.ready[i] = true;
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
    }
}
