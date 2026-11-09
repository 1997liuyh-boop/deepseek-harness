param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [string]$Ref = 'master'
)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw '目标目录已存在，请选择新的空目录。' }
if ($target.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $target -eq $source) { throw '更新检查目录不能位于当前仓库内。' }
# 只准备独立上游副本，不修改当前定制分支或用户数据。
& git clone --depth 1 --single-branch --branch $Ref -- 'https://github.com/deepseek-ai/deepseek-harness.git' $target
if ($LASTEXITCODE -ne 0) { throw '上游下载失败，当前项目未修改。' }
$upstreamPackage = Get-Content -LiteralPath (Join-Path $target 'package.json') -Raw | ConvertFrom-Json
$currentPackage = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
$report = [ordered]@{ currentVersion = $currentPackage.version; upstreamVersion = $upstreamPackage.version; upstreamRef = $Ref; upstreamDirectory = $target; changedInterfaces = @() }
foreach ($path in @('packages/client/ui-slots/src/index.ts', 'packages/client/ui-model-selection/src/client/directory.ts', 'packages/api/session-controller/src/types.ts', 'packages/client/ui-conversation/src/client/index.ts', 'packages/client/ui-settings-general/src/client/shell-store.ts', 'packages/client/ui-workspace/src/client/rows/Rows.module.css', 'packages/client/ui-workspace/src/client/rows/AnimatedRows.tsx', 'apps/desktop/src/main.ts')) {
  $localFile = Join-Path $source $path
  $upstreamFile = Join-Path $target $path
  if (!(Test-Path -LiteralPath $localFile) -or !(Test-Path -LiteralPath $upstreamFile) -or (Get-FileHash -LiteralPath $localFile).Hash -ne (Get-FileHash -LiteralPath $upstreamFile).Hash) { $report.changedInterfaces += $path }
}
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $target 'studio-compatibility-report.json') -Encoding utf8
Write-Output ('已准备上游源码：' + $target)
Write-Output ('接口差异数量：' + $report.changedInterfaces.Count + '。请完成插件构建、模型切换与桌面验证后再采用；此报告不代表兼容性已通过。')
