# Installs the pi-daemon CLI on Windows without needing Node first:
#   irm https://raw.githubusercontent.com/CoresoftHQ/pi-daemon/main/install.ps1 | iex
# Installs only. Afterwards, `pi-daemon setup` registers the logon task.
#
# It downloads the portable zip (node.exe plus the package) from the latest GitHub release into
# %LOCALAPPDATA%\pi-daemon\app and adds that directory to the user's PATH.
#   $env:PI_DAEMON_VERSION = "1.0.0"     a specific release (default: latest)
#   $env:PI_DAEMON_ZIP = "<path|url>"    install this zip instead of a release asset
#   $env:PI_DAEMON_APP_DIR = "<dir>"     install here instead of %LOCALAPPDATA%\pi-daemon\app
$ErrorActionPreference = "Stop"
$repo = "CoresoftHQ/pi-daemon"
$appDir = if ($env:PI_DAEMON_APP_DIR) { $env:PI_DAEMON_APP_DIR } else { Join-Path $env:LOCALAPPDATA "pi-daemon\app" }

if ($env:PI_DAEMON_ZIP) {
  $zipSource = $env:PI_DAEMON_ZIP
} else {
  if ($env:PI_DAEMON_VERSION) {
    $tag = "v$($env:PI_DAEMON_VERSION)"
  } else {
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "pi-daemon-install" }
    $tag = $latest.tag_name
  }
  $zipSource = "https://github.com/$repo/releases/download/$tag/pi-daemon-$($tag.TrimStart('v'))-win-x64.zip"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-daemon-install-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp "pi-daemon.zip"
if ($zipSource -match '^https?://') {
  Write-Host "downloading $zipSource"
  Invoke-WebRequest -Uri $zipSource -OutFile $zip -UseBasicParsing
} else {
  Copy-Item -Path $zipSource -Destination $zip
}

$stage = Join-Path $tmp "app"
New-Item -ItemType Directory -Path $stage | Out-Null
# bsdtar ships with Windows 10 1803+ and is far faster than Expand-Archive on many small files
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (Test-Path $tar) {
  & $tar -xf $zip -C $stage
  if ($LASTEXITCODE -ne 0) { throw "extracting $zip failed" }
} else {
  Expand-Archive -Path $zip -DestinationPath $stage -Force
}
if (-not (Test-Path (Join-Path $stage "pi-daemon.cmd"))) { throw "the archive does not look like a pi-daemon portable build" }

# replace the app directory atomically enough: stop nothing, the running daemon (if any) keeps its old files open
if (Test-Path $appDir) {
  $old = "$appDir.old"
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
  Move-Item -Path $appDir -Destination $old
}
New-Item -ItemType Directory -Path (Split-Path $appDir -Parent) -Force | Out-Null
Move-Item -Path $stage -Destination $appDir
Remove-Item -Recurse -Force $tmp
if (Test-Path "$appDir.old") { Remove-Item -Recurse -Force "$appDir.old" -ErrorAction SilentlyContinue }

# user PATH, persistently and for this session (PI_DAEMON_SKIP_PATH=1 leaves it alone)
if (-not $env:PI_DAEMON_SKIP_PATH) {
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ';') -contains $appDir)) {
  [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(';') + ";" + $appDir), "User")
}
if (-not (($env:Path -split ';') -contains $appDir)) { $env:Path = "$env:Path;$appDir" }
}

$version = & (Join-Path $appDir "pi-daemon.cmd") --version
Write-Host ""
Write-Host "installed pi-daemon $version in $appDir"
Write-Host "next:  pi-daemon doctor      # checks pi, providers, port, service"
Write-Host "       pi-daemon setup       # registers the logon task and starts it"
Write-Host "(open a new terminal if 'pi-daemon' is not found: PATH was updated for future sessions)"
