#!/usr/bin/env bash
set -euo pipefail
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo 'CreateOS MCP requires Node.js 22 or newer.' >&2; exit 1; }
exec node "$plugin_root/mcp/server.mjs"
