# The Future of Clothes Shopping

Three real outfits, captured as Gaussian splats, on one figure in your browser. The figure
breathes and shifts its weight, its head follows your camera, every piece is labelled, and one
outfit morphs into the next.

**[Open the live demo](https://willeastcott.github.io/splat-fashion/)**

![An outfit morphing into the next, with product callouts following the figure](media/morph.gif)

Built with the [PlayCanvas](https://playcanvas.com) engine. The captures are by
[Christoph Schindelar](https://superspl.at/user/schindelar3d).

## What to try

- **Leave it alone.** Until you touch it, the demo runs itself: the camera drifts, goes in to
  each piece in turn, pulls back, and the outfit changes.
- **Pick an outfit** with the buttons at the bottom.
- **Drag to orbit, scroll or pinch to zoom.** The head turns to follow you, and labels move to
  whichever side of the body their piece is on. Orbit behind for the back of each outfit.
- **Click or tap a label** and the camera comes in to frame that piece; drag to look round it,
  and click or tap anywhere else, or press Esc, to go back.
- **Open Controls** (bottom left, desktop only) for the idle strength, a view of the rig's bone
  weights, and presentation mode.
- **Press P** for presentation mode: the same self-running show with the controls and pointer
  hidden, for recording.

| Add to the address | Effect |
|---|---|
| `?detail=lite` / `standard` / `full` | 500k, 1M or about 2.9M gaussians per outfit. `standard` is the default; a phone without WebGPU gets `lite`. |
| `?sh=0` | Leave out the view-dependent colour (see below), to see what it adds. |
| `?detail=sh` | `full` with view-dependent colour, which `full` itself does not have. Needs the `public/morph-sh` pack, which is built locally and is not in the repository; see below. |
| `?device=webgl2` / `webgpu` | Force a renderer. |
| `?present` | Start in presentation mode. |
| `?attract=0` | Do not run by itself; stay still until touched. |
| `?debug` | Show the renderer, pack, frame rate and any errors on the page. Useful on a phone. |

It uses WebGPU where the browser has it, and WebGL2 otherwise; the picture is the same on
both. There are no post effects: bloom was tried, but the engine's post-effect path blends
splats in linear light, which turns black cloth grey and grainy.

Checked so far, on a Mac: WebGPU in Chrome, Firefox 156 and Safari 26; WebGL2 in Chrome and
Firefox; and Safari on iOS 17 in the Simulator (WebGL2, including touch and both
orientations). On a phone: Safari on an iPhone 14 Pro, WebGPU and WebGL2, where the standard
detail runs at about 48 frames a second on WebGPU. No Android phone has been tried.

## Clips

[`media/clip-social.mp4`](media/clip-social.mp4) is a 28-second cut made for posting: 1080p,
60 frames a second, with music. It is directed shot by shot (a morph to open, a piece a second
on the beat, a turn round the figure, the shop) rather than a recording of the page, and ends
on a card with the address and the credits. The shot list is in
[`tools/social-edit.mjs`](tools/social-edit.mjs); `node tools/capture-video.mjs --edit=social`
films it.

[`media/clip-landscape.mp4`](media/clip-landscape.mp4) and
[`media/clip-vertical.mp4`](media/clip-vertical.mp4) are 36-second, 1080p, 60 frames a second
recordings of the demo running itself, rendered frame by frame rather than screen-recorded, with
no sound. They are filmed at full detail with view-dependent colour, which is sharper in
close-up than the standard detail the live page loads. These two were filmed before the bloom
was taken out (see above), so dark cloth in them is greyer and grainier than the page now
shows it. All three are there to be shared; please keep the capture credit with them.

[`tools/capture-video.mjs`](tools/capture-video.mjs) makes them, with `npm run dev` running. It
needs Chrome, ffmpeg and the `public/morph-sh` pack (see below).

## How it works

**A rig with no mesh.** A splat has no vertices to attach skin weights to, so the weights are a
pure function of where each gaussian sits: a vertical chain (pelvis, spine, chest, head) blended
by height, and two legs separated by a plane between them. Nine rigid bones are applied in the
engine's splat shader hooks. Arms take the torso's weights at the same height, so they never
separate from the body and the shading baked into the capture stays believable. The idle is
procedural: weight shifting over planted feet, breathing, and a head that turns towards the
camera. See [`src/rig-shader.js`](src/rig-shader.js) and [`src/rig.js`](src/rig.js).

**A morph between captures that share nothing.** The three outfits are separate scans of
different mannequins, so there is no real correspondence between their gaussians. One is
manufactured offline: each figure is cut into blocks about 10 cm tall between its own landmarks,
and inside a block gaussians are ordered by height, then angle around the body, then distance
from its centre. Pairing by rank puts partners a median of 7 cm apart. All three outfits are
stored in that one shared order, so a morph is a per-gaussian blend. See
[`tools/build-morph.mjs`](tools/build-morph.mjs).

**Two waves and a band of dots.** The morph runs as two waves crossing the body on a diagonal.
The first draws the cloth in to small round dots; between the waves each dot glides to its
partner; the second opens the dots out into the new cloth. The dots stay crisp where blended
cloth would smear. See [`src/morph.js`](src/morph.js).

**Labels that ride the body.** Each callout is a point on a garment. It goes through the same
skinning as the gaussians, on the CPU, so it stays on its spot as the body moves. During a morph
it travels to its counterpart on the next outfit and changes its text as the wave passes. See
[`src/callouts.js`](src/callouts.js).

**Colour that changes with the view.** A captured gaussian has a base colour and 45 spherical
harmonic coefficients that shift it with the direction it is seen from: the sheen on a
waterproof, the depth of black cotton. Storing them outright would be several times the rest
of the data, so they are clustered into a palette of 65,536 entries per outfit (by
[splat-transform](https://github.com/playcanvas/splat-transform), as for the SOG files
SuperSplat publishes) and each gaussian keeps an index into it. The palette is evaluated in the
same shader as the morph, and the colours are worked out again each time the camera has moved
two degrees round the figure. See `morphSH` in [`src/morph.js`](src/morph.js).

**A small download.** Each outfit is packed to about 13 bytes per gaussian, plus 2.8 MB for its
palette: 47 MB for all three at the standard detail, 28 MB at the lite one. Rotation, scale,
colour and opacity come back bit-identical to what the GPU textures hold; positions are rounded
to 0.1 mm. The first outfit is shown as soon as it arrives. See [`src/pack.js`](src/pack.js).

The studio floor, contact shadows and the light the morph throws on the floor are in
[`src/stage.js`](src/stage.js). The shadows are soft shapes drawn at the rig's ankles, not cast
by the splats.

## Run it locally

```bash
npm install
```

```bash
npm run dev
```

The outfit data is in the repository (`public/morph-*`), so that is all it needs. `npm run build`
writes a static site to `dist`. Pushing to `main` builds and publishes it to GitHub Pages.

## Rebuilding the outfit data

Only needed if you change the pairing, the rig landmarks in [`src/figures.js`](src/figures.js),
or the pack format.

1. Download the three captures as PLY from SuperSplat:
   [Casual_01](https://superspl.at/scene/c297db17),
   [Casual_02](https://superspl.at/scene/60c01999) and
   [Outdoor_01](https://superspl.at/scene/3ccba00a).
2. Unpack them to `raw/Casual_01/scene.ply`, `raw/Casual_02/scene.ply` and
   `raw/Outdoor_01/scene.ply`.
3. Run `npm run data`. It decimates each capture, pairs the gaussians and writes the three packs.

The decimation is not exactly repeatable, so rebuilt lite and standard packs hold slightly
different gaussians each time. The clustering of the view-dependent colour runs on the GPU,
takes a few minutes and is cached beside each capture.

`node --max-old-space-size=12000 tools/build-morph.mjs --sh` writes `public/morph-sh`: every
captured gaussian with its view-dependent colour, for `?detail=sh`. It is 125 MB and is not in
the repository. A phone can load it but not run it smoothly (21 frames a second on an iPhone 14
Pro with WebGPU, 10 with WebGL2).

`node tools/anchor.mjs <figure> front <x> <y>` prints a point on an outfit's surface, for
placing a new callout in `src/figures.js`.

## Credits and licence

- **Captures:** Casual_01, Casual_02 and Outdoor_01 by
  [Christoph Schindelar](https://superspl.at/user/schindelar3d), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The data in `public/morph-*` is
  adapted from them: cropped to the figure, scaled and turned into a common frame, decimated for
  the lighter packs, re-ordered, and stored with view-dependent colour reduced to a palette (the
  full pack, without it). It carries the same licence and the same credit.
- **Engine:** [PlayCanvas](https://github.com/playcanvas/engine), MIT.
- **Product names and prices** are invented for the demo. They do not describe the real garments.
- **Code:** [MIT](LICENSE). The licence covers the code only: the outfit data in `public/morph-*`
  and the images and clips made from it stay under CC BY 4.0, with the credit above, and the
  PlayCanvas logo in `tools/brand/` remains PlayCanvas's.
