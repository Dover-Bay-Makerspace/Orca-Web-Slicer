# Custom printers and presets

Printer, print-settings and filament presets in this folder are added to the
site for everyone the next time it deploys (a minute or two after you commit).

- **Printers** appear under the brand **My printers**, first in the list.
- **Print settings and filaments** appear for every printer they fit
  (normally the same printers as the preset they were based on).

## Making a preset file

On the site:

1. Pick the printer (or print settings, or filament) that is closest to yours.
2. Open **Advanced settings**, go to the **Printer** tab (or Print / Filament)
   and change what is different, e.g. bed size, max height, start G-code.
3. Click **Save printer as file…** and give it a name.
4. Upload the downloaded `.json` file into this folder on GitHub
   (**Add file → Upload files**, then **Commit changes**).

From desktop OrcaSlicer, these also work: preset `.json` files and preset
bundles (`.orca_printer`, `.orca_filament`, `.zip`).

To remove a preset, delete its file here and commit.

Files that aren't presets (like this README) are ignored.
