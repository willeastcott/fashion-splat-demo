import {
    AppBase,
    AppOptions,
    CameraComponentSystem,
    ContainerHandler,
    Entity,
    FILLMODE_FILL_WINDOW,
    GSplatComponentSystem,
    GSplatHandler,
    LightComponentSystem,
    Mouse,
    RESOLUTION_AUTO,
    RenderComponentSystem,
    ScriptComponentSystem,
    ScriptHandler,
    TextureHandler,
    TouchDevice,
    Vec2,
    Vec3,
    createGraphicsDevice
} from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';

import { Callouts } from './callouts.js';
import { Closeup } from './closeup.js';
import { Director } from './director.js';
import { figureOrder, figures } from './figures.js';
import { Morph } from './morph.js';
import { rigGLSL, rigWGSL } from './rig-shader.js';
import { Rig } from './rig.js';
import { Shop } from './shop.js';
import { Stage } from './stage.js';

const params = new URLSearchParams(location.search);
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('app'));
const status = document.getElementById('status');
const statusNote = status.querySelector('.note');
const statusBar = /** @type {HTMLElement} */ (status.querySelector('.bar i'));

// ?debug shows what the page is running on, how fast, and anything that has gone wrong: for
// checking a phone or any device a console cannot be attached to
const debug = params.has('debug') ? document.createElement('pre') : null;
const problems = [];
if (debug) {
    debug.id = 'debug';
    document.body.appendChild(debug);
    debug.textContent = 'starting…';
    const note = (text) => {
        if (problems.length < 4) problems.push(String(text).slice(0, 160));
    };
    window.addEventListener('error', e => note(e.message));
    window.addEventListener('unhandledrejection', e => note(e.reason?.message ?? e.reason));
}

// something a visitor can act on, rather than a blank page
const fail = (message, err) => {
    if (debug) debug.textContent = `failed: ${err?.message ?? err}`;
    status.classList.add('failed');
    statusNote.textContent = message;
    throw err;
};

// WebGPU sorts on the GPU, is about twice as fast, and is the only path with bloom. It has been
// run through all three WebGPU implementations on a desktop (Chrome's, Firefox's and Safari's)
// and through Safari's on an iPhone 14 Pro, so it is tried first everywhere, with WebGL2 behind
// it. No Android phone has been tried.
const deviceTypes = params.get('device') ? [params.get('device')] : ['webgpu', 'webgl2'];

let device;
try {
    device = await createGraphicsDevice(canvas, {
        deviceTypes,
        // gaussian splats do not benefit from MSAA
        antialias: false
    });
} catch (err) {
    fail('This browser cannot show 3D graphics. Try a recent version of Chrome, Edge or Safari.', err);
}
device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

// The outfits are not kept in memory once they are on the GPU (see Morph.loadOutfit), so a lost
// graphics context cannot be refilled: start again instead. Phones drop the context of a page
// that has been in the background.
device.on('devicerestored', () => location.reload());

const createOptions = new AppOptions();
createOptions.graphicsDevice = device;
createOptions.mouse = new Mouse(canvas);
createOptions.touch = new TouchDevice(canvas);
createOptions.componentSystems = [
    RenderComponentSystem,
    CameraComponentSystem,
    LightComponentSystem,
    ScriptComponentSystem,
    GSplatComponentSystem
];
createOptions.resourceHandlers = [TextureHandler, ContainerHandler, ScriptHandler, GSplatHandler];

const app = new AppBase(canvas);
app.init(createOptions);
app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
app.setCanvasResolution(RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());

// ---- outfits -------------------------------------------------------------------------------
const defs = figureOrder.map(name => figures[name]);
// The same three outfits come in several packs: "lite" (500k gaussians each), "standard" (1M
// each) and "full" (every captured gaussian, about 2.9M each). Lite and standard keep the
// captures' view-dependent colour (spherical harmonics); full does not, and "sh" is full with
// it, built locally (see the README).
// Standard is the default. An iPhone 14 Pro runs it at about 48 frames a second on WebGPU,
// but WebGL2 was half as fast there, so a phone without WebGPU gets lite.
const TIERS = { lite: 'morph-500k', standard: 'morph-1m', full: 'morph', sh: 'morph-sh' };
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
const wanted = params.get('detail') in TIERS ? params.get('detail') : (phone && !device.isWebGPU ? 'lite' : 'standard');
// if the wanted pack has not been built, use the nearest one that has
const fallbacks = { lite: ['lite', 'standard', 'full'], standard: ['standard', 'lite', 'full'], full: ['full', 'standard', 'lite'], sh: ['sh', 'full', 'standard', 'lite'] };
// relative to wherever the app is hosted, so it also works from a sub-folder of a site
const base = import.meta.env.BASE_URL;

// The pieces that are given as a band of heights (see src/figures.js). Each outfit is measured
// within its bands as it loads, so that the camera can frame a piece by what is really there.
const bands = defs.map(def => def.callouts.map(callout => callout.focus?.y ?? null));

// only the first outfit is fetched before the app starts; the others follow in the background
let morph;
let loadedTier = '';
for (const tier of fallbacks[wanted]) {
    try {
        morph = await Morph.load(device, `${base}${TIERS[tier]}`, figureOrder, (p) => {
            statusBar.style.width = `${Math.round(p * 100)}%`;
        }, bands);
        loadedTier = tier;
        break;
    } catch (err) {
        console.warn(err.message);
    }
}
if (!morph) {
    // for a developer: the packs are built with `npm run data`
    fail('The outfits could not be loaded. Check your connection and reload the page.', new Error('no outfit pack found'));
}
status.remove();
document.body.classList.remove('loading');
app.start();

const figure = new Entity('figure');
figure.addComponent('gsplat', { resource: morph.container });
app.root.addChild(figure);
morph.attach(figure.gsplat);
// with view-dependent colour, the colours are worked out again each time the camera has moved
// this many degrees round the figure; ?sh=0 shows the same pack with the base colour alone
if (morph.sh) {
    app.scene.gsplat.colorUpdateAngle = 2;
    if (params.get('sh') === '0') morph.viewColour = 0;
}

// ---- camera --------------------------------------------------------------------------------
// A tall, narrow window (a phone held upright) stands the camera further back and aims it
// lower, which leaves room beside the figure for the callouts and under it for the buttons.
const framing = () => (window.innerWidth / window.innerHeight < 0.75 ? { distance: 6.3, height: 0.86 } : { distance: 4.6, height: 0.98 });
let frame = framing();
const PIVOT = new Vec3(0, frame.height, 0);
const camera = new Entity('camera');
camera.addComponent('camera', {
    fov: 28,
    nearClip: 0.1,
    farClip: 50
});
camera.setLocalEulerAngles(-4, 18, 0);
camera.setLocalPosition(camera.forward.clone().mulScalar(-frame.distance).add(PIVOT));
app.root.addChild(camera);
camera.addComponent('script');
const controls = camera.script.create(CameraControls, {
    properties: {
        enableFly: false,
        focusPoint: PIVOT,
        // stops short of taking the camera under the floor
        pitchRange: new Vec2(-60, 5),
        zoomRange: new Vec2(0.8, 9)
    }
});

// ---- studio: floor, shadows, bloom ----------------------------------------------------------
const stage = new Stage(app, camera);
// where the effects cannot run, the page's own vignette stands in for theirs
document.body.classList.toggle('plain', !stage.capable);

// ---- rig -----------------------------------------------------------------------------------
const rig = new Rig(defs[0]);
const material = app.scene.gsplat.material;
material.getShaderChunks('glsl').set('gsplatModifyVS', rigGLSL);
material.getShaderChunks('wgsl').set('gsplatModifyVS', rigWGSL);

// ---- ui ------------------------------------------------------------------------------------
const el = id => /** @type {HTMLInputElement} */ (document.getElementById(id));
const ui = {
    attract: el('attract'),
    present: el('present'),
    effects: el('effects'),
    cycle: el('cycle'),
    spin: el('spin'),
    labels: el('labels'),
    idle: el('idle'),
    follow: el('follow'),
    weights: el('weights'),
    zoom: el('zoom'),
    intensity: el('intensity'),
    intensityValue: document.getElementById('intensityValue'),
    outfits: document.getElementById('outfits')
};
// ?attract=0 keeps the demo still until it is touched, for embedding or for a fixed view
if (params.get('attract') === '0') ui.attract.checked = false;
// ?effects=0 starts with bloom and the vignette off
if (params.get('effects') === '0') ui.effects.checked = false;
ui.intensity.addEventListener('input', () => {
    ui.intensityValue.textContent = Number(ui.intensity.value).toFixed(1);
});

// change outfit; the figure turns once on the spot as it does, if that is switched on
let spinning = false;
const change = (i) => {
    if (morph.morphTo(i)) spinning = ui.spin.checked;
};

const buttons = defs.map((def, i) => {
    const button = document.createElement('button');
    button.textContent = def.label;
    button.addEventListener('click', () => change(i));
    ui.outfits.appendChild(button);
    return button;
});
const markActive = () => {
    const shown = morph.busy ? morph.to : morph.from;
    buttons.forEach((b, i) => b.classList.toggle('active', i === shown));
};
markActive();

// when the last of the outfits had arrived (or failed to), or 0 while they are still coming
let loaded = 0;
// fetch the remaining outfits one at a time; each button fills as its outfit arrives
buttons.forEach((b, i) => b.classList.toggle('waiting', !morph.ready[i]));
(async () => {
    for (let i = 0; i < defs.length; i++) {
        if (morph.ready[i]) continue;
        const button = buttons[i];
        try {
            await morph.loadOutfit(i, p => button.style.setProperty('--loaded', `${Math.round(p * 100)}%`));
            button.classList.remove('waiting');
        } catch (err) {
            console.error(err);
            button.classList.add('failed');
            button.title = 'This outfit could not be loaded';
        }
    }
    loaded = performance.now();
})();

// ---- shopping layer ------------------------------------------------------------------------
const formatPrice = n => `£${n}`;
const shop = new Shop(defs, formatPrice);
const callouts = new Callouts(
    document.getElementById('overlay'),
    defs,
    formatPrice,
    ['look', 'buy', 'bag', 'panel', 'outfits', 'credit'].map(id => document.getElementById(id))
);

// ---- presentation mode ---------------------------------------------------------------------
// picking a piece brings the camera in to it; see src/closeup.js
const closeup = new Closeup({ camera, controls, pivot: PIVOT, aspect: () => canvas.width / canvas.height });
// what it needs to know of each figure: how tall it stands, and the room each piece takes up
const bodies = defs.map((def, i) => ({
    top: morph.meta.figures[figureOrder[i]].topY,
    box: callout => morph.extents[i]?.[def.callouts.indexOf(callout)] ?? null
}));
const director = new Director({ camera, controls, pivot: PIVOT, callouts, closeup, bodies, morph, change, defs });
director.distance = frame.distance - 0.05;
const hint = document.getElementById('hint');

// re-frame when the window changes between upright and wide (a phone being turned)
window.addEventListener('resize', () => {
    const next = framing();
    if (next.distance === frame.distance) return;
    frame = next;
    PIVOT.y = frame.height;
    director.distance = frame.distance - 0.05;
    if (!director.active) {
        // let go of any piece that was picked: the controls have the camera wherever it is
        closeup.cancel();
        callouts.pinned = -1;
        const back = camera.forward.clone().mulScalar(-frame.distance).add(PIVOT);
        controls.reset(PIVOT, back);
    }
});

// Until someone touches it the demo runs itself, so a visitor sees the camera move, the pieces
// picked out and the outfit change without having to find a button. Any input hands control
// over at once, and it starts again after a quiet spell. Presentation mode is the same show
// with the developer controls and the pointer hidden, for recording.
const QUIET_BEFORE_SHOW = 30;       // seconds without input before it runs itself again
let quiet = QUIET_BEFORE_SHOW;      // seconds since the last input; starts ready to run
let presenting = false;

const onInput = () => {
    quiet = 0;
    if (director.active && !presenting) director.stop();
};
for (const type of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
}
// moving the pointer shows someone is there, but is not a reason to stop the show
window.addEventListener('pointermove', () => {
    if (!director.active) quiet = 0;
}, { passive: true });

const setPresenting = (on) => {
    presenting = on;
    quiet = 0;
    ui.present.checked = on;
    document.body.classList.toggle('presenting', on);
    if (on) {
        director.start();
        // the controls are hidden while presenting, so say how to get back
        hint.classList.add('show');
        setTimeout(() => hint.classList.remove('show'), 2600);
    } else {
        director.stop();
        hint.classList.remove('show');
    }
};
ui.present.addEventListener('change', () => setPresenting(ui.present.checked));
window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
    if (e.key === 'p' || e.key === 'P') setPresenting(!presenting);
    if (e.key === 'Escape' && presenting) setPresenting(false);
    // otherwise Esc lets go of a piece that was picked, like a click on the scene
    else if (e.key === 'Escape') callouts.pinned = -1;
});
// A tap or click on the scene lets go of a piece that was picked. A drag does not: that is the
// viewer looking round the piece the camera has come in to.
let press = null;
canvas.addEventListener('pointerdown', (e) => {
    // a tap or click on the scene leaves presentation mode, since a phone has no keys
    if (presenting) setPresenting(false);
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
});
canvas.addEventListener('pointerup', (e) => {
    if (!press || press.id !== e.pointerId) return;
    const tap = Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8 && performance.now() - press.at < 500;
    press = null;
    if (tap) callouts.pinned = -1;
});
if (params.has('present')) setPresenting(true);

// ---- frame ---------------------------------------------------------------------------------
const cameraPos = new Vec3();
let restTime = 0;
// seconds of slow frames and of fast ones lately, for adjusting the resolution (see below)
let slow = 0;
let fast = 0;
let raised = false;         // whether the last change to the resolution was upward
let raiseAfter = 20;        // seconds of fast frames before trying a higher resolution
const fullRatio = device.maxPixelRatio;
const meter = { frames: 0, since: performance.now(), fps: 0, worst: Infinity };
app.on('update', (dt) => {
    if (debug) {
        meter.frames++;
        const now = performance.now();
        if (now - meter.since >= 1000) {
            meter.fps = Math.round(meter.frames * 1000 / (now - meter.since));
            // the lowest rate is for judging a device by, so it leaves out the stalls while
            // the outfits are still arriving and being unpacked, and any time spent hidden
            if (loaded && now - loaded > 3000 && !document.hidden) meter.worst = Math.min(meter.worst, meter.fps);
            meter.frames = 0;
            meter.since = now;
            debug.textContent = [
                `renderer  ${device.deviceType}${device.isWebGPU ? '' : navigator.gpu ? (deviceTypes.includes('webgpu') ? ' (WebGPU failed to start)' : '') : ' (no WebGPU here)'}`,
                `pack      ${loadedTier}, ${morph.count.toLocaleString()} slots${morph.sh ? `, view-dependent colour ${morph.viewColour ? 'on' : 'off'}` : ''}`,
                `outfits   ${morph.ready.filter(Boolean).length} of ${morph.ready.length} loaded`,
                `canvas    ${canvas.width}x${canvas.height} at ${device.maxPixelRatio.toFixed(2)}x`,
                `effects   ${stage.effects ? 'bloom and vignette on' : stage.capable ? 'off' : 'off on WebGL2, to keep colours true'}`,
                `fps       ${meter.fps} (lowest ${Number.isFinite(meter.worst) ? meter.worst : 'not measured yet'})${morph.busy ? ' morphing' : ''}`,
                `problems  ${problems.length ? problems.join(' | ') : 'none'}`
            ].join('\n');
        }
    }

    // run the show when nobody has touched anything for a while
    quiet += dt;
    if (!director.active && ui.attract.checked && quiet >= QUIET_BEFORE_SHOW && !morph.busy) director.start();

    // optional slideshow: hold each outfit for a few seconds
    if (morph.busy) {
        restTime = 0;
    } else {
        restTime += dt;
        if (ui.cycle.checked && !director.active && restTime > 5) change(morph.nextReady(morph.from));
    }
    director.update(dt);

    // a piece picked by hand brings the camera in; the show goes in to pieces too, but moves
    // the camera itself
    closeup.enabled = ui.zoom.checked;
    if (director.active) {
        closeup.cancel();
    } else {
        const picked = callouts.pinned >= 0 && !morph.busy ? callouts.slots[callouts.pinned].def : null;
        closeup.follow(picked, bodies[morph.from]);
        closeup.update(dt);
    }

    // A device that cannot keep up renders at a lower resolution, a step at a time. What
    // slowed it may pass (a close-up fills more of the screen than the whole figure does), so
    // after a good spell of fast frames it tries a step back up. If that turns out too much
    // and it has to come down again, it waits twice as long before the next try, so it does
    // not go on switching back and forth.
    if (!morph.busy && !document.hidden) {
        slow = dt > 1 / 28 ? slow + dt : Math.max(0, slow - dt);
        fast = dt < 1 / 45 ? fast + dt : Math.max(0, fast - 4 * dt);
        if (slow > 3 && device.maxPixelRatio > 1) {
            device.maxPixelRatio = Math.max(1, device.maxPixelRatio * 0.8);
            app.resizeCanvas();
            if (raised) raiseAfter *= 2;
            raised = false;
            slow = fast = 0;
        } else if (fast > raiseAfter && device.maxPixelRatio < fullRatio) {
            device.maxPixelRatio = Math.min(fullRatio, device.maxPixelRatio * 1.25);
            app.resizeCanvas();
            raised = true;
            slow = fast = 0;
        }
    }

    morph.update(dt);
    markActive();

    // optional: one full turn on the spot over the morph. It ends where it began, so the
    // figure is back at rest when the morph is.
    const turning = spinning && morph.busy;
    figure.setLocalEulerAngles(0, turning ? -360 * morph.blend : 0, 0);

    // every figure has its own proportions, so the rig's rest pose follows the morph
    rig.setPose(defs[morph.from], defs[morph.to], morph.blend);

    rig.rigInv.copy(figure.getWorldTransform()).invert();
    rig.rigInv.transformPoint(camera.getPosition(), cameraPos);
    morph.setView(cameraPos);
    rig.update(dt, {
        idle: ui.idle.checked,
        intensity: Number(ui.intensity.value),
        // the head faces forward while the figure turns
        follow: ui.follow.checked && !turning,
        cameraPos
    });
    rig.apply(material, figure, ui.weights.checked, true);

    // callouts are skinned on the CPU with the pose just computed, so they stay on the body
    // they step aside while the figure turns, and come back on the new outfit
    callouts.enabled = ui.labels.checked && !turning;
    callouts.update(dt, { camera, figure, rig, morph });
    shop.update(morph);

    stage.effects = ui.effects.checked;
    stage.update({ figure, rig, morph });

    material.update();
});

// handy for poking at things from the console
window.demo = { app, camera, figure, rig, morph, material, device, callouts, shop, change, stage, director, closeup };
