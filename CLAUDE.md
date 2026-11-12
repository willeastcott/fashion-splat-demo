# Project notes for Claude

A tech demo on the PlayCanvas engine: three captured outfits as Gaussian splats on one figure,
with a mesh-less rig, an idle animation, a morph between outfits and a shopping layer. The aim
is something people share: striking on first load, and interesting to graphics programmers.
The README explains how each part works; read it first.

## Constraints that have already been decided

- **The captures are hollow shells of different mannequins.** There are no gaussians for a body
  under the clothes, and the three figures do not share a body or pose. Do not propose effects
  that remove or peel clothing, or that assume a shared mannequin.
- **Arms and hands do not articulate separately from the torso.** The captures have shading
  baked in where the arms sit near the body, which would break. Arms take the torso's weights.
- **Visual quality comes first.** Do not trade visible quality for size or speed without asking.
  Prefer lossless or provably invisible changes, and check new data against old values rather
  than by eye. Dropping the captures' view-dependent colour (spherical harmonics) was tried and
  rejected by the owner: it leaves a brownish haze over black cloth. The lite and standard
  packs carry it; keep it.
- **Morph style.** A fast-spinning ring of white threads with a full turn of the figure was
  tried and rejected. The current morph (two waves with a band of dots between them, after the
  engine's `scripts/esm/gsplat/reveal-*.mjs` effects) was accepted. The turn is still available
  under Controls but is off by default.
- **No highlight on a piece.** Picking a piece used to dim the rest of the figure. It was
  removed at the owner's request because it could not isolate a garment: nothing in the
  captures says which garment a gaussian belongs to, so a piece is only a band of heights or a
  sphere, and the highlight spilled onto hands, hems and whatever was worn underneath. Do not
  bring it back without a garment label per gaussian. Picking a piece now brings the camera in
  to it instead (`src/closeup.js`), and the show does the same.
- **Credit.** The captures are CC BY 4.0 by Christoph Schindelar. Keep the credit visible in the
  app, in the share image and in the README.
- **Product names and prices are placeholders** and say so in the README. Do not present them as
  real.

## Map

| File | What it holds |
|---|---|
| `src/main.js` | App setup, pack choice, UI wiring, the frame loop, self-running and presentation modes |
| `src/figures.js` | Per-figure normalisation, rig joints, look names and callouts. Shared with the tools |
| `src/rig-shader.js`, `src/rig.js` | Skinning in the splat shader hooks, and the procedural idle |
| `src/morph.js` | The splat container holding all three outfits, the morph shader, pack loading |
| `src/pack.js` | The pack format and its decoder. Shared with the tools |
| `src/callouts.js`, `src/shop.js` | Labels that ride the rig; look header, sizes and bag |
| `src/stage.js` | Floor, contact shadows, bloom and vignette |
| `src/director.js` | The scripted camera and show used when the demo runs itself |
| `src/closeup.js` | Framing a piece, and the camera move in to a picked piece and back out |
| `tools/build-morph.mjs` | Pairs gaussians across outfits and writes the packs |
| `tools/anchor.mjs`, `tools/plot.mjs` | Find surface points for callouts; plot a capture to place joints |

## Working rules

- Every shader exists twice, GLSL and WGSL, and both must be kept in step: WebGPU is the main
  path and WebGL2 the fallback. Test both (`?device=webgl2`).
- `rigWeights` in `src/rig-shader.js` and `Rig.weights` in `src/rig.js` must stay identical, or
  the callouts drift off the body.
- The app and the tools both import `src/pack.js` and `src/figures.js`. Changing the pack format
  means bumping `PACK_VERSION` and rebuilding all three packs.
- The packs in `public/morph`, `public/morph-1m` and `public/morph-500k` are committed (about
  170 MB). `public/morph-sh` is ignored. Rebuilding them needs the original
  captures in `raw/`, which are not in the repository; the README says where to get them. Avoid
  committing rebuilt packs unless they actually changed, since each commit adds their full size
  to the history.
- Never switch the camera's `CameraControls` script off (`controls.enabled = false`) to move the
  camera yourself. It counts button presses against releases, and one made while it is off is
  lost: press during a scripted move, let go after it, and the count is left at -1, with the
  camera deaf to dragging until the page is reloaded. Leave it on and set `controls.focusPoint`
  every frame of the move, as `src/closeup.js` and `src/director.js` do; that keeps it holding
  the camera where you put it. Do not hand the camera back with `controls.reset` either: it
  eases in from the controls' own last pose.
- Camera moves ease on `ease`, `zoomed` and `panned` in `src/closeup.js`: no speed or
  acceleration at either end, distance changed by ratio, and the piece drifting evenly across
  the screen. Check a change to them by recording the camera frame by frame at a fixed step,
  not by eye.
- To judge the morph or any motion, freeze it: `demo.morph.duration = 1e9`, start a morph, then
  set `demo.morph.progress`. `window.demo` exposes the app's parts in the console.
- The dev server is `npm run dev` on port 5173 by default; `.claude/launch.json` starts it on
  5183 for the preview pane.
- Pushing to `main` publishes to GitHub Pages through `.github/workflows/deploy.yml`.

## Media

`public/social.jpg` is the link-preview image, `media/morph.gif` is the README animation, and
`media/clip-*.mp4` are share clips. Regenerate them if the look of the demo changes noticeably.

The clips are made by `tools/capture-video.mjs` (add `--shape=vertical` for the upright one),
with the dev server running. It opens the page in headless Chrome with the GPU, takes its clock
away, steps it a sixtieth of a second at a time, photographs the whole page after each step
and pipes the frames to ffmpeg. Timers and CSS animations run on the stepped clock too. It
films the full captures with view-dependent colour (`?detail=sh`), so it needs
`public/morph-sh`. About five minutes a clip. Each replaced clip adds its full size to the
history, so do not re-render them idly.

The image and the animation were rendered from the running app in the same spirit but by
hand: the app's clock frozen (`app.timeScale = 0`) and advanced a frame at a time
(`app.fire('update', 1 / 30)`), and the canvas composited with the page's labels.

## Known gaps

- Phones: measured on one iPhone 14 Pro (Safari, 12 Nov 2026). Standard with WebGPU runs at
  about 48 frames a second (lowest 32) at full resolution. Full with view-dependent colour
  (`?detail=sh`) loads but runs at 21 with WebGPU and 10 with WebGL2, both after the page had
  dropped to 1x resolution: the cost is the 4.9M slots, not pixels. Not measured: lite on a
  phone with WebGL2 (what a phone without WebGPU gets), any older iPhone, and any Android
  phone. `?debug` shows renderer, pack, frame rate and errors on the page for checking a device
  by hand.
- A close-up costs more to draw than the whole figure. The page lowers its resolution when
  frames run slow, and tries a step back up after 20 s of fast ones, doubling that wait each
  time it has to come down again (the frame loop in `src/main.js`). How a phone fares in
  close-ups has not been measured: `?debug` shows the resolution in use, and the lowest frame
  rate since the outfits finished loading.
- To try a phone locally: `npx vite build`, then
  `npx vite preview --config vite.lan.config.js --host --port 5185` serves `dist` over https with
  a self-signed certificate. Plain http on the network will not do for WebGPU, which browsers
  only offer to pages loaded securely.
- The outfit textures are released from page memory once they are on the GPU
  (`setReleaseSourceAfterUpload` in `Morph.loadOutfit`), and the page reloads if the graphics
  context is lost (`devicerestored` in `src/main.js`). Without this the engine keeps a second
  copy of every texture, about 500 MB at full detail, and the iPhone killed the tab when it was
  unlocked after sleeping.
- WebGPU is tried first everywhere. It has been checked on a Mac in Chrome, Firefox 156 and
  Safari 26 (rest and mid-morph frames match Chrome's), without view-dependent colour, and on
  the iPhone with it. The view-dependent colour's WGSL has only been run in Chrome on Windows
  and Safari on the iPhone: not yet in Firefox or in Safari on a Mac.
- How the browsers were checked without a person at the screen: headless Firefox has no WebGPU
  adapter, so Firefox was run with a window and a temporary profile and driven over its
  Marionette port; Safari's WebDriver was off, so a temporary page loaded the app in a frame,
  stepped it by hand and posted screenshots to a local receiver; iOS Safari ran in the
  Simulator.
- On WebGL2 the splats are sorted on the CPU from rest positions, which is slower.
- On WebGL2 the post effects (`CameraFrame`) are deliberately off: rendering splats through the
  linear-light target washes out and speckles dark cloth there. WebGPU is unaffected. If the
  engine fixes this, `Stage.capable` in `src/stage.js` is the switch.
- View-dependent colour (`--sh` in `tools/build-morph.mjs`, `morphSH` in `src/morph.js`) is a
  palette, not the captured coefficients: it is off from them by 27 to 39% rms, as SOG files
  are. The engine re-runs the colours as the camera moves because the container claims
  `shBands`. It ignores the rig's bone rotations, so the shading does not turn with the head.
  `?sh=0` switches it off. The committed full pack (`public/morph`) does not have it.
- A pack with view-dependent colour also keeps the part of each base colour outside 0..1,
  which the 8-bit store clips (a quarter of the hoodie's gaussians are a little over 1).
- `splat-transform`'s decimation is not bit-repeatable, so a rebuilt lite or standard pack
  differs slightly from the committed one even with nothing else changed.
- `public/social.jpg` and `media/morph.gif` were rendered before view-dependent colour was
  added and before the highlight was removed. They have not been regenerated, so the link
  preview and the README animation show the old look. The clips are current.
- Joints were placed by eye from plots.
- No licence has been chosen for the code.
