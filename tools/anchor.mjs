// Find points on an outfit's surface, for placing callouts (see `callouts` in src/figures.js).
// Works on the built morph pack, so coordinates are already in the figure frame: metres, Y up,
// facing +Z, feet on y=0, the figure's left on +X.
//
//   node tools/anchor.mjs <figure> render <outPrefix> [--y0=0 --y1=2 --ppm=600]
//       writes <outPrefix>-front|back|left|right.png, with a line every 10 cm
//       (red = 0, green = whole metres, bright = half metres)
//
//   node tools/anchor.mjs <figure> <front|back|left|right> <h> <y>
//       prints the surface point seen from that side at height y and horizontal position h,
//       where h is x for front/back and z for left/right
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, gunzipSync } from 'node:zlib';

import { decodeOutfit } from '../src/pack.js';

const args = process.argv.slice(2);
const pos = args.filter(a => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const [figure, mode] = pos;
const pack = new URL(`../public/${opt.pack ?? 'morph-1m'}/`, import.meta.url);

const meta = JSON.parse(readFileSync(new URL('meta.json', pack), 'utf8'));
const N = meta.count;
const fig = meta.figures[figure];
const outfit = decodeOutfit(new Uint8Array(gunzipSync(readFileSync(new URL(fig.file, pack)))), meta, fig);
const P = outfit.pos;
const C = outfit.col;

// view: which axis runs across the picture (and its sign), and which way is towards the camera
const VIEWS = {
    front: { h: 0, hs: 1, d: 2, ds: 1, n: [0, 0, 1] },
    back: { h: 0, hs: -1, d: 2, ds: -1, n: [0, 0, -1] },
    left: { h: 2, hs: -1, d: 0, ds: 1, n: [1, 0, 0] },
    right: { h: 2, hs: 1, d: 0, ds: -1, n: [-1, 0, 0] }
};

if (mode === 'render') {
    const outPrefix = pos[2];
    const PPM = parseFloat(opt.ppm ?? '600');
    const H0 = -0.5, H1 = 0.5;
    const V0 = parseFloat(opt.y0 ?? '-0.05'), V1 = parseFloat(opt.y1 ?? '2.05');
    const W = Math.round((H1 - H0) * PPM), HH = Math.round((V1 - V0) * PPM);

    const crcTable = new Uint32Array(256).map((_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc32 = (b) => {
        let c = 0xffffffff;
        for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const writePng = (path, rgb) => {
        const raw = Buffer.alloc((W * 3 + 1) * HH);
        for (let y = 0; y < HH; y++) rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(HH, 4); ihdr[8] = 8; ihdr[9] = 2;
        writeFileSync(path, Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))
        ]));
    };

    for (const [name, v] of Object.entries(VIEWS)) {
        const rgb = Buffer.alloc(W * HH * 3, 20);
        const depth = new Float32Array(W * HH).fill(-Infinity);
        for (let i = 0; i < N; i++) {
            if (C[i * 4 + 3] < 100) continue;
            const px = Math.floor((P[i * 3 + v.h] * v.hs - H0) * PPM);
            const py = Math.floor((V1 - P[i * 3 + 1]) * PPM);
            if (px < 0 || py < 0 || px >= W || py >= HH) continue;
            const d = P[i * 3 + v.d] * v.ds;
            const k = py * W + px;
            if (d > depth[k]) {
                depth[k] = d;
                rgb[k * 3] = C[i * 4]; rgb[k * 3 + 1] = C[i * 4 + 1]; rgb[k * 3 + 2] = C[i * 4 + 2];
            }
        }
        const tint = (px, py, r, g, b) => {
            if (px < 0 || py < 0 || px >= W || py >= HH) return;
            const k = (py * W + px) * 3;
            rgb[k] = Math.min(255, rgb[k] + r); rgb[k + 1] = Math.min(255, rgb[k + 1] + g); rgb[k + 2] = Math.min(255, rgb[k + 2] + b);
        };
        for (let m = Math.ceil(V0 * 10); m <= Math.floor(V1 * 10); m++) {
            const py = Math.floor((V1 - m / 10) * PPM);
            for (let px = 0; px < W; px++) {
                if (m === 0) tint(px, py, 160, 0, 0);
                else if (m % 10 === 0) tint(px, py, 0, 130, 0);
                else if (m % 5 === 0) tint(px, py, 70, 70, 70);
                else if (px % 4 === 0) tint(px, py, 50, 50, 50);
            }
        }
        // vertical lines mark the horizontal axis in world units, so they flip with the view
        for (let m = -5; m <= 5; m++) {
            const px = Math.floor((m / 10 * v.hs - H0) * PPM);
            for (let py = 0; py < HH; py++) {
                if (m === 0) tint(px, py, 160, 0, 0);
                else if (m > 0 && py % 2 === 0) tint(px, py, 0, 60, 90);      // positive side: blue
                else if (m < 0 && py % 6 === 0) tint(px, py, 60, 60, 60);
            }
        }
        writePng(`${outPrefix}-${name}.png`, rgb);
    }
    console.log(`${W}x${HH}px, ${PPM}px/m, vertical ${V0}..${V1} m; blue lines are on the positive side of the horizontal axis`);
} else {
    const v = VIEWS[mode];
    if (!v) throw new Error('view must be front, back, left or right');
    const h = parseFloat(pos[2]), y = parseFloat(pos[3]);
    const R = parseFloat(opt.r ?? '0.012');
    // dark, plain cloth is often a few faint gaussians: lower --alpha if a query misses it
    const A = parseFloat(opt.alpha ?? '100');
    const hits = [];
    for (let i = 0; i < N; i++) {
        if (C[i * 4 + 3] < A) continue;
        if (Math.abs(P[i * 3 + v.h] - h) > R || Math.abs(P[i * 3 + 1] - y) > R) continue;
        hits.push(i);
    }
    if (!hits.length) throw new Error('nothing there');
    // walk in from the camera side to the first depth with a few gaussians close behind it,
    // which skips lone floaters without being fooled by a denser far side
    const depths = Float32Array.from(hits, i => P[i * 3 + v.d] * v.ds).sort().reverse();
    const need = Math.min(4, depths.length);
    let d = depths[0];
    for (let j = 0; j + need - 1 < depths.length; j++) {
        if (depths[j] - depths[j + need - 1] < 0.015) {
            d = depths[j];
            break;
        }
    }
    const near = hits.filter((i) => {
        const di = P[i * 3 + v.d] * v.ds;
        return di <= d + 1e-6 && di > d - 0.015;
    });
    const p = [0, 0, 0];
    for (const i of near) for (let k = 0; k < 3; k++) p[k] += P[i * 3 + k] / near.length;
    console.log(`pos: [${p.map(n => n.toFixed(3)).join(', ')}], normal: [${v.n.join(', ')}]   (${hits.length} gaussians in the column, ${near.length} at the surface)`);
}
