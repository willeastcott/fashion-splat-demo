// Build the morph pack: all three outfits resampled into ONE shared slot order, so slot i of
// one outfit is the partner of slot i in every other outfit and a morph is a per-slot blend.
//
//   node tools/build-morph.mjs                   full captures        -> public/morph
//   node tools/build-morph.mjs --variant=1m      raw/*/scene.1m.ply   -> public/morph-1m
//   node tools/build-morph.mjs --variant=500k    raw/*/scene.500k.ply -> public/morph-500k
// Add --sh to keep the colour that changes with the view as well. The lighter packs are
// built that way (see tools/build-data.sh); the full captures with it go to public/morph-sh,
// beside the pack without.
//
// There is no real correspondence between two separate captures, so one is manufactured from
// the body layout the figures share:
//   1. Normalise every capture into the common figure frame (see src/figures.js).
//   2. Cut each figure into blocks about 10 cm tall, measured between that figure's own
//      landmarks (floor > crotch > neck > top of head), with the two legs kept apart.
//   3. Inside a block, order gaussians by height into thin slices holding equal numbers,
//      then within a slice by angle around its centre, then by distance from it, so inner
//      layers pair with inner layers and outer with outer.
//   4. Give each block as many slots as its fullest outfit needs. An outfit with fewer
//      gaussians there repeats some; the repeats are invisible at rest (alpha 0) and only
//      fade in while travelling to a partner, so each outfit at rest is exactly its capture.
//
// Output (public/morph): meta.json and one gzipped <figure>.pack per outfit, holding only that
// outfit's own gaussians. The format is described in src/pack.js, which also decodes it.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { Column, DataTable, MemoryFileSystem, Transform, WebPCodec, writeSog } from '@playcanvas/splat-transform';

import { figureOrder, figures } from '../src/figures.js';
import { PACK_VERSION, PLANES, decodeOutfit, largestByte } from '../src/pack.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const variant = (process.argv.find(a => a.startsWith('--variant=')) ?? '').slice('--variant='.length);
// --sh keeps the captures' spherical harmonics (the part of the colour that changes with the
// viewing direction) as a palette per outfit; see src/pack.js
const withSH = process.argv.includes('--sh');
// the full captures have a pack without it too (public/morph), so theirs goes beside that
const outDir = join(root, variant ? `public/morph-${variant}` : withSH ? 'public/morph-sh' : 'public/morph');
mkdirSync(outDir, { recursive: true });

const BLOCKS_LEG = 9;        // floor..crotch, per leg
const BLOCKS_TORSO = 8;      // crotch..neck
const BLOCKS_HEAD = 3;       // neck..top
const SLICES = 20;           // equal-count height slices inside a block, about 5 mm each
const ANGLE_BINS = 96;
const CELLS = BLOCKS_LEG * 2 + BLOCKS_TORSO + BLOCKS_HEAD;
const SH_C0 = 0.28209479177387814;
const SH_COEFFS = 15;        // per colour channel: bands 1 to 3
const SH_ITERATIONS = 10;    // k-means passes, the number splat-transform uses when writing SOG

// ---- PLY -----------------------------------------------------------------------------------
const readPly = (path) => {
    const fd = openSync(path, 'r');
    const head = Buffer.alloc(8192);
    readSync(fd, head, 0, head.length, 0);
    const text = head.toString('latin1');
    const end = text.indexOf('end_header\n');
    const headerLen = end + 'end_header\n'.length;
    let count = 0;
    const props = [];
    for (const line of text.slice(0, end).split('\n')) {
        const t = line.trim().split(/\s+/);
        if (t[0] === 'element' && t[1] === 'vertex') count = parseInt(t[2], 10);
        if (t[0] === 'property') {
            if (t[1] !== 'float') throw new Error(`unsupported PLY property type ${t[1]}`);
            props.push(t[2]);
        }
    }
    // splat-transform's decimator writes opacity already in 0..1 as "opacity_linear";
    // a standard 3DGS PLY stores it as a logit in "opacity"
    const linearOpacity = !props.includes('opacity') && props.includes('opacity_linear');
    const names = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'scale_0', 'scale_1', 'scale_2', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
    const offs = names.map((n) => {
        const i = props.indexOf(n === 'opacity' && linearOpacity ? 'opacity_linear' : n);
        if (i < 0) throw new Error(`PLY is missing ${n}`);
        return i;
    });
    const cols = names.map(() => new Float32Array(count));
    const np = props.length;
    const CH = 65536;
    const chunk = Buffer.alloc(CH * np * 4);
    for (let base = 0; base < count; base += CH) {
        const n = Math.min(CH, count - base);
        readSync(fd, chunk, 0, n * np * 4, headerLen + base * np * 4);
        const f = new Float32Array(chunk.buffer, chunk.byteOffset, n * np);
        for (let c = 0; c < names.length; c++) {
            const o = offs[c], dst = cols[c];
            for (let i = 0; i < n; i++) dst[base + i] = f[i * np + o];
        }
    }
    closeSync(fd);
    // hand back opacity as alpha in 0..1 either way
    const alpha = cols[names.indexOf('opacity')];
    for (let i = 0; i < count; i++) {
        alpha[i] = linearOpacity ? Math.max(0, Math.min(1, alpha[i])) : 1 / (1 + Math.exp(-alpha[i]));
    }
    return { count, cols: Object.fromEntries(names.map((n, i) => [n === 'opacity' ? 'alpha' : n, cols[i]])) };
};

// Read some of a PLY's properties for some of its rows. `slot` says, for every row of the file,
// where it goes in the output (or -1 to leave it out).
const readPlyRows = (path, names, slot, n) => {
    const fd = openSync(path, 'r');
    const head = Buffer.alloc(8192);
    readSync(fd, head, 0, head.length, 0);
    const text = head.toString('latin1');
    const end = text.indexOf('end_header\n');
    const headerLen = end + 'end_header\n'.length;
    let count = 0;
    const props = [];
    for (const line of text.slice(0, end).split('\n')) {
        const t = line.trim().split(/\s+/);
        if (t[0] === 'element' && t[1] === 'vertex') count = parseInt(t[2], 10);
        if (t[0] === 'property') props.push(t[2]);
    }
    // a decimated capture holds opacity as 0..1 in opacity_linear (see readPly)
    const linearOpacity = !props.includes('opacity') && props.includes('opacity_linear');
    const offs = names.map((name) => {
        const i = props.indexOf(name === 'opacity' && linearOpacity ? 'opacity_linear' : name);
        if (i < 0) throw new Error(`PLY is missing ${name}`);
        return i;
    });
    const cols = names.map(() => new Float32Array(n));
    const np = props.length;
    const CH = 65536;
    const chunk = Buffer.alloc(CH * np * 4);
    for (let base = 0; base < count; base += CH) {
        const m = Math.min(CH, count - base);
        readSync(fd, chunk, 0, m * np * 4, headerLen + base * np * 4);
        const f = new Float32Array(chunk.buffer, chunk.byteOffset, m * np);
        for (let i = 0; i < m; i++) {
            const u = slot[base + i];
            if (u < 0) continue;
            for (let c = 0; c < names.length; c++) cols[c][u] = f[i * np + offs[c]];
        }
    }
    closeSync(fd);
    // hand opacity back the way a standard PLY holds it, as a logit
    if (linearOpacity && names.includes('opacity')) {
        const o = cols[names.indexOf('opacity')];
        for (let u = 0; u < n; u++) {
            const a = Math.max(1e-6, Math.min(1 - 1e-6, o[u]));
            o[u] = Math.log(a / (1 - a));
        }
    }
    return cols;
};

// ---- view-dependent colour -------------------------------------------------------------------
// The captures hold 45 spherical harmonic coefficients per gaussian. Storing them outright
// would be several times the rest of the pack, so they are clustered into a palette of up to
// 65536 entries per outfit and each gaussian keeps a 16-bit index into it. The clustering is
// splat-transform's, the one behind the SOG files SuperSplat publishes: the outfit is handed
// to its SOG writer in pairing order and the palette and labels are read back out of the
// result (the layout is the published SOG format's).
//
// The clustering runs on the GPU, through Dawn (the "webgpu" package), the way splat-transform's
// own command line does it. On the CPU it would take hours.
let gpuDevice = null;
const createDevice = async () => {
    if (!gpuDevice) {
        const { create, globals } = await import('webgpu');
        const { WebgpuGraphicsDevice } = await import('playcanvas');
        // the engine expects a browser: give it just enough of one
        Object.assign(globalThis, globals);
        const canvas = { getContext: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150 }), width: 1024, height: 512 };
        globalThis.window = { navigator: { userAgent: 'node.js', gpu: create([]) } };
        globalThis.document = { createElement: type => (type === 'canvas' ? canvas : undefined) };
        const device = new WebgpuGraphicsDevice(canvas, { antialias: false, depth: false, stencil: false });
        await device.createDevice();
        // a GPU error would otherwise pass silently and leave a corrupt palette
        device.wgpu?.addEventListener?.('uncapturederror', (ev) => {
            console.error(`WebGPU error: ${ev?.error?.message}`);
            process.exit(1);
        });
        gpuDevice = device;
    }
    return gpuDevice;
};

const clusterSH = async (f) => {
    const n = f.count;
    const slot = new Int32Array(f.sourceCount).fill(-1);
    for (let u = 0; u < n; u++) slot[f.keep[f.order[u]]] = u;

    // The clustering takes minutes, and its result only changes if the capture or the pairing
    // order does: keep it beside the capture, under a fingerprint of that order.
    let hash = 2166136261;
    for (let u = 0; u < n; u++) hash = Math.imul(hash ^ f.keep[f.order[u]], 16777619) >>> 0;
    const cachePath = f.path.replace(/\.ply$/, `.sh-${SH_ITERATIONS}-${n}-${hash.toString(16)}.cache`);
    if (existsSync(cachePath)) {
        const buf = readFileSync(cachePath);
        const headLen = buf.readUInt32LE(0);
        const head = JSON.parse(buf.subarray(4, 4 + headLen).toString('utf8'));
        const body = buf.subarray(4 + headLen);
        const labels = new Uint16Array(n);
        for (let u = 0; u < n; u++) labels[u] = body.readUInt16LE(u * 2);
        console.log(`${f.name}: SH palette of ${head.count} (from ${basename(cachePath)}), error ${head.error}% of the signal (rms)`);
        return { labels, palette: new Uint8Array(body.subarray(n * 2)), count: head.count, codebook: head.codebook };
    }

    const names = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
    const rest0 = names.length;
    for (let i = 0; i < SH_COEFFS * 3; i++) names.push(`f_rest_${i}`);
    const cols = readPlyRows(f.path, names, slot, n);

    const fs = new MemoryFileSystem();
    const indices = new Uint32Array(n);
    for (let u = 0; u < n; u++) indices[u] = u;
    await writeSog({
        // the columns are a PLY's, so say so: by default the writer takes a table to be in the
        // engine's axes and would turn it (harmonics included) into a PLY's
        dataTable: new DataTable(names.map((name, i) => new Column(name, cols[i])), Transform.PLY),
        filename: 'meta.json',
        bundle: false,
        iterations: SH_ITERATIONS,
        version: 2,
        indices,
        createDevice,
        logging: 'silent'
    }, fs);
    const file = (name) => {
        for (const [key, data] of fs.results) if (key.replace(/\\/g, '/').endsWith(name)) return data;
        throw new Error(`${f.name}: the SOG writer did not produce ${name}`);
    };
    const shN = JSON.parse(Buffer.from(file('meta.json')).toString('utf8')).shN;
    if (!shN || shN.bands !== 3 || shN.count > 65536) throw new Error(`${f.name}: unexpected SH palette`);
    const codec = await WebPCodec.create();
    // a decoded image is only good until the next decode: copy what is needed first
    const labelImg = { rgba: codec.decodeRGBA(file('shN_labels.webp')).rgba.slice() };
    const paletteImg = codec.decodeRGBA(file('shN_centroids.webp'));
    if (paletteImg.width !== 64 * SH_COEFFS) throw new Error(`${f.name}: unexpected SH palette width`);

    const labels = new Uint16Array(n);
    for (let u = 0; u < n; u++) labels[u] = labelImg.rgba[u * 4] | (labelImg.rgba[u * 4 + 1] << 8);

    // palette entry e, coefficient j: red, green and blue as indices into the codebook
    const palette = new Uint8Array(shN.count * SH_COEFFS * 3);
    for (let t = 0; t < shN.count * SH_COEFFS; t++) {
        palette[t * 3] = paletteImg.rgba[t * 4];
        palette[t * 3 + 1] = paletteImg.rgba[t * 4 + 1];
        palette[t * 3 + 2] = paletteImg.rgba[t * 4 + 2];
    }

    // how far the palette is from the capture, in the units of the coefficients
    let err = 0, signal = 0;
    for (let u = 0; u < n; u += 5) {
        const at = labels[u] * SH_COEFFS * 3;
        for (let j = 0; j < SH_COEFFS; j++) {
            for (let ch = 0; ch < 3; ch++) {
                const v = cols[rest0 + ch * SH_COEFFS + j][u];
                const d = shN.codebook[palette[at + j * 3 + ch]] - v;
                err += d * d;
                signal += v * v;
            }
        }
    }
    const error = (Math.sqrt(err / signal) * 100).toFixed(1);
    console.log(`${f.name}: SH palette of ${shN.count}, error ${error}% of the signal (rms)`);
    const head = Buffer.from(JSON.stringify({ count: shN.count, codebook: shN.codebook, error }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(head.length, 0);
    writeFileSync(cachePath, Buffer.concat([len, head, Buffer.from(labels.buffer, labels.byteOffset, n * 2), palette]));
    return { labels, palette, count: shN.count, codebook: shN.codebook };
};

// ---- maths ---------------------------------------------------------------------------------
const axisRow = (spec) => {
    const s = spec.startsWith('-') ? -1 : 1;
    const a = 'xyz'.indexOf(spec.replace('-', ''));
    const row = [0, 0, 0];
    row[a] = s;
    return row;
};
const mul3 = (a, b) => a.map((r, i) => [0, 1, 2].map(j => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const det3 = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
// rotation matrix -> quaternion [x, y, z, w]
const quatFromMat = (m) => {
    const tr = m[0][0] + m[1][1] + m[2][2];
    let x, y, z, w;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        w = s / 4; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s;
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
        const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
        w = (m[2][1] - m[1][2]) / s; x = s / 4; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
    } else if (m[1][1] > m[2][2]) {
        const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
        w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = s / 4; z = (m[1][2] + m[2][1]) / s;
    } else {
        const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
        w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = s / 4;
    }
    return [x, y, z, w];
};

// ---- load + normalise one figure -----------------------------------------------------------
const loadFigure = (name) => {
    const def = figures[name];
    const n = def.normalise;
    const path = join(root, variant ? def.raw.replace(/\.ply$/, `.${variant}.ply`) : def.raw);
    const { count, cols } = readPly(path);

    const yaw = n.yaw * Math.PI / 180;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const M = mul3([[c, 0, s], [0, 1, 0], [-s, 0, c]], n.map.map(axisRow));
    if (Math.abs(det3(M) - 1) > 1e-6) throw new Error(`${name}: axis map is a reflection, not a rotation`);
    const [qx, qy, qz, qw] = quatFromMat(M);
    const lnScale = Math.log(n.scale);

    // keep gaussians that are visible at 8-bit alpha and inside the figure's box
    const keep = new Uint32Array(count);
    let kept = 0;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const x = cols.x[i], y = cols.y[i], z = cols.z[i];
        const px = n.scale * (M[0][0] * x + M[0][1] * y + M[0][2] * z) + n.translate[0];
        const py = n.scale * (M[1][0] * x + M[1][1] * y + M[1][2] * z) + n.translate[1];
        const pz = n.scale * (M[2][0] * x + M[2][1] * y + M[2][2] * z) + n.translate[2];
        if (Math.round(cols.alpha[i] * 255) < 1) continue;
        if (Math.abs(px) > 0.75 || Math.abs(pz) > 0.75 || py < -0.06 || py > 2.2) continue;
        pos[kept * 3] = px; pos[kept * 3 + 1] = py; pos[kept * 3 + 2] = pz;
        keep[kept++] = i;
    }

    const fig = {
        name,
        def,
        path,
        sourceCount: count,
        keep: keep.subarray(0, kept),       // the row of the PLY each kept gaussian came from
        frame: [qx, qy, qz, qw],            // rotation taking the capture's axes to the figure's
        count: kept,
        pos: pos.subarray(0, kept * 3),
        rot: new Float32Array(kept * 4),        // x,y,z,w
        logScale: new Float32Array(kept * 3),
        rgba: new Uint8Array(kept * 4)
    };
    const u8 = v => Math.max(0, Math.min(255, Math.round(v * 255)));
    // A base colour outside 0..1 is clipped by the 8-bit store. That is what a screen does to
    // it anyway, until the view-dependent part is added back on top: then the clipped-off
    // remainder matters, so it is kept for the packs that carry that part.
    fig.excess = new Float32Array(kept * 3);
    fig.clipped = 0;
    for (let k = 0; k < kept; k++) {
        const i = keep[k];
        const dc = [cols.f_dc_0[i], cols.f_dc_1[i], cols.f_dc_2[i]];
        let any = false;
        for (let c = 0; c < 3; c++) {
            const v = 0.5 + SH_C0 * dc[c];
            if (v < 0 || v > 1) {
                fig.excess[k * 3 + c] = v - Math.max(0, Math.min(1, v));
                any = true;
            }
        }
        if (any) fig.clipped++;
    }
    for (let k = 0; k < kept; k++) {
        const i = keep[k];
        // PLY quaternion is w,x,y,z
        let w = cols.rot_0[i], x = cols.rot_1[i], y = cols.rot_2[i], z = cols.rot_3[i];
        const l = Math.hypot(w, x, y, z) || 1;
        w /= l; x /= l; y /= l; z /= l;
        // q' = qR * q
        let rx = qw * x + qx * w + qy * z - qz * y;
        let ry = qw * y - qx * z + qy * w + qz * x;
        let rz = qw * z + qx * y - qy * x + qz * w;
        let rw = qw * w - qx * x - qy * y - qz * z;
        if (rw < 0) { rx = -rx; ry = -ry; rz = -rz; rw = -rw; }
        fig.rot.set([rx, ry, rz, rw], k * 4);
        fig.logScale.set([cols.scale_0[i] + lnScale, cols.scale_1[i] + lnScale, cols.scale_2[i] + lnScale], k * 3);
        fig.rgba.set([
            u8(0.5 + SH_C0 * cols.f_dc_0[i]),
            u8(0.5 + SH_C0 * cols.f_dc_1[i]),
            u8(0.5 + SH_C0 * cols.f_dc_2[i]),
            u8(cols.alpha[i])
        ], k * 4);
    }

    // top of the figure: highest reasonably solid gaussian
    const ys = [];
    for (let k = 0; k < kept; k++) if (fig.rgba[k * 4 + 3] > 76) ys.push(fig.pos[k * 3 + 1]);
    const sorted = Float32Array.from(ys).sort();
    fig.topY = sorted[Math.floor(sorted.length * 0.9995)] + 0.01;
    return fig;
};

// ---- cells ---------------------------------------------------------------------------------
const assignCells = (fig) => {
    const { def, count, pos } = fig;
    const crotchY = def.crotchY;
    const neckY = def.joints.neck[1];
    const ankleY = (def.joints.ankleL[1] + def.joints.ankleR[1]) / 2;
    const clampInt = (v, n) => Math.max(0, Math.min(n - 1, Math.floor(v)));

    // block of each gaussian
    const cell = new Uint16Array(count);
    for (let k = 0; k < count; k++) {
        const x = pos[k * 3], y = pos[k * 3 + 1];
        let c;
        if (y < crotchY) {
            const t = Math.max(0, Math.min(1, (y - ankleY) / (crotchY - ankleY)));
            const left = x > def.splitX[0] + (def.splitX[1] - def.splitX[0]) * t;
            c = (left ? 0 : BLOCKS_LEG) + clampInt(y / crotchY * BLOCKS_LEG, BLOCKS_LEG);
        } else if (y < neckY) {
            c = BLOCKS_LEG * 2 + clampInt((y - crotchY) / (neckY - crotchY) * BLOCKS_TORSO, BLOCKS_TORSO);
        } else {
            c = BLOCKS_LEG * 2 + BLOCKS_TORSO + clampInt((y - neckY) / (fig.topY - neckY) * BLOCKS_HEAD, BLOCKS_HEAD);
        }
        cell[k] = c;
    }

    const start = new Uint32Array(CELLS + 1);
    for (let k = 0; k < count; k++) start[cell[k] + 1]++;
    for (let c = 0; c < CELLS; c++) start[c + 1] += start[c];

    // order by block, then height
    const order = new Uint32Array(count);
    for (let k = 0; k < count; k++) order[k] = k;
    order.sort((a, b) => (cell[a] - cell[b]) || (pos[a * 3 + 1] - pos[b * 3 + 1]));

    // equal-count slices inside each block, then angle bin (seam at the back) and radius
    const key = new Float64Array(count);
    for (let c = 0; c < CELLS; c++) {
        const base = start[c], n = start[c + 1] - base;
        for (let q = 0; q < SLICES; q++) {
            const i0 = base + Math.floor(q * n / SLICES), i1 = base + Math.floor((q + 1) * n / SLICES);
            let sx = 0, sz = 0, sw = 0;
            for (let i = i0; i < i1; i++) {
                const g = order[i], a = fig.rgba[g * 4 + 3];
                sx += pos[g * 3] * a; sz += pos[g * 3 + 2] * a; sw += a;
            }
            const cx = sx / sw, cz = sz / sw;
            for (let i = i0; i < i1; i++) {
                const g = order[i];
                const dx = pos[g * 3] - cx, dz = pos[g * 3 + 2] - cz;
                const bin = Math.min(ANGLE_BINS - 1, Math.floor((Math.atan2(dx, dz) + Math.PI) / (2 * Math.PI) * ANGLE_BINS));
                key[g] = (c * SLICES + q) * 1024 + bin + Math.min(0.999, Math.hypot(dx, dz));
            }
        }
    }
    order.sort((a, b) => key[a] - key[b]);

    fig.order = order;
    fig.start = start;
};

// region of a block, so an empty block can borrow from the nearest filled block of the same region
const regionRange = (c) => {
    if (c < BLOCKS_LEG) return [0, BLOCKS_LEG];
    if (c < BLOCKS_LEG * 2) return [BLOCKS_LEG, BLOCKS_LEG * 2];
    if (c < BLOCKS_LEG * 2 + BLOCKS_TORSO) return [BLOCKS_LEG * 2, BLOCKS_LEG * 2 + BLOCKS_TORSO];
    return [BLOCKS_LEG * 2 + BLOCKS_TORSO, CELLS];
};

// ---- run -----------------------------------------------------------------------------------
console.time('total');
const figs = figureOrder.map((name) => {
    const fig = loadFigure(name);
    assignCells(fig);
    console.log(`${name}: ${fig.count} gaussians kept, top ${fig.topY.toFixed(3)} m, base colour clipped on ${(fig.clipped / fig.count * 100).toFixed(2)}%`);
    return fig;
});

// slots per block = the fullest outfit's count
const slotStart = new Uint32Array(CELLS + 1);
for (let c = 0; c < CELLS; c++) {
    let m = 0;
    for (const f of figs) m = Math.max(m, f.start[c + 1] - f.start[c]);
    slotStart[c + 1] = slotStart[c] + m;
}
const N = slotStart[CELLS];
console.log(`slots: ${N}`);

// shared log-scale range for 8-bit quantisation
let lnMin = Infinity, lnMax = -Infinity;
for (const f of figs) {
    for (let i = 0; i < f.logScale.length; i++) {
        const v = f.logScale[i];
        if (v < lnMin) lnMin = v;
        if (v > lnMax) lnMax = v;
    }
}
lnMin = Math.max(lnMin, -13);
lnMax = Math.min(lnMax, 0);

// positions are stored as whole steps from the corner of the box that holds every outfit
const POS_STEP = 1e-4;
const posMin = [Infinity, Infinity, Infinity];
for (const f of figs) {
    for (let i = 0; i < f.pos.length; i++) posMin[i % 3] = Math.min(posMin[i % 3], f.pos[i]);
}
for (let a = 0; a < 3; a++) posMin[a] = Math.floor(posMin[a] / POS_STEP) * POS_STEP;

const meta = {
    version: PACK_VERSION,
    count: N,
    scaleRange: [lnMin, lnMax],
    pos: { min: posMin, step: POS_STEP },
    blocks: Array.from({ length: CELLS }, (_, c) => slotStart[c + 1] - slotStart[c]),
    figures: {}
};
const planeCount = withSH ? PLANES + 5 : PLANES;
if (withSH) {
    // the clipped-off part of the base colours, as whole steps either side of nothing
    let most = 0;
    for (const f of figs) for (let i = 0; i < f.excess.length; i++) most = Math.max(most, Math.abs(f.excess[i]));
    meta.planes = planeCount;
    meta.sh = { coeffs: SH_COEFFS, excessStep: most / 127 || 1 };
    console.log(`base colour runs up to ${most.toFixed(3)} outside 0..1: kept in steps of ${(meta.sh.excessStep * 255).toFixed(2)} of an 8-bit level`);
}
const slotPos = [];
let totalBytes = 0;

for (const f of figs) {
    const n = f.count;

    // a block this outfit has nothing in borrows the nearest filled block of the same region
    const source = [];
    for (let c = 0; c < CELLS; c++) {
        let src = c;
        if (meta.blocks[c] > 0 && f.start[c + 1] === f.start[c]) {
            const [lo, hi] = regionRange(c);
            src = -1;
            for (let d = 1; d < hi - lo && src < 0; d++) {
                if (c - d >= lo && f.start[c - d + 1] > f.start[c - d]) src = c - d;
                else if (c + d < hi && f.start[c + d + 1] > f.start[c + d]) src = c + d;
            }
            if (src < 0) throw new Error(`${f.name}: region of cell ${c} is empty`);
        }
        source.push(src);
    }

    // ---- planes, one byte per gaussian, in pairing order (see src/pack.js) --------------------
    const planes = new Uint8Array(n * planeCount);
    const plane = i => planes.subarray(i * n, (i + 1) * n);
    const u8 = v => Math.max(0, Math.min(255, Math.round(v)));

    for (let a = 0; a < 3; a++) {
        const lo = plane(a * 2), hi = plane(a * 2 + 1);
        let prev = 0;
        for (let u = 0; u < n; u++) {
            const v = Math.round((f.pos[f.order[u] * 3 + a] - posMin[a]) / POS_STEP);
            const d = v - prev;
            prev = v;
            const z = (d << 1) ^ (d >> 31);
            if (z > 65535) throw new Error(`${f.name}: position step too large for the format`);
            lo[u] = z & 255;
            hi[u] = z >> 8;
        }
    }
    {
        // the bytes the app's rotation texture holds; the largest is stored as a correction
        const c = [plane(6), plane(7), plane(8)], which = plane(9), fix = plane(10);
        const b = [0, 0, 0, 0];
        for (let u = 0; u < n; u++) {
            const g = f.order[u];
            for (let j = 0; j < 4; j++) b[j] = Math.round(f.rot[g * 4 + j] * 127.5 + 127.5);
            let m = 0;
            for (let j = 1; j < 4; j++) if (Math.abs(b[j] - 127.5) > Math.abs(b[m] - 127.5)) m = j;
            const negative = b[m] < 127.5 ? 4 : 0;
            let sum = 0, r = 0;
            for (let j = 0; j < 4; j++) {
                if (j === m) continue;
                c[r++][u] = b[j];
                sum += (b[j] / 127.5 - 1) ** 2;
            }
            which[u] = m | negative;
            fix[u] = (b[m] - largestByte(sum, negative)) & 255;
        }
    }
    {
        const s0 = plane(11), s1 = plane(12), s2 = plane(13);
        const g8 = plane(14), rg = plane(15), bg = plane(16), al = plane(17);
        const ln = v => u8((v - lnMin) / (lnMax - lnMin) * 255);
        for (let u = 0; u < n; u++) {
            const g = f.order[u];
            const a = ln(f.logScale[g * 3]);
            s0[u] = a;
            s1[u] = (ln(f.logScale[g * 3 + 1]) - a) & 255;
            s2[u] = (ln(f.logScale[g * 3 + 2]) - a) & 255;
            g8[u] = f.rgba[g * 4 + 1];
            rg[u] = (f.rgba[g * 4] - f.rgba[g * 4 + 1]) & 255;
            bg[u] = (f.rgba[g * 4 + 2] - f.rgba[g * 4 + 1]) & 255;
            al[u] = f.rgba[g * 4 + 3];
        }
    }

    let sh = null;
    if (withSH) {
        const c = await clusterSH(f);
        const lo = plane(PLANES), hi = plane(PLANES + 1);
        const ex = [plane(PLANES + 2), plane(PLANES + 3), plane(PLANES + 4)];
        for (let u = 0; u < n; u++) {
            lo[u] = c.labels[u] & 255;
            hi[u] = c.labels[u] >> 8;
            const g = f.order[u];
            for (let ch = 0; ch < 3; ch++) ex[ch][u] = 128 + Math.round(f.excess[g * 3 + ch] / meta.sh.excessStep);
        }
        const shFile = `${f.name}.sh`;
        const shZipped = gzipSync(c.palette, { level: 9 });
        writeFileSync(join(outDir, shFile), shZipped);
        totalBytes += shZipped.length;
        // "frame" turns a direction in the capture's axes into the figure's: the coefficients
        // are still in the capture's axes, so the app turns the view direction back with it
        sh = { file: shFile, count: c.count, codebook: c.codebook, frame: f.frame };
        console.log(`${f.name}: wrote ${shFile}, ${(shZipped.length / 1e6).toFixed(2)} MB`);
    }

    const file = `${f.name}.pack`;
    const zipped = gzipSync(planes, { level: 9 });
    writeFileSync(join(outDir, file), zipped);
    // packs used to be written uncompressed under this name
    rmSync(join(outDir, `${f.name}.bin`), { force: true });
    totalBytes += zipped.length;

    const fig = { file, gaussians: n, topY: +f.topY.toFixed(4), start: Array.from(f.start), source };
    if (sh) fig.sh = sh;
    meta.figures[f.name] = fig;

    // read it back the way the app will, for the partner statistics below and as a check
    const decoded = decodeOutfit(planes, meta, fig);
    let repeats = 0;
    for (let s = 0; s < N; s++) if (decoded.col[s * 4 + 3] === 0) repeats++;
    fig.repeats = repeats;
    slotPos.push(decoded);
    console.log(`${f.name}: wrote ${file}, ${(zipped.length / 1e6).toFixed(2)} MB (${(zipped.length / n).toFixed(2)} bytes per gaussian), ${n} gaussians + ${repeats} hidden repeats`);
}
console.log(`pack: ${(totalBytes / 1e6).toFixed(1)} MB for ${figs.length} outfits`);

// how far partners are from each other (slots visible in both outfits)
for (let a = 0; a < figs.length; a++) {
    const b = (a + 1) % figs.length;
    const A = slotPos[a], B = slotPos[b];
    const d = [];
    for (let s = 0; s < N; s += 7) {
        if (A.col[s * 4 + 3] === 0 || B.col[s * 4 + 3] === 0) continue;
        d.push(Math.hypot(A.pos[s * 3] - B.pos[s * 3], A.pos[s * 3 + 1] - B.pos[s * 3 + 1], A.pos[s * 3 + 2] - B.pos[s * 3 + 2]));
    }
    const sd = Float32Array.from(d).sort();
    const q = p => (sd[Math.floor(p * (sd.length - 1))] * 100).toFixed(1);
    console.log(`${figs[a].name} -> ${figs[b].name}: partner distance median ${q(0.5)} cm, 90% under ${q(0.9)} cm, 99% under ${q(0.99)} cm`);
}

writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
console.timeEnd('total');
