#!/bin/sh
# Rebuild the outfit data the app loads, from the SuperSplat downloads.
#
#   sh tools/build-data.sh
#
# Expects each download unpacked at raw/<Name>/scene.ply (see src/figures.js and the README).
# The decimation uses @playcanvas/splat-transform, fetched on demand by npx.
#   1. Decimate each capture to 1M and to 500k gaussians (skipped if already done).
#   2. Pair gaussians across the three outfits and write the morph packs (gzipped, about
#      11 bytes per gaussian, or 13 with view-dependent colour; see src/pack.js). The lighter
#      two keep that colour (--sh), which needs a GPU for its clustering:
#        public/morph-500k  for phones without WebGPU (?detail=lite)
#        public/morph-1m    the default, light enough for 60 fps on a laptop
#        public/morph       every captured gaussian (?detail=full)
set -e
cd "$(dirname "$0")/.."

for n in Casual_01 Casual_02 Outdoor_01; do
    if [ ! -f "raw/$n/scene.1m.ply" ]; then
        npx --yes @playcanvas/splat-transform@3 -w "raw/$n/scene.ply" --decimate 1000000 "raw/$n/scene.1m.ply"
    fi
    if [ ! -f "raw/$n/scene.500k.ply" ]; then
        npx --yes @playcanvas/splat-transform@3 -w "raw/$n/scene.ply" --decimate 500000 "raw/$n/scene.500k.ply"
    fi
done

node --max-old-space-size=8192 tools/build-morph.mjs --variant=500k --sh
node --max-old-space-size=8192 tools/build-morph.mjs --variant=1m --sh
node --max-old-space-size=8192 tools/build-morph.mjs
