#!/usr/bin/env bash
set -euo pipefail

if command -v xpuoj >/dev/null 2>&1; then
  xpuoj --version
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to install the XPUOJ CLI." >&2
  exit 1
fi

npm install --global @tensorplay/xpuoj@latest
xpuoj --version
