#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
VAULT_PATH="${1:-${OBSIDIAN_VAULT_PATH:-}}"

if [ -z "$VAULT_PATH" ]; then
  echo "Usage: bash scripts/install-to-vault.sh \"/path/to/Obsidian Vault\"" >&2
  exit 1
fi

DEST="$VAULT_PATH/.obsidian/plugins/anki-dispatch"
mkdir -p "$DEST"

if [ ! -f "$PROJECT_DIR/main.js" ]; then
  (cd "$PROJECT_DIR" && npm run build)
fi

cp "$PROJECT_DIR/main.js" "$PROJECT_DIR/manifest.json" "$PROJECT_DIR/styles.css" "$DEST/"
echo "Installed Anki Dispatch to: $DEST"
