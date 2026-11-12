// The cut of the demo made for posting: tools/capture-video.mjs --edit=social films it.
//
// Where the plain clip records the show as it runs, this one is directed shot by shot: the
// camera is placed by hand on every frame, outfits change on cue, and captions and an end
// card are laid over the page. Cuts fall on whole seconds, which at the 120 beats a minute of
// the music are every second beat.
//
// `install` runs inside the page (it is handed to page.evaluate, so it can use nothing from
// this file; the PlayCanvas logo is handed in as a data URL). It returns the length of the cut
// and where its shots begin and end, and leaves window.__direct(frame), which the capture calls
// before it steps each frame.

export const SECONDS = 28;

export const install = async (fps, logo) => {
    const { camera, figure, rig, morph, callouts, change, closeup } = window.demo;
    const controls = camera.script.cameraControls;
    const { figures, figureOrder } = await import('/src/figures.js');
    const Vec3 = camera.getPosition().constructor;
    const Vec2 = controls.pitchRange.constructor;
    const $ = id => document.getElementById(id);

    // the camera goes where the viewer's controls would not let it: lower, and closer
    controls.pitchRange = new Vec2(-89, 89);
    controls.zoomRange = new Vec2(0.2, 30);
    // picking a piece only brightens its label here (the camera is placed by the shots), and
    // the head stays still, since a cut would send it swinging round after the camera
    $('zoom').checked = false;
    $('follow').checked = false;

    // ---- the page's furniture, and what is laid over it -----------------------------------
    const style = document.createElement('style');
    style.textContent = `
        #panel, #hint { display: none !important; }
        #caption, #title { position: fixed; left: 0; right: 0; text-align: center; pointer-events: none; opacity: 0; text-shadow: 0 2px 18px rgba(0, 0, 0, 0.85); }
        #caption { bottom: 84px; font-size: 21px; letter-spacing: 0.04em; }
        #caption.aside { text-align: left; left: 44px; }
        #caption span { display: inline-block; padding: 9px 22px; border-radius: 999px; background: rgba(13, 14, 16, 0.6); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
        /* in close on a piece, only its own label shows */
        body.solo .callout:not(.pick), body.solo svg.lines > g:not(.pick) { opacity: 0 !important; }
        #title { bottom: 84px; font: 400 52px/1.1 Didot, "Bodoni 72", "Playfair Display", "Times New Roman", serif; letter-spacing: 0.01em; }
        #endcard { position: fixed; inset: 0; z-index: 20; display: grid; place-content: center; justify-items: center; gap: 14px; text-align: center; opacity: 0; pointer-events: none; background: rgba(13, 14, 16, 0.9); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
        #endcard img { width: 92px; height: 92px; border-radius: 20px; margin-bottom: 10px; box-shadow: 0 10px 40px rgba(240, 96, 48, 0.35); }
        #endcard .eyebrow { font-size: 15px; font-weight: 600; letter-spacing: 0.24em; text-transform: uppercase; }
        /* who made it, in the corner all the way through */
        #madewith { position: fixed; top: 20px; right: 24px; display: flex; align-items: center; gap: 12px; font-size: 17px; letter-spacing: 0.02em; opacity: 0; pointer-events: none; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.8); }
        #madewith img { width: 40px; height: 40px; border-radius: 9px; }
        #madewith b { font-weight: 600; }
        #endcard h2 { margin: 0; font: 400 62px/1.1 Didot, "Bodoni 72", "Playfair Display", "Times New Roman", serif; letter-spacing: 0.01em; }
        #endcard .url { margin-top: 10px; padding: 9px 22px; border-radius: 999px; border: 1px solid rgba(232, 230, 225, 0.4); font-size: 20px; letter-spacing: 0.02em; }
        #endcard .credit { margin-top: 18px; font-size: 13px; opacity: 0.6; }
    `;
    document.head.appendChild(style);
    const add = (id, html) => {
        const el = document.createElement('div');
        el.id = id;
        el.innerHTML = html;
        document.body.appendChild(el);
        return el;
    };
    const caption = add('caption', '<span></span>');
    const line = caption.firstChild;
    callouts.svg.classList.add('lines');
    const title = add('title', 'The future of clothes shopping');
    const endcard = add('endcard', `
        <img src="${logo}" alt="">
        <div class="eyebrow">Made with PlayCanvas</div>
        <h2>The Future of Clothes Shopping</h2>
        <div class="url">willeastcott.github.io/splat-fashion</div>
        <div class="credit">Gaussian splats on the PlayCanvas engine &nbsp;·&nbsp; Captures by Christoph Schindelar, CC BY 4.0</div>`);
    const madewith = add('madewith', `<img src="${logo}" alt=""><span>Made with <b>PlayCanvas</b></span>`);
    // labels keep clear of it, as they do of the page's own furniture
    callouts.avoid.push(madewith);
    // the sizes and the outfit buttons stay out of the way until the shot that is about them
    const shop = [$('buy'), $('outfits')];
    for (const el of shop) el.style.display = 'none';

    // ---- shots ----------------------------------------------------------------------------
    const even = u => u;
    const settle = u => 1 - (1 - u) ** 3;                               // quick away, gentle arrival
    const mix = (a, b, u) => a + (b - a) * u;
    const mix3 = (a, b, u) => [mix(a[0], b[0], u), mix(a[1], b[1], u), mix(a[2], b[2], u)];

    // where to look, and how far back to stand, for a piece: the app's own framing
    const body = o => ({
        top: morph.meta.figures[figureOrder[o]].topY,
        box: c => morph.extents[o]?.[figures[figureOrder[o]].callouts.indexOf(c)] ?? null
    });
    const piece = (o, k) => {
        const c = new Vec3();
        const d = closeup.frame(figures[figureOrder[o]].callouts[k], body(o), c);
        return { at: [c.x, c.y, c.z], d };
    };
    // a second on one piece: the camera easing in and drifting a few degrees round
    const detail = (t0, o, k, yaw, pitch, near = 1, turn = 7, lift = 0) => {
        const p = piece(o, k);
        const at = [p.at[0], p.at[1] + lift, p.at[2]];
        return { t0, t1: t0 + 1, pin: k, labels: 1, ease: settle, cam: u => ({ at, yaw: yaw + turn * u, pitch, dist: p.d * near * mix(1.12, 0.9, u) }) };
    };

    const fade = (t, from, to, len = 0.35) => Math.max(0, Math.min(1, (t - from) / len, (to - t) / len));
    const whole = [0, 0.98, 0];
    const raised = [0, 0.88, 0];                                        // the figure a little up the frame, clear of the shop's buttons
    const shots = [
        // the hook: in close on the hoodie as it turns into the shirt, pulling back and round
        { t0: 0, t1: 4, pin: -1, ease: settle, cam: u => ({ at: mix3([0, 1.3, 0], whole, u), yaw: mix(-30, 14, u), pitch: mix(-2, -5, u), dist: mix(1.7, 4.7, u) }) },
        // the second outfit, a piece a second
        detail(4, 1, 1, 14, -8, 0.82),              // sling bag
        detail(5, 1, 0, -24, -5),                   // camp shirt
        detail(6, 1, 2, 12, -3),                    // jeans
        detail(7, 1, 3, -30, -14, 0.9),             // shoes
        // right round the figure while it changes into the third
        { t0: 8, t1: 12, pin: -1, ease: even, cam: u => ({ at: whole, yaw: mix(30, 210, u), pitch: -6, dist: 4.5 }) },
        // the third outfit
        detail(12, 2, 0, -22, -4, 0.92),            // beanie
        detail(13, 2, 1, 18, -5),                   // shell jacket
        detail(14, 2, 2, -16, -3),                  // trousers
        detail(15, 2, 3, 26, -14, 0.9),             // boots
        // back to the first outfit, from low behind round to the front
        { t0: 16, t1: 20, pin: -1, ease: settle, cam: u => ({ at: mix3([0, 1.05, 0], raised, u), yaw: mix(-165, 16, u), pitch: mix(7, -4, u), dist: mix(3.1, 4.9, u) }) },
        // the shop: every piece labelled, sizes, the bag
        { t0: 20, t1: 24, pin: -1, labels: t => fade(t, 20.1, 99, 0.5), ease: even, cam: u => ({ at: raised, yaw: mix(16, 22, u), pitch: -4, dist: mix(4.9, 4.6, u) }) },
        // under the end card
        { t0: 24, t1: 28, pin: -1, labels: 1, ease: even, cam: u => ({ at: raised, yaw: mix(22, 28, u), pitch: -4, dist: mix(4.6, 4.3, u) }) }
    ];

    // ---- things that happen on cue --------------------------------------------------------
    const cues = [
        { t: 0.25, run: () => change(1) },
        { t: 8.15, run: () => change(2) },
        { t: 16.15, run: () => change(0) },
        { t: 20.2, run: () => shop.forEach((el) => { el.style.display = ''; el.style.opacity = '0'; }) },
        { t: 22.0, run: () => $('add').click() }
    ];
    // words on screen: [from, to, element, text, off to the left rather than centred]
    const words = [
        [0.9, 3.7, title, null],
        [4.25, 7.75, caption, 'Three real outfits, captured as Gaussian splats'],
        [8.3, 11.7, caption, 'One look morphs into the next'],
        [12.25, 15.75, caption, 'Every piece labelled, down to the boots'],
        [16.3, 19.7, caption, 'Orbit it. Zoom it. Change it.'],
        // the shop's buttons and the boots' label have the middle of the frame here
        [20.5, 23.6, caption, 'Live in your browser', true]
    ];

    const focus = new Vec3();
    let current = -1;
    window.__direct = (frame) => {
        const t = frame / fps;
        const index = shots.findIndex(s => t >= s.t0 && t < s.t1);
        const shot = shots[index < 0 ? shots.length - 1 : index];
        const cut = index !== current;
        current = index;

        for (const cue of cues) {
            if (!cue.done && t >= cue.t) {
                cue.done = true;
                cue.run();
            }
        }

        // the camera, and the viewer's controls kept in step with it (see src/closeup.js)
        const u = shot.ease(Math.min(1, (t - shot.t0) / (shot.t1 - shot.t0)));
        const c = shot.cam(u);
        const yaw = c.yaw * Math.PI / 180, pitch = c.pitch * Math.PI / 180;
        focus.set(c.at[0], c.at[1], c.at[2]);
        camera.setPosition(
            focus.x + Math.sin(yaw) * Math.cos(pitch) * c.dist,
            focus.y - Math.sin(pitch) * c.dist,
            focus.z + Math.cos(yaw) * Math.cos(pitch) * c.dist
        );
        camera.lookAt(focus);
        controls.focusPoint = focus;
        // the engine keeps the camera's view matrix from the last frame it drew until the next
        // one is drawn, so labels are placed a frame behind the camera: unseen in a move, but a
        // cut would show the last shot's labels over the new shot for a frame
        camera.camera.camera._viewMatDirty = true;
        camera.camera.camera._viewProjMatDirty = true;

        // labels: none over the wide shots, one in close on a piece, all of them in the shop
        const pin = morph.busy ? -1 : shot.pin;
        callouts.pinned = pin;
        document.body.classList.toggle('solo', pin >= 0);
        callouts.slots.forEach((slot, i) => {
            slot.el.classList.toggle('pick', i === pin);
            slot.g.classList.toggle('pick', i === pin);
        });
        const shown = typeof shot.labels === 'function' ? shot.labels(t) : (shot.labels ?? 0);
        callouts.root.style.opacity = shown.toFixed(3);
        if (cut) {
            // labels glide to their places and fade; across a cut they should simply be there
            for (let pass = 0; pass < 3; pass++) {
                for (const slot of callouts.slots) slot.snap = true;
                callouts.update(1, { camera, figure, rig, morph });
            }
        }

        // words, the shop's controls and the end card
        caption.style.opacity = '0';
        for (const [from, to, el, text, aside] of words) {
            const a = fade(t, from, to);
            if (el === title) {
                el.style.opacity = a.toFixed(3);
                el.style.transform = `translateY(${((1 - Math.min(1, (t - from) / 0.6)) * 14).toFixed(1)}px)`;
            } else if (a > 0) {
                line.textContent = text;
                caption.classList.toggle('aside', !!aside);
                el.style.opacity = a.toFixed(3);
            }
        }
        const open = fade(t, 20.2, 99, 0.5);
        for (const el of shop) if (el.style.display !== 'none') el.style.opacity = open.toFixed(3);
        madewith.style.opacity = fade(t, 1.0, 99, 0.6).toFixed(3);
        endcard.style.opacity = Math.max(0, Math.min(1, (t - 24.1) / 0.7)).toFixed(3);
    };

    return { seconds: shots[shots.length - 1].t1, shots: shots.map(s => [s.t0, s.t1]) };
};
