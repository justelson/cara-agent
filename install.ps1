param(
  [switch]$SkipNodeInstall,
  [string]$Repo = "justelson/cara-agent",
  [string]$Ref = "master",
  [string]$InstallDir = "$env:LOCALAPPDATA\Cara",
  [switch]$NoPathUpdate
)

$ErrorActionPreference = "Stop"

function Has-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-InitialRoot {
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
  if ($scriptPath) { return Split-Path -Parent $scriptPath }
  return (Get-Location).Path
}

function Refresh-NodePath {
  $nodeDirs = @(
    "$env:ProgramFiles\nodejs",
    "${env:ProgramFiles(x86)}\nodejs",
    "$env:LOCALAPPDATA\Programs\nodejs"
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($dir in $nodeDirs) {
    if (($env:Path -split ";") -notcontains $dir) {
      $env:Path = "$dir;$env:Path"
    }
  }
}

function Ensure-Node {
  if (Has-Command node) { return }

  if ($SkipNodeInstall) {
    throw "Node.js is missing. Install Node.js 22 LTS or newer, then rerun install.ps1."
  }

  Write-Host "Node.js not found. Installing Node.js LTS..."

  if (Has-Command winget) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  } elseif (Has-Command choco) {
    choco install nodejs-lts -y
  } else {
    throw "No supported Node installer found. Install Node LTS from https://nodejs.org, then rerun install.ps1."
  }

  Refresh-NodePath

  if (-not (Has-Command node)) {
    throw "Node.js installed, but node is not visible in this shell yet. Open a new terminal and rerun install.ps1."
  }
}

function Ensure-Node-Version {
  $NodeVersion = [version]((node -p "process.versions.node") -replace "-.+$", "")
  if ($NodeVersion -lt [version]"22.19.0") {
    throw "Cara needs Node.js 22.19.0 or newer. Current Node is $NodeVersion. Install Node LTS, then rerun install.ps1."
  }
}

function Download-CaraSource($TargetDir) {
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("cara-install-" + [System.Guid]::NewGuid().ToString("N"))
  $zip = Join-Path $temp "cara.zip"
  New-Item -ItemType Directory -Force -Path $temp | Out-Null

  $urls = @(
    "https://github.com/$Repo/archive/refs/heads/$Ref.zip",
    "https://github.com/$Repo/archive/refs/tags/$Ref.zip"
  )

  $downloaded = $false
  foreach ($url in $urls) {
    try {
      Write-Host "Downloading Cara from $url"
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
      $downloaded = $true
      break
    } catch {
      Remove-Item -Force -ErrorAction SilentlyContinue $zip
    }
  }

  if (-not $downloaded) {
    throw "Could not download Cara from $Repo ref $Ref. Check the repo/ref or network connection."
  }

  $extract = Join-Path $temp "extract"
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  $source = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
  if (-not $source) { throw "Downloaded Cara archive did not contain a source folder." }

  if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TargetDir) | Out-Null
  Copy-Item -Recurse -Force $source.FullName $TargetDir
  Remove-Item -Recurse -Force $temp
  return $TargetDir
}

function Ensure-PathEntry($Dir) {
  $parts = @($env:Path -split ";" | Where-Object { $_ })
  if ($parts -notcontains $Dir) {
    $env:Path = "$Dir;$env:Path"
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $userParts = @($userPath -split ";" | Where-Object { $_ })
  if ($userParts -notcontains $Dir) {
    $next = if ($userPath) { "$Dir;$userPath" } else { $Dir }
    [Environment]::SetEnvironmentVariable("Path", $next, "User")
    Write-Host "Added Cara to your user PATH. New terminals will pick this up automatically."
  }
}

$Root = Get-InitialRoot
if (-not (Test-Path (Join-Path $Root "package.json"))) {
  $Root = Download-CaraSource $InstallDir
}

Ensure-Node
Ensure-Node-Version

Write-Host "Installing Cara dependencies..."
Push-Location $Root
try {
  if (Has-Command bun) {
    bun install
  } elseif (Has-Command npm) {
    npm install
  } else {
    throw "npm is missing even though Node is installed. Reinstall Node LTS, then rerun install.ps1."
  }
} finally {
  Pop-Location
}

if (-not $NoPathUpdate) {
  Ensure-PathEntry $Root
}

Write-Host "Checking install..."
& (Join-Path $Root "cara.cmd") doctor
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Cara is installed. Try:"
Write-Host "  cara login"
Write-Host "  cara auth"
Write-Host "  cara"
