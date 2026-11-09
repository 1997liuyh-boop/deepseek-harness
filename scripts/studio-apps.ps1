#Requires -Version 7.4
param([switch]$Stop, [switch]$RestartApi, [switch]$RestartToonflow)
$ErrorActionPreference = 'Stop'
$demoDirectory = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$appsDirectory = Join-Path $demoDirectory 'studio-apps'
$runtimeDirectory = Join-Path $demoDirectory 'studio-runtime'
$dataDirectory = Join-Path $demoDirectory 'studio-data'
$processFile = Join-Path $dataDirectory 'processes.json'
New-Item -ItemType Directory -Force $dataDirectory | Out-Null
try { $processLock = [IO.File]::Open((Join-Path $dataDirectory 'processes.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw '另一条工作室启动或停止命令正在运行，请等待完成。' }
try {
$processes = if (Test-Path -LiteralPath $processFile) { Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json -AsHashtable } else { @{} }

# 只有进程号、启动时间和程序路径全部匹配时，才复用或停止本启动器的进程。
function Get-ManagedProcess($entry) {
  if (-not $entry) { return $null }
  $running = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
  if ($running -and $running.StartTime.ToUniversalTime().Ticks -eq $entry.started -and $running.Path -eq $entry.path) { return $running }
  return $null
}

function Save-Processes {
  $temporaryFile = $processFile + '.tmp'
  [IO.File]::WriteAllText($temporaryFile, ($processes | ConvertTo-Json -Depth 5) + "`n")
  Move-Item -LiteralPath $temporaryFile -Destination $processFile -Force
}

function Get-ProcessIdentity($running) {
  return @{ id = $running.Id; started = $running.StartTime.ToUniversalTime().Ticks; path = $running.Path }
}

function Start-StudioProcess($name, $executable, $arguments, $workingDirectory, $port) {
  $managed = Get-ManagedProcess $processes[$name]
  $listener = if ($processes[$name]) { Get-ManagedProcess $processes[$name].listener } else { $null }
  if ($managed -and $listener) { Write-Output ($name + ' 已运行'); return }
  if ($managed -or $listener) { throw ($name + ' 的启动状态不完整，请先执行 pnpm run studio:apps:stop 后重试。') }
  if (-not (Test-Path -LiteralPath $executable)) { throw ($name + ' 运行文件缺失，请按工作室应用说明准备依赖。') }
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw ('端口 ' + $port + ' 已被其他进程占用，未执行停止或替换。') }
  $quotedArguments = ($arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  $child = Start-Process -FilePath $executable -ArgumentList $quotedArguments -WorkingDirectory $workingDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDirectory ($name + '.log')) -RedirectStandardError (Join-Path $dataDirectory ($name + '.error.log')) -PassThru
  $processes[$name] = @{ id = $child.Id; started = $child.StartTime.ToUniversalTime().Ticks; path = $executable }
  Save-Processes
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  do {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { break }
    if ($child.HasExited) { throw ($name + ' 已退出，请查看 studio-data 中的对应日志。') }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $connection) { throw ($name + ' 启动超时，请查看 studio-data 中的对应日志。') }
  # Python 虚拟环境在 Windows 上有一层启动器，只记录本次子进程树内的实际监听进程。
  $owner = [int]$connection.OwningProcess
  $ancestor = $owner
  while ($ancestor -ne $child.Id -and $ancestor -gt 0) {
    $parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ancestor)
    if (-not $parent) { break }
    $ancestor = [int]$parent.ParentProcessId
  }
  if ($ancestor -ne $child.Id) { throw ($name + ' 的端口被其他进程抢占，未停止该进程。') }
  $processes[$name] = Get-ProcessIdentity (Get-Process -Id $child.Id)
  $processes[$name].listener = Get-ProcessIdentity (Get-Process -Id $owner)
  Save-Processes
  Write-Output ($name + ' 已启动，端口 ' + $port)
}

# 定向更新原应用时只重启已登记的服务，保留其他服务和数据库。
if ($Stop -and ($RestartApi -or $RestartToonflow)) { throw '定向重启与 Stop 不能同时使用。' }
$restartNames = @()
if ($RestartApi) { $restartNames += 'printfilm-api' }
if ($RestartToonflow) { $restartNames += 'toonflow' }
foreach ($name in $restartNames) {
  $entry = $processes[$name]
  if ($entry) {
    foreach ($identity in @($entry.listener, $entry)) {
      $managed = Get-ManagedProcess $identity
      if ($managed) { Stop-Process -InputObject $managed; $managed.WaitForExit(5000) | Out-Null }
    }
    $processes.Remove($name)
    Save-Processes
  }
}

$pgControl = Join-Path $runtimeDirectory 'pgsql/bin/pg_ctl.exe'
$pgData = Join-Path $dataDirectory 'printfilm/postgres'
if ($Stop) {
  foreach ($name in @('printfilm-admin', 'printfilm-web', 'printfilm-api', 'toonflow', 'garnet')) {
    $entry = $processes[$name]
    if ($entry) {
      foreach ($identity in @($entry.listener, $entry)) {
        $managed = Get-ManagedProcess $identity
        if ($managed) { Stop-Process -InputObject $managed; $managed.WaitForExit(5000) | Out-Null }
      }
      Write-Output ($name + ' 已停止')
    }
    $processes.Remove($name)
  }
  if (Test-Path -LiteralPath $pgControl) {
    & $pgControl -D $pgData status *> $null
    if ($LASTEXITCODE -eq 0) { & $pgControl -D $pgData -w -m fast stop }
  }
  Save-Processes
  exit
}

$configFile = Join-Path $dataDirectory 'printfilm/runtime.json'
if (-not (Test-Path -LiteralPath $configFile) -or -not (Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) { throw '尚未初始化工作室应用运行环境，请先阅读 apps/desktop/README.md#studio-development。' }
$configuration = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$env:DOTNET_ROOT = Join-Path $runtimeDirectory 'dotnet'
$env:PYTHONUTF8 = '1'
$env:PATH = (Join-Path $runtimeDirectory 'ffmpeg') + ';' + $env:PATH
$env:TOONFLOW_STUDIO_DSH = '1'
$env:TOONFLOW_SERVER_PORT = '33101'
$env:TOONFLOW_SERVER_HOST = '127.0.0.1'
$env:TOONFLOW_DATA_DIR = Join-Path $dataDirectory 'toonflow'
$env:DATABASE_URL = 'postgresql+asyncpg://printfilm:' + $configuration.databasePassword + '@127.0.0.1:35432/printfilm'
$env:DATABASE_URL_SYNC = 'postgresql+psycopg2://printfilm:' + $configuration.databasePassword + '@127.0.0.1:35432/printfilm'
$env:SECRET_KEY = $configuration.secretKey
$env:REDIS_URL = 'redis://127.0.0.1:36379/0'
$env:CORS_ORIGINS = 'http://127.0.0.1:33102,http://127.0.0.1:33103'
$env:PUBLIC_BASE_URL = 'http://127.0.0.1:33102'
$env:CDN_BASE = 'http://127.0.0.1:33104/static'
$env:PRINTFILM_API_ORIGIN = 'http://127.0.0.1:33104'
# 本启动入口默认使用单用户模式；设为 0 可恢复原邮箱登录。
$env:STUDIO_LOCAL_ORIGINS = 'http://127.0.0.1:33102,http://127.0.0.1:33103'
$env:STUDIO_SINGLE_USER = if ($env:DSH_STUDIO_PRINTFILM_SINGLE_USER -eq '0') { 'false' } else { 'true' }
$env:ARK_MOCK = 'false'
& $pgControl -D $pgData status *> $null
if ($LASTEXITCODE -ne 0) {
  if (Get-NetTCPConnection -State Listen -LocalPort 35432 -ErrorAction SilentlyContinue) { throw '数据库端口已被其他进程占用。' }
  & $pgControl -D $pgData -l (Join-Path $dataDirectory 'printfilm/postgres.log') -o '-p 35432 -h 127.0.0.1' -w start
  if ($LASTEXITCODE -ne 0) { throw '工作室 PostgreSQL 启动失败。' }
}
# 工作室使用已验证的独立运行时，不依赖系统默认版本。
$bunExecutable = if ($env:DSH_STUDIO_BUN) { $env:DSH_STUDIO_BUN } else { Join-Path $runtimeDirectory 'bun/bun.exe' }
$nodeExecutable = if ($env:DSH_STUDIO_NODE) { $env:DSH_STUDIO_NODE } else { Join-Path $runtimeDirectory 'node/bin/node.exe' }
foreach ($executable in @($bunExecutable, $nodeExecutable)) {
  if (-not (Test-Path -LiteralPath $executable)) { throw '工作室专用运行时缺失，请检查 studio-runtime 中的 Node 与 Bun。' }
}
$toonflowDirectory = Join-Path $appsDirectory 'Toonflow'
$filmDirectory = Join-Path $appsDirectory 'printfilm'
Start-StudioProcess 'garnet' (Join-Path $runtimeDirectory 'garnet/net10.0/GarnetServer.exe') @('--port', '36379', '--bind', '127.0.0.1', '--memory', '128m', '--storage-tier', '--logdir', (Join-Path $dataDirectory 'printfilm/garnet'), '--checkpointdir', (Join-Path $dataDirectory 'printfilm/garnet'), '--aof', '--recover') $runtimeDirectory 36379
Start-StudioProcess 'toonflow' $bunExecutable @('run', (Join-Path $toonflowDirectory 'build/server/index.js')) $toonflowDirectory 33101
Start-StudioProcess 'printfilm-api' (Join-Path $filmDirectory '.venv/Scripts/python.exe') @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '33104') (Join-Path $filmDirectory 'backend') 33104
foreach ($face in @(@{ name = 'printfilm-web'; directory = 'frontend'; port = 33102 }, @{ name = 'printfilm-admin'; directory = 'admin'; port = 33103 })) {
  $workingDirectory = Join-Path $filmDirectory $face.directory
  Start-StudioProcess $face.name $nodeExecutable @((Join-Path $workingDirectory 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', [string]$face.port, '--strictPort') $workingDirectory $face.port
}
$deadline = [DateTime]::UtcNow.AddSeconds(40)
foreach ($address in @('http://127.0.0.1:33101', 'http://127.0.0.1:33102', 'http://127.0.0.1:33103', 'http://127.0.0.1:33104/api/health')) {
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    try { $response = Invoke-WebRequest $address -TimeoutSec 2; $ready = $response.StatusCode -eq 200 } catch { $ready = $false }
    if ($ready) { break }
    Start-Sleep -Milliseconds 300
  }
  if (-not $ready) { throw ('应用尚未就绪，请查看 ' + $dataDirectory + ' 中对应的运行日志。') }
}
Write-Output '工作室原应用已就绪。Toonflow :33101，PRINTFILM :33102，管理后台 :33103。'
} finally { $processLock.Dispose() }
