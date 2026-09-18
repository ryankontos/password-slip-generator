#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/run_password_slip_studio.command" "$@"
