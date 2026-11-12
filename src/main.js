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

// something a visitor can act on, rather than a blank page
const fail = (message, err) => {
    status.classList.add('failed');
    statusNote.textContent = message;
    throw err;
};

let device;
try {
    device = await createGraphicsDevice(canvas, {
        // WebGPU sorts on the GPU and is close to twice as fast here; WebGL2 is the fallback
        deviceTypes: params.get('device') ? [params.get('device')] : ['webgpu', 'webgl2'],
        // gaussian splats do not benefit from MSAA
        antialias: false
    });
} catch (err) {
    fail('This browser cannot show 3D graphics. Try a recent version of Chrome, Edge or Safari.', err);
}
device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

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
// The same three outfits come in three packs: "lite" (500k gaussians each) for phones,
// "standard" (1M each) and "full" (every captured gaussian, about 2.9M each). A phone gets
// lite unless ?detail= says otherwise: on a small screen it still has more gaussians per pixel
// than standard has on a desktop, at half the download and memory.
const TIERS = { lite: 'morph-500k', standard: 'morph-1m', full: 'morph' };
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
const wanted = params.get('detail') in TIERS ? params.get('detail') : (phone ? 'lite' : 'standard');
// if the wanted pack has not been built, use the nearest one that has
const fallbacks = { lite: ['lite', 'standard', 'full'], standard: ['standard', 'lite', 'full'], full: ['full', 'standard', 'lite'] };
// relative to wherever the app is hosted, so it also works from a sub-folder of a site
const base = import.meta.env.BASE_URL;

// only the first outfit is fetched before the app starts; the others follow in the background
let morph;
for (const tier of fallbacks[wanted]) {
    try {
        morph = await Morph.load(device, `${base}${TIERS[tier]}`, figureOrder, (p) => {
            statusBar.style.width = `${Math.round(p * 100)}%`;
        });
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
    intensity: el('intensity'),
    intensityValue: document.getElementById('intensityValue'),
    outfits: document.getElementById('outfits')
};
// ?attract=0 keeps the demo still until it is touched, for embedding or for a fixed view
if (params.get('attract') === '0') ui.attract.checked = false;
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
})();

// ---- shopping layer ------------------------------------------------------------------------
const formatPrice = n => `£${n}`;
const shop = new Shop(defs, formatPrice);
const callouts = new Callouts(
    document.getElementById('overlay'),
    defs,
    formatPrice,
    ['look', 'buy', 'panel', 'outfits'].map(id => document.getElementById(id))
);

// ---- presentation mode ---------------------------------------------------------------------
const director = new Director({ camera, controls, pivot: PIVOT, callouts, morph, change, defs });
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
});
canvas.addEventListener('pointerdown', () => {
    // a tap or click on the scene leaves presentation mode, since a phone has no keys
    if (presenting) setPresenting(false);
    // and lets go of a piece that was tapped to keep it lit
    callouts.pinned = -1;
});
if (params.has('present')) setPresenting(true);

// ---- frame ---------------------------------------------------------------------------------
const cameraPos = new Vec3();
let restTime = 0;
let slow = 0;
app.on('update', (dt) => {
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

    // a device that cannot keep up renders at a lower resolution, a step at a time
    if (!morph.busy && !document.hidden) {
        slow = dt > 1 / 28 ? slow + dt : Math.max(0, slow - dt);
        if (slow > 3 && device.maxPixelRatio > 1) {
            device.maxPixelRatio = Math.max(1, device.maxPixelRatio * 0.8);
            app.resizeCanvas();
            slow = 0;
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
    callouts.applyFocus(material);
    shop.update(morph);

    stage.effects = ui.effects.checked;
    stage.update({ figure, rig, morph });

    material.update();
});

// handy for poking at things from the console
window.demo = { app, camera, figure, rig, morph, material, device, callouts, shop, change, stage, director };
