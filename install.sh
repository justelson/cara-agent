#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

has_command() {
  command -v "$1" >/dev/null 2>&1
}

install_node() {
  echo "Node.js not found. Installing Node.js LTS..."

  if has_command brew; then
    brew install node
  elif has_command apt-get; then
    sudo apt-get update
    sudo apt-get install -y nodejs npm
  elif has_command dnf; then
    sudo dnf install -y nodejs npm
  elif has_command pacman; then
    sudo pacman -Sy --needed nodejs npm
  elif has_command zypper; then
    sudo zypper install -y nodejs npm
  else
    echo "No supported Node installer found."
    echo "Install Node LTS from https://nodejs.org, then rerun ./install.sh."
    exit 1
  fi
}

if ! has_command node; then
  install_node
fi

if ! has_command node; then
  echo "Node.js installed, but node is not visible in this shell yet."
  echo "Open a new terminal and rerun ./install.sh."
  exit 1
fi

node -e "const v=process.versions.node.split('.').map(Number); const ok=v[0]>22||(v[0]===22&&(v[1]>19||(v[1]===19&&v[2]>=0))); if(!ok){console.error('Cara needs Node.js 22.19.0 or newer. Current Node is '+process.versions.node); process.exit(1)}"

echo "Installing Cara dependencies..."
cd "$ROOT"
if has_command bun; then
  bun install
  echo "Linking Cara CLI globally..."
  bun link
elif has_command npm; then
  echo "Bun not found. Falling back to npm."
  npm install
  echo "Linking Cara CLI globally..."
  npm link
else
  echo "Bun/npm is missing. Install Bun for package-manager tasks, or npm as a fallback."
  exit 1
fi

echo "Checking install..."
cara doctor

echo ""
echo "Cara is installed. Run: cara"
