# Orca Web Slicer

OrcaSlicer running as a web page for the classroom. Students open a web
address in Edge or Chrome, add a model, pick a printer, filament and print
profile, slice, and **download the G-code**. Nothing is installed on student
computers, no admin rights are needed, and models are never uploaded:
slicing happens inside the browser on that PC. There is deliberately **no
printer or network connection**. Students copy the G-code to the printer
themselves (SD card, USB stick, or the printer's own web page).

- **Slicing engine:** OrcaSlicer v2.4.2 (latest stable) compiled to
  WebAssembly by the [OrcaWeb](https://github.com/Hiosdra/OrcaWeb) project.
- **Profiles:** OrcaSlicer's own library. That covers 64 brands, about 1,000
  printers, about 2,900 process presets and about 5,900 filament presets.
  Each printer only offers the presets OrcaSlicer marks as compatible with it.
- **File types:** STL, 3MF (geometry), OBJ and STEP.
- **Plate tools:** move by dragging, rotate 90°, scale, copy, delete,
  OrcaSlicer's **Arrange** and **Auto-orient**.
- **Multiple plates:** add plates, move models between them, slice one plate
  or all of them, and download each plate's G-code or all of them as a .zip.
- **Support enforcers and blockers:** select a model and add boxes that force
  supports, or keep them out, in that area. Set each box's position and size
  in millimetres.
- **Quick settings:** layer height, infill, walls, supports (off/normal/tree),
  brim and build-plate type.
- **Advanced settings:** all of OrcaSlicer's Print, Filament and Printer
  settings, with the same pages, names and help text as the desktop app, plus
  search. Changed settings are shown in bold and can be reset one at a time.
  Expert-level settings are hidden unless you tick "Show expert settings".
- **Projects:** **Save project** writes an OrcaSlicer project (.3mf) with every
  plate, support box and setting. **Open project…** reopens it here, and the
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
- **Limits:** one filament per print. Multi-material, painted supports or
  seams, and per-model setting modifiers aren't available; when a desktop
  project contains them, they are skipped and the page says so. Adding a .3mf
  with **Add model** brings in just its models. Use **Open project…** to also
  load its plates and settings.
- **Settings:** changes in Advanced settings are remembered in that browser.
  Picking a different printer, filament or print profile clears the changes
  for that part only, like switching presets in the desktop app.
- **Custom printer settings:** in desktop OrcaSlicer, export your tuned
  printer, filament or process preset as `.json`, then use **Import OrcaSlicer
  preset…** on the site. Imported presets are remembered in that browser only,
  so each PC needs them imported once.

## Updating to a newer OrcaSlicer

Go to **Actions → Deploy site → Run workflow**. Each run picks up the newest
published engine and the profile library from the matching OrcaSlicer version.
OrcaWeb publishes a new engine some time after each OrcaSlicer release.

The **Run workflow** form also has two optional boxes:
- **Engine release tag**: pin a specific engine version.
- **Printer brands**: limit the site to certain brands, for example
  `Prusa,Creality,BBL`, to make it lighter.

---

## For technical readers

### Folder contents

```
index.html, css/, js/       the web app (plain files, no build step)
workers/                    engine worker + G-code preview parser
engine/                     slicer-mt.js + slicer-mt.wasm (downloaded at deploy time)
vendor/                     three.js (3D view)
coi-serviceworker.min.js    supplies the required headers on GitHub Pages
tools/fetch-engine.sh/.ps1  download the engine
tools/build-profiles.py     build profiles/ from an OrcaSlicer checkout
tools/build-settings-schema.py  build settings-schema.json (Advanced settings) from OrcaSlicer's source
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
stand-in engine. It needs Playwright.

## Licence

AGPL-3.0, the same as OrcaSlicer; see `LICENSE` and `NOTICE.md`. The deploy
workflow points the site's About box at your repository, which satisfies the
AGPL's requirement to offer the source to users.
