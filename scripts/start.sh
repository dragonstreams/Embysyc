#!/usr/bin/env bash
#
# start.sh — Start the Embysyc API server + Discord bot locally.
#
# Usage (from anywhere):
#   ./scripts/start.sh
#   ./scripts/start.sh --build    # rebuild before starting
#
# Requires a .env file in the repo root with at least:
#   PORT=5000
#   DISCORD_TOKEN=...

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

# Prefer user-local pnpm if present
export PATH="${HOME}/.local/bin:${PATH}"

BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      BUILD=1
      shift
      ;;
    -h|--help)
      echo "Usage: ./scripts/start.sh [--build]"
      echo ""
      echo "  --build   Run pnpm build before starting"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: ./scripts/start.sh [--build]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f .env ]]; then
  echo "❌ Error: .env not found in ${ROOT_DIR}" >&2
  echo "   Create .env with PORT and DISCORD_TOKEN." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${PORT:-}" ]]; then
  echo "❌ Error: PORT is not set in .env" >&2
  exit 1
fi

if [[ -z "${DISCORD_TOKEN:-}" ]]; then
  echo "❌ Error: DISCORD_TOKEN is not set in .env" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ Error: pnpm not found. Install with: npm install -g pnpm@10.26.1" >&2
  exit 1
fi

if [[ ! -f artifacts/api-server/dist/index.mjs ]] || [[ $BUILD -eq 1 ]]; then
  echo "==> Building @workspace/api-server..."
  pnpm --filter @workspace/api-server run build
  echo
fi

echo "==> Starting Embysyc on port ${PORT}..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
