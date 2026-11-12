// Figure definitions, shared by the browser app and by tools/build-morph.mjs.
//
// "normalise" takes each raw capture into the common figure frame: metres, Y up, facing +Z,
// feet on y = 0, body centred on x = z = 0.
//   map       - new x,y,z as signed source axes (must be a pure rotation)
//   yaw       - extra turn about +Y in degrees, applied after the map
//   scale     - uniform scale, applied after the rotation
//   translate - applied last
//
// Joints are in that frame and were placed by eye from the plots that tools/plot.mjs writes
// to analysis/. "L" is the figure's own left, which is +X.
//
// "look" and "callouts" are the shopping layer. The names, notes and prices are placeholders
// invented for the demo; they do not describe the real garments in the captures.
//   pos    - a point on the garment's surface, found with tools/anchor.mjs
//   normal - which way that surface faces; the callout hides when it faces away from the camera
//   focus  - how much of the figure the piece takes up, for the camera to frame when the
//            callout is picked: a band of heights (y), or a sphere of radius r around pos.
//            It is rough: nothing in the captures says which garment a gaussian belongs to
//   of     - marks a second callout for a piece that already has one, so it is priced once
// Callouts pair up across outfits by position in the list: during a morph, callout i of one
// outfit flies to callout i of the next.

export const figures = {
    casual_01: {
        title: 'Casual_01',
        label: 'Hoodie',
        source: 'https://superspl.at/scene/c297db17',
        raw: 'raw/Casual_01/scene.ply',
        normalise: { map: ['-z', '-y', '-x'], yaw: 0, scale: 0.0815, translate: [0.0011, -0.0280, -0.0117] },
        joints: {
            pelvis: [0.01, 0.95, 0.0],
            spine: [0.01, 1.12, 0.0],
            chest: [0.015, 1.32, 0.0],
            neck: [0.015, 1.52, 0.0],
            hipL: [0.10, 0.92, 0.0],
            kneeL: [0.103, 0.50, 0.01],
            ankleL: [0.108, 0.09, 0.0],
            hipR: [-0.08, 0.92, 0.0],
            kneeR: [-0.083, 0.50, 0.01],
            ankleR: [-0.075, 0.09, 0.0]
        },
        // height where the legs end and the pelvis takes over
        crotchY: 0.84,
        // x of the plane separating the two legs, at the ankles and at the crotch
        splitX: [0.015, 0.01],
        // how far the head may turn to follow the camera, degrees
        headYawLimit: 22,
        look: { name: 'Street Layer' },
        callouts: [
            { id: 'hoodie', name: 'Zip hoodie', note: 'Heavyweight cotton', price: 95, pos: [0.081, 1.740, 0.080], normal: [0.4, 0.1, 0.9], focus: { y: [0.87, 1.90] } },
            { id: 'tee', name: 'Jersey tee', note: 'Black cotton', price: 30, pos: [-0.047, 1.318, 0.099], normal: [0, 0, 1], focus: { r: 0.11 } },
            { id: 'trousers', name: 'Work trousers', note: 'Washed canvas', price: 85, pos: [0.110, 0.620, 0.158], normal: [0, 0, 1], focus: { y: [0.11, 0.87] } },
            { id: 'boots', name: 'Leather boots', note: 'Contrast laces', price: 140, pos: [-0.073, 0.063, 0.057], normal: [0, 0.3, 1], focus: { y: [-0.05, 0.11] } },
            { of: 'hoodie', name: 'Back print', note: 'Screen printed', pos: [0.006, 1.298, -0.158], normal: [0, 0, -1], focus: { r: 0.2 } }
        ]
    },

    casual_02: {
        title: 'Casual_02',
        label: 'Shirt',
        source: 'https://superspl.at/scene/60c01999',
        raw: 'raw/Casual_02/scene.ply',
        normalise: { map: ['-x', '-y', 'z'], yaw: 43, scale: 0.0677, translate: [-0.0025, -0.0275, -0.0236] },
        joints: {
            pelvis: [-0.005, 0.93, 0.0],
            spine: [-0.005, 1.10, 0.0],
            chest: [-0.005, 1.29, 0.0],
            neck: [-0.005, 1.50, 0.0],
            hipL: [0.085, 0.90, 0.0],
            kneeL: [0.10, 0.48, 0.01],
            ankleL: [0.108, 0.10, 0.0],
            hipR: [-0.095, 0.90, 0.0],
            kneeR: [-0.092, 0.48, 0.01],
            ankleR: [-0.058, 0.10, 0.0]
        },
        crotchY: 0.78,
        splitX: [0.02, 0.0],
        headYawLimit: 30,
        look: { name: 'Summer Field' },
        callouts: [
            { id: 'shirt', name: 'Camp shirt', note: 'Short sleeve', price: 65, pos: [0.139, 1.378, 0.045], normal: [0.3, 0, 1], focus: { y: [0.86, 1.52] } },
            { id: 'bag', name: 'Sling bag', note: 'Waxed canvas', price: 78, pos: [-0.078, 1.367, 0.118], normal: [0, 0, 1], focus: { r: 0.1 } },
            { id: 'jeans', name: 'Straight jeans', note: 'Indigo denim', price: 90, pos: [0.104, 0.620, 0.096], normal: [0, 0, 1], focus: { y: [0.09, 0.86] } },
            { id: 'shoes', name: 'Suede shoes', note: 'Crepe sole', price: 110, pos: [-0.061, 0.052, 0.063], normal: [0, 0.3, 1], focus: { y: [-0.05, 0.09] } },
            { of: 'bag', name: 'Sling bag', note: 'Waxed canvas', price: 78, pos: [-0.042, 1.102, -0.239], normal: [0, 0, -1], focus: { r: 0.2 } }
        ]
    },

    outdoor_01: {
        title: 'Outdoor_01',
        label: 'Outdoor',
        source: 'https://superspl.at/scene/3ccba00a',
        raw: 'raw/Outdoor_01/scene.ply',
        normalise: { map: ['x', '-y', '-z'], yaw: 9.5, scale: 0.0977, translate: [-0.0012, -0.0284, 0.006] },
        joints: {
            pelvis: [0.008, 0.95, 0.0],
            spine: [0.008, 1.12, 0.0],
            chest: [0.008, 1.33, 0.0],
            neck: [0.008, 1.56, 0.0],
            hipL: [0.092, 0.93, 0.0],
            kneeL: [0.142, 0.48, 0.01],
            ankleL: [0.167, 0.12, 0.0],
            hipR: [-0.075, 0.93, 0.0],
            kneeR: [-0.058, 0.48, 0.01],
            ankleR: [-0.05, 0.12, 0.0]
        },
        crotchY: 0.80,
        splitX: [0.045, 0.008],
        headYawLimit: 25,
        look: { name: 'Trail Shell' },
        callouts: [
            { id: 'beanie', name: 'Knit beanie', note: 'Striped wool', price: 28, pos: [0.048, 1.873, 0.107], normal: [0.2, 0.2, 1], focus: { y: [1.79, 2.05] } },
            { id: 'jacket', name: 'Shell jacket', note: 'Waterproof, 3 layer', price: 220, pos: [-0.122, 1.350, 0.098], normal: [-0.2, 0, 1], focus: { y: [0.89, 1.68] } },
            { id: 'trousers', name: 'Trek trousers', note: 'Zip vents', price: 120, pos: [0.133, 0.617, 0.129], normal: [0, 0, 1], focus: { y: [0.13, 0.89] } },
            { id: 'boots', name: 'Hiking boots', note: 'Leather and mesh', price: 160, pos: [-0.080, 0.076, 0.050], normal: [0, 0.3, 1], focus: { y: [-0.05, 0.13] } },
            { of: 'jacket', name: 'Stowable hood', note: 'Rolls into the collar', pos: [0.0, 1.580, -0.190], normal: [0, 0.2, -1], focus: { r: 0.17 } }
        ]
    }
};

export const figureOrder = ['casual_01', 'casual_02', 'outdoor_01'];
