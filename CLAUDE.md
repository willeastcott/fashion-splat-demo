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
  than by eye. The phone pack (500k gaussians) was accepted because at phone size it is
  indistinguishable from the standard one.
- **Morph style.** A fast-spinning ring of white threads with a full turn of the figure was
  tried and rejected. The current morph (two waves with a band of dots between them, after the
  engine's `scripts/esm/gsplat/reveal-*.mjs` effects) was accepted. The turn is still available
  under Controls but is off by default.
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
| `tools/build-morph.mjs` | Pairs gaussians across outfits and writes the packs |
| `tools/anchor.mjs`, `tools/plot.mjs` | Find surface points for callouts; plot a capture to place joints |

## Working rules

- Every shader exists twice, GLSL and WGSL, and both must be kept in step: WebGPU is the main
  path and WebGL2 the fallback. Test both (`?device=webgl2`).
- `rigWeights` in `src/rig-shader.js` and `Rig.weights` in `src/rig.js` must stay identical, or
  the callouts drift off the body.
- The app and the tools both import `src/pack.js` and `src/figures.js`. Changing the pack format
  means bumping `PACK_VERSION` and rebuilding all three packs.
- The packs in `public/morph-*` are committed (about 145 MB). Rebuilding them needs the original
  captures in `raw/`, which are not in the repository; the README says where to get them. Avoid
  committing rebuilt packs unless they actually changed, since each commit adds their full size
  to the history.
- To judge the morph or any motion, freeze it: `demo.morph.duration = 1e9`, start a morph, then
  set `demo.morph.progress`. `window.demo` exposes the app's parts in the console.
- The dev server is `npm run dev` on port 5173 by default; `.claude/launch.json` starts it on
  5183 for the preview pane.
- Pushing to `main` publishes to GitHub Pages through `.github/workflows/deploy.yml`.

## Media

`public/social.jpg` is the link-preview image, `media/morph.gif` is the README animation, and
`media/clip-*.mp4` are share clips. They were rendered from the running app, frame by frame at
a fixed 30 fps, by freezing the app's clock (`app.timeScale = 0`), advancing it by hand
(`app.fire('update', 1 / 30)`) and compositing the canvas with the page's labels. Regenerate
them if the look of the demo changes noticeably.

## Known gaps

- Never run on a real phone. It has run in iOS 17 Safari in the Simulator (WebGL2, phone pack),
  which is how the WebGL2 effects problem was found. `?debug` shows renderer, pack, frame rate
  and errors on the page for checking a device by hand.
- WebGPU is only used in Chromium browsers (`chromium` in `src/main.js`). Safari's and
  Firefox's WebGPU have not been tested at all: no automation was available for Safari, and
  headless Firefox has no adapter. Test with `?device=webgpu`; if it works in both, remove the
  guard so they get the faster path and the bloom.
- On WebGL2 the splats are sorted on the CPU from rest positions, which is slower.
- On WebGL2 the post effects (`CameraFrame`) are deliberately off: rendering splats through the
  linear-light target washes out and speckles dark cloth there. WebGPU is unaffected. If the
  engine fixes this, `Stage.capable` in `src/stage.js` is the switch.
- View-dependent colour is dropped. It was measured at about 2.5% typical swing, so restoring it
  was judged not worth a larger download.
- Joints were placed by eye from plots.
- No licence has been chosen for the code.
