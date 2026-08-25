#!/usr/bin/env bash
# Same as run.ps1, for controlling a Linux or macOS desktop instead of Windows.
# Remember to swap the gesture map in config.json for your desktop's shortcuts.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "Creating virtual environment (first run only)..."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip --quiet
  .venv/bin/python -m pip install -r requirements.txt
fi

exec .venv/bin/python server/main.py
