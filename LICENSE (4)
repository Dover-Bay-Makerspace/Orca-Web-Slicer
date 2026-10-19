#!/usr/bin/env bash
# Download the prebuilt OrcaSlicer WebAssembly engine into ./engine
#
# The engine is built and published by https://github.com/Hiosdra/OrcaWeb as
# GitHub release assets (slicer-mt.js + slicer-mt.wasm). This picks the newest
# non-prerelease "wasm-v<version>-...-multithreaded" release unless you set
# ENGINE_TAG to a specific tag.
#
#   tools/fetch-engine.sh
#   ENGINE_TAG=wasm-v2.4.2-patch3-multithreaded tools/fetch-engine.sh
#   ENGINE_REPO=yourname/OrcaWeb tools/fetch-engine.sh     # your own engine fork
#
# Set GITHUB_TOKEN to avoid GitHub's anonymous API rate limit (CI does this).
set -euo pipefail

REPO="${ENGINE_REPO:-Hiosdra/OrcaWeb}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HERE/engine"
API="https://api.github.com/repos/$REPO/releases?per_page=100"
AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

echo "Looking up engine releases in $REPO ..."
json="$(curl -fsSL "${AUTH[@]}" -H 'Accept: application/vnd.github+json' "$API")"

read -r TAG JS_URL WASM_URL < <(ENGINE_TAG="${ENGINE_TAG:-}" python3 -c '
import json, os, re, sys
releases = json.load(sys.stdin)
want = os.environ.get("ENGINE_TAG", "")
pat = re.compile(r"^wasm-v(\d+)\.(\d+)\.(\d+)(?:-patch(\d+))?-multithreaded$")
best = None
for r in releases:
    tag = r.get("tag_name", "")
    if want:
        if tag != want: continue
    else:
        if r.get("prerelease") or r.get("draft"): continue
        m = pat.match(tag)
        if not m: continue
        key = tuple(int(x or 0) for x in m.groups())
        if best and key <= best[0]: continue
    assets = {a["name"]: a["browser_download_url"] for a in r.get("assets", [])}
    if "slicer-mt.js" in assets and "slicer-mt.wasm" in assets:
        best = ((0,) if want else key, tag, assets["slicer-mt.js"], assets["slicer-mt.wasm"])
        if want: break
if not best:
    sys.exit("No matching engine release with slicer-mt.js and slicer-mt.wasm was found.")
print(best[1], best[2], best[3])
' <<<"$json")

echo "Engine release: $TAG"
mkdir -p "$DEST"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fL --progress-bar "${AUTH[@]}" -o "$tmp/slicer-mt.js" "$JS_URL"
curl -fL --progress-bar "${AUTH[@]}" -o "$tmp/slicer-mt.wasm" "$WASM_URL"

# Sanity checks: the wasm magic number and the API object the page expects.
head -c 4 "$tmp/slicer-mt.wasm" | od -An -tx1 | grep -q '00 61 73 6d' || { echo "slicer-mt.wasm is not a WebAssembly file" >&2; exit 1; }
grep -q 'OneSlicerEngine' "$tmp/slicer-mt.js" || { echo "slicer-mt.js does not define OneSlicerEngine" >&2; exit 1; }

mv "$tmp/slicer-mt.js" "$tmp/slicer-mt.wasm" "$DEST/"
echo "$TAG" > "$DEST/VERSION"
echo "Saved to $DEST ($(du -h "$DEST/slicer-mt.wasm" | cut -f1) wasm)"
# Print the OrcaSlicer version for scripts that need matching profiles.
echo "$TAG" | sed -E 's/^wasm-(v[0-9]+\.[0-9]+\.[0-9]+).*/\1/' > "$DEST/ORCA_VERSION"
echo "Matching OrcaSlicer version: $(cat "$DEST/ORCA_VERSION")"
