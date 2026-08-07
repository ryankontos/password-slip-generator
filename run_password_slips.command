#!/bin/zsh
set -e
cd "${0:A:h}"

SYSTEM_PYTHON="/usr/bin/python3"
VENV_PYTHON=".venv/bin/python"

if [[ ! -x "$SYSTEM_PYTHON" ]]; then
  MESSAGE="The macOS built-in Python is unavailable. Install Apple's Command Line Tools, then open this file again."
  /usr/bin/osascript -e "display dialog \"$MESSAGE\" with title \"password-slip-generator\" buttons {\"OK\"} default button \"OK\" with icon stop" 2>/dev/null || true
  print -u2 -- "$MESSAGE"
  exit 1
fi

SYSTEM_BASE_PREFIX="$("$SYSTEM_PYTHON" -c 'import sys; print(sys.base_prefix)')"
if [[ -x "$VENV_PYTHON" ]] && ! "$VENV_PYTHON" -c 'import sys; raise SystemExit(0 if sys.base_prefix == sys.argv[1] else 1)' "$SYSTEM_BASE_PREFIX" >/dev/null 2>&1; then
  rm -rf .venv
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
  "$SYSTEM_PYTHON" -m venv .venv
fi

if ! "$VENV_PYTHON" -c 'import openpyxl, reportlab' >/dev/null 2>&1; then
  "$VENV_PYTHON" -m pip install -r requirements.txt
fi
exec "$VENV_PYTHON" src/password_slips.py
