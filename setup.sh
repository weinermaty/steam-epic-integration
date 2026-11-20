#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$HOME/.local/share/millennium/plugins/steam-epic-integration"

if ! command -v legendary >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/legendary" ]]; then
  echo "Warning: 'legendary' not found. Install it with: pip install --user legendary-gl"
fi

mkdir -p "$(dirname "$PLUGIN_DIR")"
ln -sfn "$REPO_DIR" "$PLUGIN_DIR"

echo "Linked $REPO_DIR -> $PLUGIN_DIR"
echo "Enable 'Epic Games Integration' in Millennium settings and restart Steam."
