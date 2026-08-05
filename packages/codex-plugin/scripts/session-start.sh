#!/usr/bin/env bash
# Session start hook — publish the absolute path of the `cos` driver into context.
set -euo pipefail

# Resolve cos relative to this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cos="$SCRIPT_DIR/cos"

if [ ! -x "$cos" ]; then
  echo "[createos-sandbox] The sandbox driver is MISSING or not executable at: $cos"
  echo "Do not attempt sandbox work. Tell the user the plugin looks broken and stop."
  exit 0
fi

if command -v cos >/dev/null 2>&1; then
  where="cos is already on PATH — call it bare."
else
  where="cos is NOT on PATH. Call it by this absolute path: $cos"
fi

cat <<CONTEXT
[createos-sandbox] The sandbox driver is at: $cos
$where

Picking the verb (get this right before running anything):
- Work with a finish line — run a test suite, a build, a script: cos offload <dir> '<cmd>'. ONE command. It creates the box, ships <dir> for you, runs, and destroys the box.
- Work that must outlive one command — a dev server, a watcher, a multi-command session: cos up, then cos run, then cos pause or cos down.
- cos run takes the command as one plain string; there is no -- separator.

Run $cos help for the full verb list, and read the using-createos-sandbox skill before anything involving egress restriction, networking, or file sync.
CONTEXT
