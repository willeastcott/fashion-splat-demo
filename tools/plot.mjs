// Normalise a 3DGS PLY into a common figure frame (Y up, facing +Z, feet on y=0, metres) and
// write orthographic front + side plots so joints can be placed by eye.
//
// usage: node tools/plot.mjs <scene.ply> <outPrefix> --map=-z,-y,-x --scale=0.0815
//   --map   : new x,y,z expressed as signed source axes (a pure axis permutation / flip)
//   --scale : uniform scale applied after the axis map
// Prints the translation that puts the feet on y=0 and the pelvis on x=z=0.
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const [plyPath, outPrefix] = args.filter(a => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const map = (opt.map ?? 'x,y,z').split(',');
const scale = parseFloat(opt.scale ?? '1');
const PPM = parseFloat(opt.ppm ?? '600');

// ---- header ------------------------------------------------------------------------------
const fd = openSync(plyPath, 'r');
const headBuf = Buffer.alloc(8192);
readSync(fd, headBuf, 0, headBuf.length, 0);
const headStr = headBuf.toString('latin1');
const endIdx = headStr.indexOf('end_header\n');
const headerLen = endIdx + 'end_header\n'.length;
let count = 0;
const props = [];
for (const l of headStr.slice(0, endIdx).split('\n')) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'element' && t[1] === 'vertex') count = parseInt(t[2], 10);
    if (t[0] === 'property') props.push(t[2]);
}
const np = props.length;
const stride = np * 4;
const idx = n => props.indexOf(n);

// ---- columns -----------------------------------------------------------------------------
const src = { x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count) };
const op = new Float32Array(count);
const col = [new Uint8Array(count), new Uint8Array(count), new Uint8Array(count)];
const o = { x: idx('x'), y: idx('y'), z: idx('z'), op: idx('opacity'), r: idx('f_dc_0'), g: idx('f_dc_1'), b: idx('f_dc_2') };
const CH = 65536;
const chunk = Buffer.alloc(CH * stride);
const c8 = v => Math.max(0, Math.min(255, Math.round((0.5 + 0.28209479 * v) * 255)));
for (let base = 0; base < count; base += CH) {
    const n = Math.min(CH, count - base);
    readSync(fd, chunk, 0, n * stride, headerLen + base * stride);
    const f = new Float32Array(chunk.buffer, chunk.byteOffset, n * np);
    for (let i = 0; i < n; i++) {
        const k = i * np;
        src.x[base + i] = f[k + o.x]; src.y[base + i] = f[k + o.y]; src.z[base + i] = f[k + o.z];
        op[base + i] = 1 / (1 + Math.exp(-f[k + o.op]));
        col[0][base + i] = c8(f[k + o.r]); col[1][base + i] = c8(f[k + o.g]); col[2][base + i] = c8(f[k + o.b]);
    }
}
closeSync(fd);

// ---- axis map + scale --------------------------------------------------------------------
const axis = (spec) => {
    const neg = spec.startsWith('-');
    const a = src[spec.replace('-', '')];
    const out = new Float32Array(count);
    const s = (neg ? -1 : 1) * scale;
    for (let i = 0; i < count; i++) out[i] = a[i] * s;
    return out;
};
const X = axis(map[0]), Y = axis(map[1]), Z = axis(map[2]);

// optional extra yaw (degrees) about +Y, applied after the axis map: x' = c*x + s*z, z' = -s*x + c*z
const yaw = parseFloat(opt.yaw ?? '0') * Math.PI / 180;
if (yaw !== 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let i = 0; i < count; i++) {
        const x = X[i], z = Z[i];
        X[i] = c * x + s * z;
        Z[i] = -s * x + c * z;
    }
}

const OPT = parseFloat(opt.opacity ?? '0.15');
const pctOf = (arr, sel, ps) => {
    const s = Float32Array.from(sel.map(i => arr[i])).sort();
    return ps.map(p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]);
};
const solid = [];
for (let i = 0; i < count; i++) if (op[i] > 0.5) solid.push(i);
const [floorY] = pctOf(Y, solid, [0.003]);
const [topY] = pctOf(Y, solid, [0.9995]);
// pelvis band: 48%..56% of the figure height
const h = topY - floorY;
const band = solid.filter(i => Y[i] - floorY > 0.48 * h && Y[i] - floorY < 0.56 * h);
const [cx] = pctOf(X, band, [0.5]);
const [cz] = pctOf(Z, band, [0.5]);
const tx = opt.tx !== undefined ? parseFloat(opt.tx) : -cx;
const ty = opt.ty !== undefined ? parseFloat(opt.ty) : -floorY;
const tz = opt.tz !== undefined ? parseFloat(opt.tz) : -cz;
for (let i = 0; i < count; i++) { X[i] += tx; Y[i] += ty; Z[i] += tz; }
console.log(`count ${count}`);

// shoulder-line direction from a PCA of the upper chest band; 0 means the figure squarely faces +/-Z
{
    const sel = solid.filter(i => Y[i] > 0.70 * h && Y[i] < 0.80 * h);
    let mx = 0, mz = 0;
    for (const i of sel) { mx += X[i]; mz += Z[i]; }
    mx /= sel.length; mz /= sel.length;
    let cxx = 0, czz = 0, cxz = 0;
    for (const i of sel) {
        const dx = X[i] - mx, dz = Z[i] - mz;
        cxx += dx * dx; czz += dz * dz; cxz += dx * dz;
    }
    const phi = 0.5 * Math.atan2(2 * cxz, cxx - czz) * 180 / Math.PI;
    console.log(`shoulder line is ${phi.toFixed(1)} deg off the X axis (add this to --yaw to square the figure up)`);
}
console.log(`translate (after map+scale): ${tx.toFixed(4)},${ty.toFixed(4)},${tz.toFixed(4)}   height ${(topY - floorY).toFixed(3)} m`);

// ---- PNG ---------------------------------------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
};
const writePng = (path, w, hh, rgb) => {
    const raw = Buffer.alloc((w * 3 + 1) * hh);
    for (let y = 0; y < hh; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hh, 4); ihdr[8] = 8; ihdr[9] = 2;
    writeFileSync(path, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))
    ]));
};

// ---- plots -------------------------------------------------------------------------------
// window: horizontal -0.5..0.5 m, vertical -0.05..2.05 m ; optional crop via --y0/--y1 (metres)
const H0 = -0.5, H1 = 0.5;
const V0 = parseFloat(opt.y0 ?? '-0.05'), V1 = parseFloat(opt.y1 ?? '2.05');
const W = Math.round((H1 - H0) * PPM), HH = Math.round((V1 - V0) * PPM);

const plot = (name, hArr, hSign, dArr, dSign) => {
    const rgb = Buffer.alloc(W * HH * 3, 20);
    const depth = new Float32Array(W * HH).fill(Infinity);
    for (let i = 0; i < count; i++) {
        if (op[i] < OPT) continue;
        const px = Math.floor((hArr[i] * hSign - H0) * PPM);
        const py = Math.floor((V1 - Y[i]) * PPM);
        if (px < 0 || py < 0 || px >= W || py >= HH) continue;
        const d = dArr[i] * dSign;
        const k = py * W + px;
        if (d < depth[k]) {
            depth[k] = d;
            rgb[k * 3] = col[0][i]; rgb[k * 3 + 1] = col[1][i]; rgb[k * 3 + 2] = col[2][i];
        }
    }
    const tint = (px, py, r, g, b) => {
        if (px < 0 || py < 0 || px >= W || py >= HH) return;
        const k = (py * W + px) * 3;
        rgb[k] = Math.min(255, rgb[k] + r); rgb[k + 1] = Math.min(255, rgb[k + 1] + g); rgb[k + 2] = Math.min(255, rgb[k + 2] + b);
    };
    // horizontal lines every 0.1 m: y=0 red, whole metres green, half metres bright, rest dim dotted
    for (let m = Math.ceil(V0 * 10); m <= Math.floor(V1 * 10); m++) {
        const py = Math.floor((V1 - m / 10) * PPM);
        for (let px = 0; px < W; px++) {
            if (m === 0) tint(px, py, 160, 0, 0);
            else if (m % 10 === 0) tint(px, py, 0, 130, 0);
            else if (m % 5 === 0) tint(px, py, 60, 60, 60);
            else if (px % 4 === 0) tint(px, py, 45, 45, 45);
        }
    }
    for (let m = Math.ceil(H0 * 10); m <= Math.floor(H1 * 10); m++) {
        const px = Math.floor((m / 10 - H0) * PPM);
        for (let py = 0; py < HH; py++) {
            if (m === 0) tint(px, py, 160, 0, 0);
            else if (m % 5 === 0) tint(px, py, 60, 60, 60);
            else if (py % 4 === 0) tint(px, py, 45, 45, 45);
        }
    }
    writePng(`${outPrefix}-${name}.png`, W, HH, rgb);
};
plot('front', X, 1, Z, -1);  // camera at +z looking -z: +x to the right
plot('back', X, -1, Z, 1);   // camera at -z looking +z: +x to the left
plot('side', Z, 1, X, -1);   // camera at +x: +z (figure front) drawn to the right
console.log(`plots: ${W}x${HH}px, ${PPM}px/m, horizontal ${H0}..${H1} m (red = 0), vertical ${V0}..${V1} m (red = floor, green = whole metres)`);

// ---- slice table: per 5 cm, x extents left/right of centre for solid splats ----------------
if (opt.slices) {
    console.log('  y     n     xmin   xmax   zmin   zmax');
    for (let s = 0; s < 40; s++) {
        const a = s * 0.05, b = a + 0.05;
        const sel = solid.filter(i => Y[i] >= a && Y[i] < b);
        if (sel.length < 50) continue;
        const [x0, x1] = pctOf(X, sel, [0.01, 0.99]);
        const [z0, z1] = pctOf(Z, sel, [0.01, 0.99]);
        console.log(`${a.toFixed(2)} ${String(sel.length).padStart(7)} ${x0.toFixed(3).padStart(7)}${x1.toFixed(3).padStart(7)}${z0.toFixed(3).padStart(7)}${z1.toFixed(3).padStart(7)}`);
    }
}
