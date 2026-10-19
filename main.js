# Paint engine (colour painting for Orca Web Slicer)

The standard web engine (Hiosdra/OrcaWeb) ignores colour painting. This folder
holds a small change to that engine so painted models print in colour, exactly
like desktop OrcaSlicer, and multi-colour models print as proper parts.

- `bridge/slicer.cpp`: the changed engine file. It replaces `bridge/slicer.cpp` in your copy of OrcaWeb.
- `orcaweb-paint.patch`: the same change as a diff (for technical readers, or to send to OrcaWeb).

What the change adds (two optional extensions, reported in the engine's capabilities):

- `x.orcaweb.paint`: `meshes[].orcaPaint.dataRange` points at JSON
  `[[triangle index, "paint_color string"], ...]`, which goes into
  OrcaSlicer's `mmu_segmentation_facets` (the same data OrcaSlicer saves in 3MF files).
- `x.orcaweb.parts`: `objects[].parts: [{ meshId, extruderId }]` adds extra
  model parts, each with its own filament, to an object.

Painted meshes and parts are loaded without STL repair so triangle numbers
stay the same as on the page.

It also fixes **Save project** (the file students take to the workstation),
reported as `x.orcaweb.projectSave`:

- every model stays its own object, with its own filament, parts and paint
  (the standard engine joined all models into one when there were no
  supports painted), and every plate stays a plate;
- with **Layers: Adaptive**, the saved project carries the adaptive layer
  heights, worked out exactly as the slice does, so OrcaSlicer and Bambu
  Studio show them in their Variable layer height tool.

## Updating your engine copy with a new version of this file

1. Open https://github.com/Dover-Bay-Makerspace/OrcaWeb, open the **bridge**
   folder, then **Add file → Upload files**. Drag in `bridge/slicer.cpp` from
   this folder (it replaces the old one) and click **Commit changes**.
2. That starts **Build WASM** on that repository's Actions tab (3–4 hours).
   Wait for the green tick.
3. In **Orca-Web-Slicer**, open **Actions → Deploy site → Run workflow** so the
   site picks up the new engine (the site only downloads the engine when it
   deploys).

## Making your own engine copy (one time, about 15 minutes of clicks and a 3–4 hour build)

1. Go to https://github.com/Hiosdra/OrcaWeb and click **Fork** (top right).
   Owner: **Dover-Bay-Makerspace**, name: **OrcaWeb**. Click **Create fork**.
2. In your new fork, open the **Actions** tab and click
   **I understand my workflows, go ahead and enable them**.
3. Click the **Code** tab, open the **bridge** folder, then **Add file → Upload files**.
   Drag in `bridge/slicer.cpp` from this folder and click **Commit changes**.
4. That starts **Build WASM** on the Actions tab. If it doesn't, open
   **Actions → Build WASM → Run workflow** and run it with `v2.4.2`.
5. Wait for the green tick (3–4 hours). Your fork's **Releases** then lists
   `wasm-v2.4.2-multithreaded` with `slicer-mt.js` and `slicer-mt.wasm`.
6. In your **Orca-Web-Slicer** repository, open `.github/workflows/deploy.yml`,
   click the pencil, change `ENGINE_REPO: "Hiosdra/OrcaWeb"` to
   `ENGINE_REPO: "Dover-Bay-Makerspace/OrcaWeb"` and commit. After that deploy,
   the Paint bar no longer says that paint won't print.

If the build shows a red X, open the failed run and copy the link to the
failed step; the change can then be fixed and the build run again.

Updating later: when a newer OrcaSlicer engine comes out, use **Sync fork** on
your fork's Code tab, upload this `slicer.cpp` again if the sync replaced it,
and run the build. To go back to the standard engine at any time, set
`ENGINE_REPO` back to `"Hiosdra/OrcaWeb"`.

Licence: OrcaWeb is AGPL-3.0 (see its LICENSE and NOTICE.md); this change is
offered under the same licence. Your fork on GitHub is the public source of
your engine build, as AGPL-3.0 asks.
