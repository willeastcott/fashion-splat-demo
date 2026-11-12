// The outfit pack format, version 2. Shared by the app (which reads it) and by
// tools/build-morph.mjs (which writes it), so the two cannot drift apart.
//
// A pack is meta.json plus one <figure>.pack per outfit. Each .pack is a gzip stream holding
// only the outfit's own gaussians, in pairing order, as 18 planes of one byte per gaussian:
//
//   0-5    position: x, y, z as whole steps of meta.pos.step from meta.pos.min, stored as the
//          difference from the previous gaussian (zigzag), low byte plane then high byte plane
//   6-8    rotation: the three smaller components of the quaternion, as the bytes the app's
//          rotation texture holds (component * 127.5 + 127.5)
//   9      rotation: which component is the largest (bits 0-1: 0 x, 1 y, 2 z, 3 w) and whether
//          it is negative (bit 2)
//   10     rotation: the largest component's byte, minus what the other three predict for it
//   11-13  scale: ln of the first axis over meta.scaleRange, then the other two axes minus it
//   14-16  colour: green, then red minus green and blue minus green
//   17     opacity
//
// Rotation, scale, colour and opacity come back as exactly the bytes the textures hold, so
// nothing is lost to the packing. Positions are rounded to the step (0.1 mm).
//
// A pack built with view-dependent colour (meta.sh is present, meta.planes is 23) adds:
//
//   18-19  the gaussian's entry in the outfit's palette of spherical harmonics, low byte plane
//          then high byte plane
//   20-22  how far the base colour (red, green, blue) runs outside the 0..1 that planes 14-16
//          can hold, in whole steps of meta.sh.excessStep, plus 128. Nearly always 128: none
//
// and one <figure>.sh per outfit: a gzip stream of the palette, 15 coefficients per entry and
// three bytes (red, green, blue) per coefficient, each an index into the 256 values of
// meta.figures[name].sh.codebook. The coefficients are bands 1 to 3 in the capture's own axes;
// sh.frame is the rotation (a quaternion, x y z w) from those axes to the figure's.
//
// The slots an outfit does not have gaussians for are not stored. meta.json says how many
// slots each block of the body has and where each outfit's blocks start, and decodeOutfit
// spreads the outfit's gaussians over the slots again (see slotSource).

export const PACK_VERSION = 2;
export const PLANES = 18;

/**
 * Which of a block's n gaussians fills slot k, when the block has `slots` slots. With more
 * slots than gaussians, neighbouring slots share one: the first is the gaussian itself and the
 * rest are hidden repeats.
 *
 * @param {number} k - Slot within the block.
 * @param {number} n - Gaussians the outfit has in the block.
 * @param {number} slots - Slots in the block.
 * @returns {number} Index of the gaussian within the block.
 */
export const slotSource = (k, n, slots) => Math.min(n - 1, Math.floor((k + 0.5) * n / slots));

/**
 * The byte the largest component of a unit quaternion should have, given the other three. The
 * pack stores only how far the real byte is from this, which is nearly always nothing.
 *
 * @param {number} sum - Sum of the squares of the other three components.
 * @param {number} negative - Non-zero if the component is negative.
 * @returns {number} The predicted byte, 0..255.
 */
export const largestByte = (sum, negative) => {
    const v = Math.sqrt(Math.max(0, 1 - sum));
    return Math.round((negative ? -v : v) * 127.5 + 127.5);
};

/**
 * Turn one outfit's planes back into per-slot arrays.
 *
 * @param {Uint8Array} bytes - The unzipped .pack: PLANES planes of fig.gaussians bytes.
 * @param {object} meta - The pack's meta.json.
 * @param {object} fig - meta.figures[name].
 * @returns {{pos: Float32Array, rot: Uint8Array, scl: Uint8Array, col: Uint8Array, label: Uint16Array|null, excess: Int8Array|null}}
 * Position (xyz), rotation (xyzw as 0..255), scale (3 used of 4) and colour (rgba) for every
 * slot. If the pack has view-dependent colour, also the slot's palette entry and the part of
 * its base colour beyond 0..1 (rgb, in steps of meta.sh.excessStep).
 */
export const decodeOutfit = (bytes, meta, fig) => {
    const n = fig.gaussians;
    if (bytes.length !== n * (meta.planes ?? PLANES)) throw new Error('outfit pack has an unexpected size');
    const plane = i => bytes.subarray(i * n, (i + 1) * n);

    // ---- the outfit's own gaussians ---------------------------------------------------------
    const upos = new Float32Array(n * 3);
    for (let a = 0; a < 3; a++) {
        const lo = plane(a * 2), hi = plane(a * 2 + 1);
        const min = meta.pos.min[a], step = meta.pos.step;
        let acc = 0;
        for (let i = 0; i < n; i++) {
            const z = lo[i] | (hi[i] << 8);
            acc += (z >>> 1) ^ -(z & 1);
            upos[i * 3 + a] = min + acc * step;
        }
    }

    const urot = new Uint8Array(n * 4);
    {
        const c = [plane(6), plane(7), plane(8)], which = plane(9), fix = plane(10);
        for (let i = 0; i < n; i++) {
            const m = which[i] & 3;
            let sum = 0, r = 0;
            for (let j = 0; j < 4; j++) {
                if (j === m) continue;
                const b = c[r++][i];
                urot[i * 4 + j] = b;
                sum += (b / 127.5 - 1) ** 2;
            }
            urot[i * 4 + m] = (largestByte(sum, which[i] & 4) + fix[i]) & 255;
        }
    }

    const s0 = plane(11), s1 = plane(12), s2 = plane(13);
    const g = plane(14), rg = plane(15), bg = plane(16), al = plane(17);

    // ---- spread over the slots --------------------------------------------------------------
    const N = meta.count;
    const pos = new Float32Array(N * 3);
    const rot = new Uint8Array(N * 4);
    const scl = new Uint8Array(N * 4);
    const col = new Uint8Array(N * 4);
    const llo = meta.sh ? plane(PLANES) : null, lhi = meta.sh ? plane(PLANES + 1) : null;
    const label = meta.sh ? new Uint16Array(N) : null;
    const ex = meta.sh ? [plane(PLANES + 2), plane(PLANES + 3), plane(PLANES + 4)] : null;
    const excess = meta.sh ? new Int8Array(N * 3) : null;
    let s = 0;
    for (let c = 0; c < meta.blocks.length; c++) {
        const slots = meta.blocks[c];
        // an outfit with nothing in a block borrows a neighbouring block's gaussians, all hidden
        const src = fig.source[c];
        const borrowed = src !== c;
        const base = fig.start[src];
        const count = fig.start[src + 1] - base;
        let prev = -1;
        for (let k = 0; k < slots; k++, s++) {
            const j = slotSource(k, count, slots);
            const u = base + j;
            pos[s * 3] = upos[u * 3]; pos[s * 3 + 1] = upos[u * 3 + 1]; pos[s * 3 + 2] = upos[u * 3 + 2];
            rot[s * 4] = urot[u * 4]; rot[s * 4 + 1] = urot[u * 4 + 1]; rot[s * 4 + 2] = urot[u * 4 + 2]; rot[s * 4 + 3] = urot[u * 4 + 3];
            scl[s * 4] = s0[u]; scl[s * 4 + 1] = (s1[u] + s0[u]) & 255; scl[s * 4 + 2] = (s2[u] + s0[u]) & 255;
            col[s * 4] = (rg[u] + g[u]) & 255; col[s * 4 + 1] = g[u]; col[s * 4 + 2] = (bg[u] + g[u]) & 255;
            col[s * 4 + 3] = !borrowed && j !== prev ? al[u] : 0;
            if (label) {
                label[s] = llo[u] | (lhi[u] << 8);
                excess[s * 3] = ex[0][u] - 128; excess[s * 3 + 1] = ex[1][u] - 128; excess[s * 3 + 2] = ex[2][u] - 128;
            }
            prev = j;
        }
    }
    return { pos, rot, scl, col, label, excess };
};
