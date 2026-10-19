# Orca Web Slicer

OrcaSlicer running as a web page for the classroom. Students open a web
address in Edge or Chrome, add a model, pick a printer, filament and print
profile, slice to check it, and click **Save for the workstation (.3mf)**.
They take that project file to the workstation computer, open it in
OrcaSlicer or Bambu Studio, where the settings are checked, and print from
there. Nothing is installed on student computers, no admin rights are
needed, and models are never uploaded: slicing happens inside the browser on
that PC. There is deliberately **no printer or network connection**.
Printing straight from the page is still possible with the smaller **G-code**
and **Bambu (.gcode.3mf)** downloads.

**What the workstation project keeps:** every plate and model (including cut,
mirrored, text and shape models), the printer, print profile and filaments
by their desktop preset names plus any changed settings, colour painting,
painted supports and support boxes (as enforcer/blocker parts), pauses
and colour changes (they appear on the desktop layer slider), and adaptive
layer heights (in the desktop Variable layer height tool). Models staying
separate, plates and adaptive layers need the updated engine copy (see
`engine-patch/README.md`); the page says so when it saves with an older one.
Not kept: a temperature tower's per-block temperatures. Bambu Studio has no Snapmaker U1,
so U1 projects need OrcaSlicer on the workstation.

- **Slicing engine:** OrcaSlicer v2.4.2 (latest stable) compiled to
  WebAssembly by the [OrcaWeb](https://github.com/Hiosdra/OrcaWeb) project.
- **Profiles:** OrcaSlicer's own library (64 brands and about 1,000 printers
  are available). The site is set to Bambu, Snapmaker, Prusa and OrcaSlicer's
  generic "Custom" printers; see **Printer brands** below to change that.
  Each printer only offers the presets OrcaSlicer marks as compatible with it.
  Your own printers go in `custom-printers/` and appear as **My printers**.
- **File types:** STL, 3MF (geometry), OBJ and STEP.
- **Plate tools:** move by dragging, rotate 90°, scale, copy, delete,
  OrcaSlicer's **Arrange** and **Auto-orient**.
- **Multiple plates:** add plates, move models between them, slice one plate
  or all of them, and download each plate's G-code or all of them as a .zip.
- **Multiple filaments:** list several filaments, each with a material and
  colour, and pick a filament for each model. On Bambu printers with an AMS
  you can use up to 16, on the Snapmaker U1 one per tool head (4), and on the
  Bambu H2D you choose the nozzle for each. OrcaSlicer's colour-based purge
  amounts and a prime tower are set up automatically. The preview can colour
  by filament, and the result shows grams per filament.
- **Bambu printers:** besides plain G-code, the **Bambu (.gcode.3mf)**
  download gives the sliced file Bambu printers print from an SD card.
- **Support enforcers and blockers:** select a model and add boxes that force
  supports, or keep them out, in that area. Set each box's position and size
  in millimetres.
- **Quick settings:** the print profile sets the layer height (as in desktop
  OrcaSlicer, e.g. "0.12mm Fine"); beside it are adaptive layers, infill,
  walls, supports (off/normal/tree), brim and build-plate type. Any other
  layer height can be set in Advanced settings.
- **Advanced settings:** all of OrcaSlicer's Print, Filament and Printer
  settings, with the same pages, names and help text as the desktop app, plus
  search. Changed settings are shown in bold and can be reset one at a time.
  Expert-level settings are hidden unless you tick "Show expert settings".
- **Projects:** **Save project** (the same file as **Save for the
  workstation**) writes an OrcaSlicer / Bambu Studio project (.3mf) with every
  plate, support, pause and setting. **Open project…** reopens it here, and the
  file also opens in desktop OrcaSlicer. Projects made in desktop OrcaSlicer or
  Bambu Studio open here too.
- **Custom presets:** you can import printer, process or filament presets
  exported from desktop OrcaSlicer (`.json`).
- **Preview:** layer-by-layer G-code preview, plus print time and filament
  estimate.

---

## Publish the site on GitHub Pages (one-time setup, about 15 minutes)

You do this once. Afterwards the site runs at an address like
`https://yourname.github.io/orca-web-slicer/`.

### 1. Make a GitHub account and repository

1. Sign up at <https://github.com>. Your school email is fine.
2. Click **New repository** and name it something like `orca-web-slicer`.
3. Set it to **Public**. Free GitHub Pages hosting needs a public repository.
4. Leave **Add a README** unticked, then click **Create repository**.

### 2. Upload this folder with GitHub Desktop

Use GitHub Desktop rather than the website's upload page, because the web
upload can skip the `.github` folder that does the publishing.

1. Install **GitHub Desktop** (<https://desktop.github.com>) and sign in.
2. Choose **File → Add local repository** and pick this unzipped folder.
3. GitHub Desktop will say the folder *"does not appear to be a Git
   repository."* Click **create a repository** in that message, keep the
   name, and click **Create repository**.
4. Click **Publish repository**, untick **Keep this code private**, and
   publish to the repository you made in step 1.

### 3. Turn on GitHub Pages

In the repository on github.com, go to **Settings → Pages**. Under **Build
and deployment**, set **Source** to **GitHub Actions**. There's nothing else to
configure.

### 4. Run the deploy

1. Open the **Actions** tab and click **Deploy site**.
2. Click **Run workflow**, then **Run workflow** again.
3. The run downloads the slicing engine, builds the printer profile library,
   and publishes the site. It takes a few minutes.

A green check means it worked. A red X means a step failed; click into it to
see the error.

### 5. Test on one classroom PC first

Open the address shown in **Settings → Pages** in Edge or Chrome on a
normal student PC, logged in as a student if possible.

1. The first visit reloads the page once. That is normal: a helper script is
   switching on what the engine needs.
2. Wait for the pill in the top-right corner to say **Engine ready**.
3. Pick your printer, add a model, click **Slice plate**, then **Download
   G-code**.
4. Print the file on that printer to confirm the start G-code and
   temperatures are right.

If that PC works, every student PC with the same setup will work.

### 6. Share it with the class

Bookmark the address on the classroom PCs or post it on your class page.

---

## If something doesn't work

Check these on a student PC:

| Symptom | Likely cause | Fix |
|---|---|---|
| The page won't load at all | The district web filter blocks `github.io` | Ask IT to allow your `yourname.github.io` address. |
| The pill says **Engine unavailable** and mentions "cross-origin isolated" | Service workers are turned off by browser policy, or the page hasn't reloaded yet | Refresh once. If it persists, ask IT whether service workers are blocked for that site. |
| The pill says **Engine unavailable** and mentions missing engine files | The deploy didn't finish | Check the Actions tab for a red X and re-run **Deploy site**. |
| Very old browser | Managed PCs not updated | Update Edge/Chrome; any version from the last couple of years works. |

Hover over the pill to see the full error message.

---

## Day-to-day notes

- **What stays on student PCs:** only normal browser data. That is the cached
  engine (about 30 MB, so later visits load fast), the student's last-used
  printer and settings, and any G-code files they download.
- **Multi-colour (AMS, MMU, tool-changers such as the Snapmaker U1):** add
  the parts of a design together (for example one STL per colour exported
  from Tinkercad, selected in one go). If they overlap, the page offers to
  keep them as one model, and each part gets its own filament in the model's
  panel. Multi-colour 3MF projects load the same way. Overlaps are cut out
  (the smaller part wins). The engine prints each colour as its own object
  standing on the bed, so raised details with a flat underside (letters,
  logos) are extended down to the bed. That means every layer under them
  uses both colours: quick on a tool-changer, more filament changes and
  purging on an AMS. Floating parts without a flat underside (eyes set into
  a head) use the main colour.
- **Colour painting (Paint button or N):** pick a filament and drag over a
  model, or use **Fill** to colour a whole face; Shift erases, keys 1–9 pick
  a filament, Ctrl+Z undoes. Paint is stored the way OrcaSlicer and Bambu
  Studio store it, so painted 3MF files open with their colours. Painted
  colours only print with the **paint engine**: a copy of the web engine with
  a small change (see `engine-patch/README.md` for the one-time setup).
  With the paint engine, multi-colour models are also printed as proper
  parts (no columns down to the bed).
- **Support painting (Supports button or L):** paint green where supports
  must go and red where they must not, by brush or fill, or use
  **Auto-paint overhangs**. Green areas switch supports on by themselves
  (only there, if Supports is Off). The optional support boxes are in the
  same tool. Painted supports work with either engine (they are sent as thin
  enforcer/blocker volumes along the painted surface) and open from
  OrcaSlicer/Bambu 3MF files.
- **Limits:** painted seams and per-model setting modifiers aren't available. Adding a .3mf
  with **Add model** brings in just its models. Use **Open project…** to also
  load its plates and settings.
- **Model tools** (toolbar; hover a button for its name and key):
  **Cut** (C) splits a model at a height, optionally turning the top part
  over; **Measure** (M) shows the distance between two clicked points; the
  model panel sets the **size in mm** (with or without keeping proportions),
  **mirrors**, and **splits** a model into its separate pieces.
- **Shapes ▾:** cube, cylinder, cone, sphere, **Text** (T: as a new model,
  raised on top of the selected model in any filament, or cut into it), and
  calibration prints: a **temperature tower** (the page sets each block's
  temperature), a **first layer test** and a **stringing test**.
- **Pause / colour change:** in Preview, move the layer slider and click
  **Pause here** or **Colour change here**. The printer stops before that
  layer (Bambu and Klipper printers through their pause; others with M600).
  No re-slicing needed; the pauses stay until you remove them.
- **Thumbnails:** printers with a screen show a picture of the print, in the
  sizes and formats their profile asks for (PNG, JPG or QOI). Bambu packages
  also get the plate picture.
- **Layers: Adaptive** (quick setting) uses thinner layers where a model
  curves, like OrcaSlicer's Adaptive layer height.
- **Plates:** every plate is shown side by side in Prepare, numbered, with
  the active plate outlined in orange. Click a plate (or a model on it) to
  work on it, or drag a model from one plate onto another. **Fit** with no
  models shows all plates.
- **Undo / redo (↶ ↷ or Ctrl+Z / Ctrl+Y):** covers everything on the plates:
  adding, moving, turning, scaling and deleting models, Arrange, plates,
  colour choices, support boxes and paint (up to 60 steps). Print settings and
  the filament list have their own reset buttons instead.
- **Turning models:** select a model, then use **Rotate** (or press R) and
  drag the red, green or blue ring. It turns in 5° steps; hold Shift for 1°.
  You can also type exact angles in the model's panel, or use **+90**.
  **Lay flat** (F) puts whichever flat face you click down on the bed.
  Esc goes back to moving models.
- **Settings:** changes in Advanced settings are remembered in that browser.
  Picking a different printer, filament or print profile clears the changes
  for that part only, like switching presets in the desktop app.
- **Printer brands:** the `PRINTER_BRANDS` line near the top of
  `.github/workflows/deploy.yml` lists the brands students can choose from
  (now `"Bambu, Snapmaker, Prusa, Custom"`). To add one, edit that file on
  GitHub (pencil icon), add the brand name, e.g. `Creality`, and commit. Use
  `""` for every brand. Unknown names are skipped and listed in the deploy log.
- **Custom printers for everyone:** pick the closest printer, change what is
  different in **Advanced settings → Printer** (bed size, height, start
  G-code…), then click **Save printer as file…**. Upload that `.json` file to
  the `custom-printers` folder in the repository; after the deploy, it
  appears for every student under the brand **My printers**, which is
  listed first and picked by default. The same works for print settings
  and filaments (they show up for the printers they fit). Presets and
  bundles exported from desktop OrcaSlicer (`.json`, `.orca_printer`,
  `.orca_filament`) also work. See `custom-printers/README.md`.
- **Presets for one PC only:** **Import OrcaSlicer preset…** adds a `.json`
  preset to that browser only.

## Updating to a newer OrcaSlicer

Go to **Actions → Deploy site → Run workflow**. Each run picks up the newest
published engine and the profile library from the matching OrcaSlicer version.
OrcaWeb publishes a new engine some time after each OrcaSlicer release.

The **Run workflow** form also has two optional boxes:
- **Engine release tag**: pin a specific engine version.
- **Printer brands**: use different brands for this one run, for example
  `Prusa, Creality, Bambu` (blank uses the `PRINTER_BRANDS` line).

---

## For technical readers

### Folder contents

```
index.html, css/, js/       the web app (plain files, no build step)
workers/                    engine worker + G-code preview parser
engine/                     slicer-mt.js + slicer-mt.wasm (downloaded at deploy time)
vendor/                     three.js (3D view), fonts for the Text tool
tools/build-fonts.py        turn TrueType fonts into vendor/fonts/*.json
coi-serviceworker.min.js    supplies the required headers on GitHub Pages
tools/fetch-engine.sh/.ps1  download the engine
tools/build-profiles.py     build profiles/ from an OrcaSlicer checkout
tools/build-settings-schema.py  build settings-schema.json (Advanced settings) from OrcaSlicer's source
custom-printers/            your own printer/print/filament presets ("My printers")
engine-patch/               engine change for colour painting (build it in your OrcaWeb fork)
tools/serve.py              local test server with the right headers
.github/workflows/deploy.yml  GitHub Pages build and publish
tests/                      headless browser test with a stand-in engine
```

### Running it locally or on another web server

The engine is multithreaded, so the page must be served over `https://` or
`http://localhost` with these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

To run it locally:
1. Download the engine with `tools\fetch-engine.ps1` or `tools/fetch-engine.sh`.
2. Build the profile library with
   `python3 tools/build-profiles.py --orca <OrcaSlicer checkout> --out profiles`.
   Then build the Advanced settings list with
   `python3 tools/build-settings-schema.py --orca <OrcaSlicer checkout> --out settings-schema.json`.
   The checkout only needs `resources/profiles`, `src/libslic3r/PrintConfig.cpp`
   and `src/slic3r/GUI/Tab.cpp`.
3. Run `python tools/serve.py` and open http://localhost:8080.

For Cloudflare Pages or Netlify, the included `_headers` file sets the
headers. Opening `index.html` directly from disk does not work.

### Building a newer engine yourself

To run an OrcaSlicer version that OrcaWeb hasn't published yet:
1. Fork OrcaWeb.
2. Point its `orca` submodule at the new OrcaSlicer tag.
3. Let its GitHub Actions build the engine. This takes hours.
4. Set `ENGINE_REPO=<you>/OrcaWeb` for the fetch scripts.

### Tests

`node tests/ui-test.mjs` runs the interface in headless Chromium against a
stand-in engine. It needs Playwright. Add `--orca-src <OrcaSlicer checkout>`
to also test the custom-printers build.

## Licence

AGPL-3.0, the same as OrcaSlicer; see `LICENSE` and `NOTICE.md`. The deploy
workflow points the site's About box at your repository, which satisfies the
AGPL's requirement to offer the source to users.
