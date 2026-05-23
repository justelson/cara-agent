param(
  [switch]$SkipNodeInstall,
  [string]$Repo = "justelson/cara-agent",
  [string]$Ref = "master",
  [string]$InstallDir = "$env:LOCALAPPDATA\Zyra",
  [switch]$NoPathUpdate,
  [switch]$Update,
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

function Test-ZyraRoot($Dir) {
  $packagePath = Join-Path $Dir "package.json"
  $cliPath = Join-Path $Dir "bin\zyra.mjs"
  if (-not (Test-Path $packagePath) -or -not (Test-Path $cliPath)) { return $false }
  try {
    $package = Get-Content -Raw $packagePath | ConvertFrom-Json
    return ($package.name -eq "zyra" -and $package.bin.zyra)
  } catch {
    return $false
  }
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
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("zyra-node-" + [System.Guid]::NewGuid().ToString("N"))
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

  Require-Confirmation "Node.js 22+ is missing. Install it for Zyra now?" "Node.js is required. Install Node.js 22 LTS or rerun this installer and answer y."
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
      Require-Confirmation "Node $NodeVersion is too old. Install portable Node.js 22 for Zyra now?" "Zyra needs Node.js 22.19.0 or newer. Install Node LTS or rerun this installer and answer y."
      Write-Host "Node $NodeVersion is too old; installing portable Node.js 22 for Zyra..."
      Install-PortableNode
      $NodeVersion = [version]((node -p "process.versions.node") -replace "-.+$", "")
    }
  }
  if ($NodeVersion -lt [version]"22.19.0") {
    throw "Zyra needs Node.js 22.19.0 or newer. Current Node is $NodeVersion. Install Node LTS, then rerun install.ps1."
  }
}

function Download-ZyraSource($TargetDir) {
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("zyra-install-" + [System.Guid]::NewGuid().ToString("N"))
  $zip = Join-Path $temp "zyra.zip"
  $preserve = Join-Path $temp "preserve"
  New-Item -ItemType Directory -Force -Path $temp | Out-Null

  $urls = @(
    "https://github.com/$Repo/archive/refs/heads/$Ref.zip",
    "https://github.com/$Repo/archive/refs/tags/$Ref.zip"
  )

  $downloaded = $false
  foreach ($url in $urls) {
    try {
      Write-Host "Downloading Zyra from $url"
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
      $downloaded = $true
      break
    } catch {
      Remove-Item -Force -ErrorAction SilentlyContinue $zip
    }
  }

  if (-not $downloaded) {
    throw "Could not download Zyra from $Repo ref $Ref. Check the repo/ref or network connection."
  }

  $extract = Join-Path $temp "extract"
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  $source = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
  if (-not $source) { throw "Downloaded Zyra archive did not contain a source folder." }

  if (Test-Path $TargetDir) {
    Get-ChildItem -Force $TargetDir | Where-Object { $_.Name -notin @(".deps", "node_modules") } | Remove-Item -Recurse -Force
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TargetDir) | Out-Null
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  }
  Copy-Item -Recurse -Force (Join-Path $source.FullName "*") $TargetDir
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

function Ensure-ZyraCommands($Root) {
  $shimDir = Join-Path $Root "shims"
  $zyraShim = Join-Path $shimDir "zyra.cmd"
  $caraShim = Join-Path $shimDir "cara.cmd"
  New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
  $zyraContent = @"
@echo off
setlocal
set "ZYRA_ROOT=%~dp0.."
call "%ZYRA_ROOT%\zyra.cmd" %*
exit /b %ERRORLEVEL%
"@
  $caraContent = @"
@echo off
setlocal
set "ZYRA_ROOT=%~dp0.."
call "%ZYRA_ROOT%\cara.cmd" %*
exit /b %ERRORLEVEL%
"@
  Set-Content -Path $zyraShim -Value $zyraContent -Encoding ASCII
  Set-Content -Path $caraShim -Value $caraContent -Encoding ASCII
  return $shimDir
}

$Root = Get-InitialRoot
if ($Update) {
  if (Test-Path (Join-Path $InstallDir ".git")) {
    throw "Refusing to overwrite a git checkout at $InstallDir. Use git pull there, or install Zyra to %LOCALAPPDATA%\Zyra."
  }
  Write-Host "Updating Zyra in $InstallDir"
  $Root = Download-ZyraSource $InstallDir
} elseif (-not (Test-ZyraRoot $Root)) {
  try {
    $Root = Download-ZyraSource $InstallDir
  } catch {
    if (Test-ZyraRoot $InstallDir) {
      Write-Host "Download failed; using existing Zyra install at $InstallDir"
      $Root = $InstallDir
    } else {
      throw
    }
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
  Require-Confirmation "Zyra package dependencies are missing. Install them now?" "Zyra dependencies are required. Rerun this installer and answer y."
}

Write-Host "Installing Zyra dependencies..."
Invoke-PackageInstall $Root

$ZyraCommandDir = Ensure-ZyraCommands $Root
if (-not $NoPathUpdate) {
  Ensure-PathEntry $ZyraCommandDir
}

Write-Host "Checking install..."
& (Join-Path $ZyraCommandDir "zyra.cmd") doctor
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Zyra is installed. Try:"
Write-Host "  zyra login"
Write-Host "  zyra auth"
Write-Host "  zyra"
Write-Host ""
Write-Host "Legacy handoff: cara still works as an alias for now."
