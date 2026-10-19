# Third-party notices

## OrcaSlicer (slicing engine and printer/filament/process profiles)

- https://github.com/OrcaSlicer/OrcaSlicer — v2.4.2
- License: GNU Affero General Public License v3.0 (see `LICENSE`)
- Copyright: SoftFever and OrcaSlicer contributors. OrcaSlicer is a fork of
  Bambu Studio, which is a fork of PrusaSlicer (also AGPL-3.0).
- The files in `profiles/` are OrcaSlicer's own preset files, copied unchanged
  apart from minification and an added `_parent` link.

## OrcaWeb WebAssembly engine (`engine/slicer-mt.js`, `engine/slicer-mt.wasm`)

- https://github.com/Hiosdra/OrcaWeb — Emscripten build of OrcaSlicer.
  Complete corresponding source, patches and build scripts are in that
  repository. The engine also contains OCCT (Open CASCADE Technology Public
  License), oneTBB (Apache-2.0), libnoise (LGPL-2.1) and the one-slicer-api
  glue (Apache-2.0); see that repository's NOTICE.md.

## three.js (`vendor/three/`)

- https://github.com/mrdoob/three.js — r186, MIT License (`vendor/three/LICENSE`)

## coi-serviceworker (`coi-serviceworker.min.js`)

- https://github.com/gzuidhof/coi-serviceworker — MIT License
  (`vendor/coi-serviceworker.LICENSE`)

## csg.js (algorithm in `workers/parts-worker.js`)

- https://github.com/evanw/csg.js — Copyright (c) 2011 Evan Wallace, MIT License.
  The BSP-tree solid boolean used to cut overlapping colour parts follows its
  algorithm (rewritten here without recursion).

## Fonts for the Text tool (`vendor/fonts/`)

Outline files made with `tools/build-fonts.py` (characters subset, outlines unchanged):

- Poppins Bold: Copyright 2020 The Poppins Project Authors, SIL Open Font
  License 1.1 (`vendor/fonts/LICENSE-OFL.txt`).
- DejaVu Sans Bold, DejaVu Sans Condensed Bold, DejaVu Serif Bold: Bitstream
  Vera licence with DejaVu changes in the public domain
  (`vendor/fonts/LICENSE-DejaVu.txt`).

## This site

The web interface (HTML/CSS/JS, tools and workflow) is released under the
AGPL-3.0 to match OrcaSlicer. If you run a modified copy for other people, the
AGPL requires you to offer them its source; the GitHub workflow sets the About
box link to your repository automatically.
