#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="${MOTEARY_BINARY:-$ROOT/build/moteary}"
DATA="${MOTEARY_DATA:-$ROOT/demo-data}"
PORT="${MOTEARY_PORT:-5231}"
if [[ ! -x "$BINARY" ]]; then
  echo 'Build first: cd web && pnpm release; cd .. && go build -o build/moteary ./cmd/memos' >&2
  exit 1
fi
mkdir -p "$DATA"
exec "$BINARY" --addr 127.0.0.1 --port "$PORT" --data "$DATA" --config-apply off
