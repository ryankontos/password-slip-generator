#!/bin/zsh
set -e
cd "${0:A:h}"

PYTHON="/usr/bin/python3"
if [[ ! -x "$PYTHON" ]]; then
  print -u2 -- "The macOS built-in Python is unavailable. Install Apple's Command Line Tools first."
  exit 1
fi

exec "$PYTHON" src/migrate_settings_to_env.py "$@"
