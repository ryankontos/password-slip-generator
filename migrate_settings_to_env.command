#!/bin/zsh
set -e
cd "${0:A:h}"

if [[ -x .venv/bin/python ]]; then
  PYTHON=".venv/bin/python"
else
  PYTHON="$(command -v python3 2>/dev/null || true)"
fi

if [[ -z "$PYTHON" ]]; then
  print -u2 -- "Python 3.9 or newer is required."
  exit 1
fi

exec "$PYTHON" src/migrate_settings_to_env.py "$@"
