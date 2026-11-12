// Render a share clip of the demo running itself, frame by frame, so it plays back evenly
// whatever the machine could manage live.
//
//   npm run dev                                   (in another terminal: the page to film)
//   node tools/capture-video.mjs                  landscape, 1920x1080  -> media/clip-landscape.mp4
//   node tools/capture-video.mjs --shape=vertical portrait, 1080x1920   -> media/clip-vertical.mp4
//
// Options: --detail=sh|full|standard|lite (default sh, which needs public/morph-sh; see the
// README), --fps=60, --crf=14, --out=<file>, --url=<page>, --dry (step through the clip without
// filming it and print its timeline), --test (film two frames to check the capture is live),
// --seconds=<n> (stop early, for a quick look).
//
// How it works. The page is opened in headless Chrome, with the GPU, in presentation mode.
// Its clock is taken away: requestAnimationFrame is swallowed, and the app is stepped by hand
// one sixtieth of a second at a time. Timers and CSS animations in the page run on that same
// stepped clock, so labels and the look's name move in step with the picture. After each step
// the whole page (canvas and labels together, as a visitor sees it) is photographed and piped
// to ffmpeg. Needs Chrome and ffmpeg.
//
// The clip: the first outfit for a second, then a change of outfit straight away (the part
// worth stopping for), then the show as it runs: in to each piece, back out, on to the next
// outfit, and round to the first again, where it ends.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { install as installEdit } from './social-edit.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
    const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return fallback;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

const shape = arg('shape', 'landscape');
const fps = Number(arg('fps', 60));
const crf = Number(arg('crf', 14));
const detail = arg('detail', 'sh');
const dry = arg('dry', false);
const test = arg('test', false);
// --edit=social films the directed cut in tools/social-edit.mjs instead of the show as it runs;
// --music=<file> lays a track under it (--music-offset=<s> skips into the track, to put a beat
// on the first frame); --stills=<folder> photographs the start, middle and end of each shot
// of the cut instead of filming it, for a look at the framing
const edit = arg('edit', false);
const music = arg('music', false);
const musicOffset = Number(arg('music-offset', 0));
const stills = arg('stills', false);
const url = arg('url', `http://localhost:5183/?detail=${detail}&${edit ? 'attract=0' : 'present'}`);
const out = join(root, arg('out', edit ? `media/clip-${edit}.mp4` : `media/clip-${shape}.mp4`));

// the page is laid out at these CSS sizes and photographed at the scale that makes 1080p: the
// vertical one is the phone layout at twice its size
const shapes = {
    landscape: { width: 1280, height: 720, deviceScaleFactor: 1.5 },
    vertical: { width: 540, height: 960, deviceScaleFactor: 2 }
};
const viewport = shapes[shape];
if (!viewport) throw new Error(`--shape is landscape or vertical, not ${shape}`);

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(existsSync);
if (!CHROME) throw new Error('could not find Chrome');

const OPENING = 1.0;        // seconds of the first outfit before the first change
const ENDING = 1.0;         // seconds of the first outfit again at the end
const LIMIT = Number(arg('seconds', 90));     // stop after this many seconds of clip, come what may

const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: viewport,
    protocolTimeout: 600000,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--use-angle=d3d11', '--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio']
});

let ffmpeg = null;
try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`[page error] ${e.message}`));
    page.on('console', (m) => {
        if (m.type() === 'error') console.log(`[page] ${m.text()}`);
    });

    // take the page's clock away before any of its own code runs
    await page.evaluateOnNewDocument(() => {
        window.__raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = () => 0;
    });
    await page.goto(url, { waitUntil: 'load' });
    // (polled on a timer: the default polls on requestAnimationFrame, which is no longer there)
    await page.waitForFunction(() => window.demo && window.demo.morph.ready.every(Boolean), { timeout: 180000, polling: 200 });
    // the note that says how to leave presentation mode is for a person at the keyboard
    await page.addStyleTag({ content: '#hint { display: none !important; }' });

    const about = await page.evaluate((fps) => {
        const { app, morph, device } = window.demo;
        // work the view-dependent colour out afresh every frame: stepped every couple of
        // degrees, as it is live, it shows in a recording as a faint pop
        app.scene.gsplat.colorUpdateAngle = 0;

        // timers run on the clip's clock from here on
        let clock = 0;
        let next = 1;
        const timers = new Map();
        window.setTimeout = (fn, ms = 0, ...args) => {
            timers.set(next, { at: clock + ms, fn, args });
            return next++;
        };
        window.clearTimeout = id => timers.delete(id);

        const dt = 1000 / fps;
        let stamp = performance.now();
        const seen = new WeakMap();
        const advance = () => {
            clock += dt;
            for (const [id, timer] of [...timers]) {
                if (timer.at > clock) continue;
                timers.delete(id);
                timer.fn(...timer.args);
            }
            stamp += dt;
            app.tick(stamp);
            // CSS animations and transitions: hold each one, and move it on by hand
            for (const anim of document.getAnimations()) {
                if (!seen.has(anim)) {
                    anim.pause();
                    seen.set(anim, Number(anim.currentTime) || 0);
                } else {
                    const at = seen.get(anim) + dt;
                    seen.set(anim, at);
                    anim.currentTime = at;
                }
            }
        };
        const state = () => {
            const { director } = window.demo;
            return { outfit: morph.from, changing: morph.busy, piece: director.aimed >= 0 ? director.last.def.name : null };
        };
        window.__clip = {
            // one frame of the clip, drawn inside a real animation frame; resolves once the
            // browser has had a further frame in which to put it on screen
            step: frame => new Promise((resolve) => {
                window.__raf(() => {
                    window.__direct?.(frame);
                    advance();
                    window.__raf(() => resolve(state()));
                });
            }),
            // the same without waiting to be seen, for stepping through quickly
            skip: (frame) => {
                window.__direct?.(frame);
                advance();
                return state();
            }
        };
        return { renderer: device.deviceType, slots: morph.count, canvas: `${device.canvas.width}x${device.canvas.height}`, viewColour: !!morph.sh };
    }, fps);
    console.log(`${about.renderer}, ${about.slots.toLocaleString()} slots, canvas ${about.canvas}, view-dependent colour ${about.viewColour ? 'on' : 'off'}`);
    if (about.renderer !== 'webgpu') console.log('warning: not on WebGPU, so no bloom, and the sort lags the camera');
    const logo = `data:image/png;base64,${readFileSync(join(root, 'tools/brand/playcanvas-logo.png')).toString('base64')}`;
    const cut = edit ? await page.evaluate(installEdit, fps, logo) : null;

    if (test) {
        // is a photograph taken straight after a step the frame that step drew?
        for (let i = 0; i < 90; i++) await page.evaluate(() => window.__clip.skip());
        await page.evaluate(() => window.__clip.step());
        const a = await page.screenshot({ type: 'png' });
        const b = await page.screenshot({ type: 'png' });
        await page.evaluate(() => window.__clip.step());
        const c = await page.screenshot({ type: 'png' });
        console.log(`same frame photographed twice: ${a.equals(b) ? 'identical (good)' : 'DIFFERENT (the first was stale)'}`);
        console.log(`next frame: ${a.equals(c) ? 'IDENTICAL (nothing moved)' : 'different (good)'}`);
    } else if (stills) {
        // a look at the cut: the first, middle and last frame of each shot
        mkdirSync(stills, { recursive: true });
        const wanted = new Map();
        cut.shots.forEach(([t0, t1], i) => {
            const a = Math.round(t0 * fps), b = Math.round(t1 * fps) - 1;
            wanted.set(a, `${String(i + 1).padStart(2, '0')}a`);
            wanted.set(Math.round((a + b) / 2), `${String(i + 1).padStart(2, '0')}b`);
            wanted.set(b, `${String(i + 1).padStart(2, '0')}c`);
        });
        for (let frame = 0; frame < cut.seconds * fps; frame++) {
            if (wanted.has(frame)) {
                await page.evaluate(f => window.__clip.step(f), frame);
                writeFileSync(join(stills, `shot-${wanted.get(frame)}.png`), await page.screenshot({ type: 'png' }));
            } else {
                await page.evaluate(f => window.__clip.skip(f), frame);
            }
        }
        console.log(`wrote ${wanted.size} stills to ${stills}`);
    } else {
        if (!dry) {
            mkdirSync(dirname(out), { recursive: true });
            ffmpeg = spawn('ffmpeg', [
                '-y', '-loglevel', 'error',
                '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
                '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p',
                // a low crf and aq-mode 3 keep the dark backdrop from banding; the sites this is
                // posted to encode it again, so it is better over-fed than under
                '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-x264-params', 'aq-mode=3',
                '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
                '-movflags', '+faststart', music ? `${out}.picture.mp4` : out
            ], { stdio: ['pipe', 'inherit', 'inherit'] });
        }

        const started = Date.now();
        let frame = 0, left = false, endAt = Infinity, last = '';
        if (cut) endAt = Math.round(cut.seconds * fps);
        while (frame < endAt && frame < LIMIT * fps) {
            // the show as it runs: the first change of outfit comes early, and it makes the rest
            if (!cut && frame === Math.round(OPENING * fps)) await page.evaluate(() => window.demo.change(1));
            const s = await page.evaluate(dry ? f => window.__clip.skip(f) : f => window.__clip.step(f), frame);
            if (!dry) {
                const shot = await page.screenshot({ type: 'png', optimizeForSpeed: true });
                if (!ffmpeg.stdin.write(shot)) await new Promise(r => ffmpeg.stdin.once('drain', r));
            }
            frame++;

            const now = `outfit ${s.outfit + 1}${s.changing ? ' changing' : ''}, ${s.piece ?? 'whole figure'}`;
            if (now !== last) console.log(`${(frame / fps).toFixed(2)}s  ${now}`);
            last = now;
            if (s.outfit !== 0) left = true;
            // back on the first outfit: hold it a moment, and stop before the show goes in again
            if (!cut && left && s.outfit === 0 && !s.changing && endAt === Infinity) endAt = frame + Math.round(ENDING * fps);
            if (!dry && frame % 120 === 0) {
                const per = (Date.now() - started) / frame;
                console.log(`   frame ${frame}, ${(per / 1000).toFixed(2)} s a frame`);
            }
        }
        console.log(`${frame} frames, ${(frame / fps).toFixed(2)} s of clip, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
        if (ffmpeg) {
            ffmpeg.stdin.end();
            await new Promise(r => ffmpeg.once('close', r));
            if (music) {
                // the track under the picture, faded out over the last two seconds and brought
                // to the loudness that video sites play at
                const length = frame / fps;
                const mixed = spawnSync('ffmpeg', [
                    '-y', '-loglevel', 'error', '-i', `${out}.picture.mp4`, '-ss', String(musicOffset), '-i', music,
                    '-filter:a', `atrim=0:${length},afade=t=in:d=0.03,afade=t=out:st=${(length - 2.2).toFixed(2)}:d=2.2,loudnorm=I=-14:TP=-1.5:LRA=11`,
                    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', `${out}.mixed.mp4`
                ], { stdio: 'inherit' });
                if (mixed.status !== 0) throw new Error('could not lay the music under the picture');
                rmSync(out, { force: true });
                renameSync(`${out}.mixed.mp4`, out);
                rmSync(`${out}.picture.mp4`, { force: true });
            }
            console.log(`wrote ${out}`);
        }
    }
} finally {
    if (ffmpeg && !ffmpeg.killed && ffmpeg.exitCode === null) ffmpeg.stdin.destroy();
    await browser.close();
}
