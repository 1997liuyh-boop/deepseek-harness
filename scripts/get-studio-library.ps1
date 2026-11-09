#Requires -Version 7.4
param([Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][string]$Destination, [string]$Ref = 'main')
$ErrorActionPreference = 'Stop'
if ($Repository -notmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$') { throw '请输入 GitHub 仓库的 HTTPS 地址。' }
if (-not [IO.Path]::IsPathFullyQualified($Destination)) { throw '工作库目录必须是绝对路径。' }
if (Test-Path -LiteralPath $Destination) { throw '目标目录已经存在，请使用新目录；未修改现有工作库。' }
& git clone --branch $Ref --single-branch -- $Repository $Destination
if ($LASTEXITCODE -ne 0) { throw 'GitHub 工作库下载失败，已保留现场供检查。' }
$catalogPath = Join-Path $Destination 'catalog.json'
if (-not (Test-Path -LiteralPath $catalogPath)) { throw '该仓库不是 dsh 工作库：缺少 catalog.json。' }
$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
if ($catalog.schemaVersion -ne 1 -or -not $catalog.packages) { throw '工作库索引版本不受支持。' }
Write-Output ('工作库已准备：' + $Destination)
Write-Output '请按库内 README 安装依赖，审查源码后使用以下入口：'
Write-Output ('pnpm run dev:desktop:studio --library "' + $Destination + '" --skip-build')
