# Download the prebuilt OrcaSlicer WebAssembly engine into .\engine (Windows PowerShell)
#
#   powershell -ExecutionPolicy Bypass -File tools\fetch-engine.ps1
#   powershell -ExecutionPolicy Bypass -File tools\fetch-engine.ps1 -Tag wasm-v2.4.2-patch3-multithreaded
#
# The engine is published by https://github.com/Hiosdra/OrcaWeb as release assets.
param(
  [string]$Tag = "",
  [string]$Repo = "Hiosdra/OrcaWeb"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "engine"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Write-Host "Looking up engine releases in $Repo ..."
$headers = @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "orca-web-fetch" }
if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)" }
$releases = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/releases?per_page=100"

$pattern = '^wasm-v(\d+)\.(\d+)\.(\d+)(?:-patch(\d+))?-multithreaded$'
$best = $null; $bestKey = $null
foreach ($r in $releases) {
  $names = @($r.assets | ForEach-Object { $_.name })
  if (-not ($names -contains "slicer-mt.js" -and $names -contains "slicer-mt.wasm")) { continue }
  if ($Tag) {
    if ($r.tag_name -eq $Tag) { $best = $r; break }
    continue
  }
  if ($r.prerelease -or $r.draft) { continue }
  $m = [regex]::Match($r.tag_name, $pattern)
  if (-not $m.Success) { continue }
  $key = "{0:D5}{1:D5}{2:D5}{3:D5}" -f [int]$m.Groups[1].Value, [int]$m.Groups[2].Value, [int]$m.Groups[3].Value, [int]("0" + $m.Groups[4].Value)
  if (-not $bestKey -or $key -gt $bestKey) { $best = $r; $bestKey = $key }
}
if (-not $best) { throw "No matching engine release with slicer-mt.js and slicer-mt.wasm was found." }

Write-Host "Engine release: $($best.tag_name)"
foreach ($name in @("slicer-mt.js", "slicer-mt.wasm")) {
  $asset = $best.assets | Where-Object { $_.name -eq $name }
  Write-Host "Downloading $name ..."
  Invoke-WebRequest -Headers @{ "User-Agent" = "orca-web-fetch" } -Uri $asset.browser_download_url -OutFile (Join-Path $dest $name)
}
Set-Content -Path (Join-Path $dest "VERSION") -Value $best.tag_name
$orca = [regex]::Match($best.tag_name, '^wasm-(v\d+\.\d+\.\d+)').Groups[1].Value
Set-Content -Path (Join-Path $dest "ORCA_VERSION") -Value $orca
Write-Host "Saved to $dest (matches OrcaSlicer $orca)"
