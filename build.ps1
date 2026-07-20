<#
.SYNOPSIS
  Builds a local release zip for manual copy to the Foundry v13 test server.

.DESCRIPTION
  Stages only the files Foundry needs, then zips them with module.json at the
  archive root. Unzip the result directly into:
      <FoundryData>\Data\modules\scorpious187s-token-mounting\

.PARAMETER Version
  Optional. Stamps this version into module.json before building.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -Version 0.2.0
#>
[CmdletBinding()]
param(
  [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$moduleId = 'scorpious187s-token-mounting'

$manifestPath = Join-Path $root 'module.json'

# Stamp the version BEFORE running checks, so the checks validate the file that
# actually ships. Doing it afterwards means a stamping bug reaches the server
# with a green build behind it.
if ($Version) {
  # Patch the two fields textually rather than round-tripping through
  # ConvertTo-Json, which reformats the whole file (PS 5.1 indents oddly and
  # escapes apostrophes as '). Valid either way, but it churns the file on
  # every release and makes diffs useless.
  $raw = Get-Content $manifestPath -Raw
  $raw = $raw -replace '("version"\s*:\s*")[^"]*(")', "`${1}$Version`${2}"
  # Keep the download URL pointing at the tag matching this version, so a
  # manifest pulled from a local build still resolves if it reaches GitHub.
  $raw = $raw -replace '(releases/download/v)[^/]*(/module\.zip)', "`${1}$Version`${2}"

  # NOT Set-Content -Encoding utf8: PowerShell 5.1 writes a UTF-8 BOM, and
  # JSON.parse rejects a leading BOM outright — Foundry would fail to read the
  # manifest and the module would not load at all.
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($manifestPath, $raw, $utf8NoBom)

  Write-Host "Stamped version $Version into module.json" -ForegroundColor Cyan
}

# A build that ships a manifest Foundry cannot parse, or a template it cannot
# render, is worse than no build — the failure only appears on the server.
Write-Host "Running pre-flight checks..." -ForegroundColor Cyan
& node (Join-Path $root 'tools\check.mjs')
if ($LASTEXITCODE -ne 0) { throw "Pre-flight checks failed; not building." }

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

$version = $manifest.version

# Only these paths ship. Anything not listed (build script, .git, .claude,
# plans, node_modules) stays out of the archive by construction.
$include = @('module.json', 'scripts', 'styles', 'templates', 'lang', 'README.md')

$dist = Join-Path $root 'dist'
$stage = Join-Path $dist $moduleId

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($item in $include) {
  $source = Join-Path $root $item
  if (-not (Test-Path $source)) {
    Write-Warning "skipping missing path: $item"
    continue
  }
  Copy-Item $source -Destination $stage -Recurse -Force
}

$zipPath = Join-Path $dist "$moduleId-v$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# Build entries by hand rather than using Compress-Archive.
#
# PowerShell 5.1's Compress-Archive writes entry paths with backslashes, which
# violates the ZIP spec (APPNOTE 4.4.17.1 requires forward slashes). Windows
# tolerates it; a Linux Foundry host does not — it unzips to flat files literally
# named "scripts\main.js" and the module fails to load with no useful error.
# .NET Framework's ZipFile.CreateFromDirectory has the same defect, so neither
# convenience API is safe here.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  $stageRoot = (Resolve-Path $stage).Path.TrimEnd('\') + '\'
  foreach ($file in Get-ChildItem $stage -Recurse -File) {
    $relative = $file.FullName.Substring($stageRoot.Length).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $file.FullName, $relative, 'Optimal') | Out-Null
  }
} finally {
  $archive.Dispose()
}

# Drop a loose manifest beside the zip for manifest-URL installs.
Copy-Item $manifestPath -Destination (Join-Path $dist 'module.json') -Force

Remove-Item $stage -Recurse -Force

$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host ""
Write-Host "Built $moduleId v$version" -ForegroundColor Green
Write-Host "  $zipPath ($size KB)"
Write-Host ""
Write-Host "Copy to the server, then unzip into:" -ForegroundColor Yellow
Write-Host "  <FoundryData>\Data\modules\$moduleId\"
