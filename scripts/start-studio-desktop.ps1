#Requires -Version 7.4
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path (Split-Path $root -Parent) 'studio-runtime/node/bin'
$nodeExecutable = if ($env:DSH_STUDIO_NODE) { $env:DSH_STUDIO_NODE } else { Join-Path $runtime 'node.exe' }
if (-not (Test-Path -LiteralPath $nodeExecutable)) { throw '工作室专用 Node 运行时缺失，请检查 studio-runtime/node/bin。' }
$env:PATH = (Split-Path $nodeExecutable -Parent) + ';' + $env:PATH
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $root 'apps/desktop/.desktop-build/studio-home' }
$env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'
if (-not $env:DSH_DESKTOP_RENDERER_DEBUG_PORT) { $env:DSH_DESKTOP_RENDERER_DEBUG_PORT = '9332' }
$env:DSH_STUDIO_TOONFLOW_DATA = Join-Path (Split-Path $root -Parent) 'studio-data/toonflow'
$storeDirectory = if ($env:DSH_PNPM_STORE) { $env:DSH_PNPM_STORE } else { Join-Path ([IO.Path]::GetPathRoot($root)) '.pnpm-store' }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Push-Location $root
try {
  & $nodeExecutable (Join-Path $root 'node_modules/pnpm/bin/pnpm.mjs') "--config.store-dir=$storeDirectory" run start:desktop
  exit $LASTEXITCODE
} finally { Pop-Location }
