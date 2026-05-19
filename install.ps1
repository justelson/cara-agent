param(
  [switch]$SkipNodeInstall,
  [string]$Repo = "justelson/cara-agent",
  [string]$Ref = "master",
  [string]$InstallDir = "$env:LOCALAPPDATA\Cara",
  [switch]$NoPathUpdate,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$PortableNodeDir = Join-Path $InstallDir ".deps\node"

function Has-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Confirm-Step($Message) {
  if ($Yes) { return $true }
  $answer = Read-Host "$Message [y/N]"
  return $answer -match '^(y|yes)$'
}

function Require-Confirmation($Message, $DeclineMessage) {
  if (-not (Confirm-Step $Message)) {
    throw $DeclineMessage
  }
}

function Invoke-PackageInstall($Root) {
  Push-Location $Root
  try {
    if (Has-Command bun.exe) {
      & bun.exe install
    } elseif (Has-Command bun) {
      & bun install
    } elseif (Has-Command npm.cmd) {
      & npm.cmd install
    } elseif (Has-Command npm.exe) {
      & npm.exe install
    } elseif (Has-Command npm) {
      cmd.exe /d /s /c "npm install"
    } else {
      throw "npm is missing even though Node is installed. Reinstall Node LTS, then rerun install.ps1."
    }
  } finally {
    Pop-Location
  }
}

function Get-InitialRoot {
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
  if ($scriptPath) { return Split-Path -Parent $scriptPath }
  return (Get-Location).Path
}

function Refresh-NodePath {
  $nodeDirs = @(
    $PortableNodeDir,
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

function Get-WindowsNodeArch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -eq "ARM64") { return "arm64" }
  return "x64"
}

function Get-Node22Version {
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
  $candidate = $index |
    Where-Object { $_.version -like "v22.*" -and $_.files -contains "win-$(Get-WindowsNodeArch)-zip" } |
    Select-Object -First 1

  if (-not $candidate) {
    throw "Could not find a downloadable Node.js 22 Windows build from nodejs.org."
  }
  return $candidate.version
}

function Install-PortableNode {
  $nodeExe = Join-Path $PortableNodeDir "node.exe"
  if (Test-Path $nodeExe) {
    Refresh-NodePath
    return
  }

  $arch = Get-WindowsNodeArch
  $version = Get-Node22Version
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("cara-node-" + [System.Guid]::NewGuid().ToString("N"))
  $zip = Join-Path $temp "node.zip"
  $extract = Join-Path $temp "extract"
  $url = "https://nodejs.org/dist/$version/node-$version-win-$arch.zip"

  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  try {
    Write-Host "Downloading portable Node.js $version ($arch)..."
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    $source = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
    if (-not $source) { throw "Downloaded Node archive did not contain a folder." }

    if (Test-Path $PortableNodeDir) {
      Remove-Item -Recurse -Force $PortableNodeDir
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PortableNodeDir) | Out-Null
    Copy-Item -Recurse -Force $source.FullName $PortableNodeDir
  } finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $temp
  }

  Refresh-NodePath
}

function Ensure-Node {
  Refresh-NodePath
  if (Has-Command node) { return }

  if ($SkipNodeInstall) {
    throw "Node.js is missing. Install Node.js 22 LTS or newer, then rerun install.ps1."
  }

  Require-Confirmation "Node.js 22+ is missing. Install it for Cara now?" "Node.js is required. Install Node.js 22 LTS or rerun this installer and answer y."
  Write-Host "Node.js not found. Installing Node.js LTS..."

  $installed = $false
  if (Has-Command winget) {
    try {
      winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
      $installed = $true
    } catch {
      Write-Host "winget Node install failed; falling back to portable Node."
    }
  } elseif (Has-Command choco) {
    try {
      choco install nodejs-lts -y
      $installed = $true
    } catch {
      Write-Host "Chocolatey Node install failed; falling back to portable Node."
    }
  }

  Refresh-NodePath
  if (-not (Has-Command node)) {
    Install-PortableNode
  }

  if (-not (Has-Command node)) {
    throw "Node.js installed, but node is not visible in this shell yet. Open a new terminal and rerun install.ps1."
  }
}

function Ensure-Node-Version {
  $NodeVersion = [version]((node -p "process.versions.node") -replace "-.+$", "")
  if ($NodeVersion -lt [version]"22.19.0") {
    if (-not $SkipNodeInstall) {
      Require-Confirmation "Node $NodeVersion is too old. Install portable Node.js 22 for Cara now?" "Cara needs Node.js 22.19.0 or newer. Install Node LTS or rerun this installer and answer y."
      Write-Host "Node $NodeVersion is too old; installing portable Node.js 22 for Cara..."
      Install-PortableNode
      $NodeVersion = [version]((node -p "process.versions.node") -replace "-.+$", "")
    }
  }
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
    Write-Host "Added $Dir to your user PATH. New terminals will pick this up automatically."
  }
}

$Root = Get-InitialRoot
if (-not (Test-Path (Join-Path $Root "package.json"))) {
  if (Test-Path (Join-Path $InstallDir "package.json")) {
    Write-Host "Using existing Cara install at $InstallDir"
    $Root = $InstallDir
  } else {
    $Root = Download-CaraSource $InstallDir
  }
}

Ensure-Node
Ensure-Node-Version

if (-not $NoPathUpdate) {
  if (Test-Path (Join-Path $PortableNodeDir "node.exe")) {
    Ensure-PathEntry $PortableNodeDir
  }
}

$NeedsDependencies = -not (Test-Path (Join-Path $Root "node_modules\@earendil-works\pi-coding-agent"))
if ($NeedsDependencies) {
  Require-Confirmation "Cara package dependencies are missing. Install them now?" "Cara dependencies are required. Rerun this installer and answer y."
}

Write-Host "Installing Cara dependencies..."
Invoke-PackageInstall $Root

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
