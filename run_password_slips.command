#!/bin/zsh
set -e
cd "${0:A:h}"

is_compatible_python() {
  [[ -x "$1" ]] || return 1
  "$1" -c 'import sys, tkinter; raise SystemExit(0 if sys.version_info >= (3, 9) and tkinter.TkVersion >= 8.6 else 1)' \
    >/dev/null 2>&1
}

find_python() {
  local candidate
  local -a candidates=(
    "${PASSWORD_SLIPS_PYTHON:-}"
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3"
    "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3"
    "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3"
    "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
    "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3"
    "/usr/local/bin/python3"
    "/opt/homebrew/bin/python3"
  )

  for candidate in $candidates; do
    if is_compatible_python "$candidate"; then
      print -r -- "$candidate"
      return 0
    fi
  done

  for candidate in python3.14 python3.13 python3.12 python3.11 python3; do
    candidate="$(command -v "$candidate" 2>/dev/null || true)"
    if is_compatible_python "$candidate"; then
      print -r -- "$candidate"
      return 0
    fi
  done
  return 1
}

if ! is_compatible_python .venv/bin/python; then
  PYTHON="$(find_python || true)"
  if [[ -z "$PYTHON" ]]; then
    MESSAGE="password-slip-generator needs Python 3.9 or newer with Tk 8.6 or newer. Install the current macOS Python from python.org, then open this file again. The Xcode Python alone uses old Tk 8.5 and may display a blank window."
    /usr/bin/osascript -e "display dialog \"$MESSAGE\" with title \"password-slip-generator\" buttons {\"OK\"} default button \"OK\" with icon stop" 2>/dev/null || true
    print -u2 -- "$MESSAGE"
    exit 1
  fi
  rm -rf .venv
  "$PYTHON" -m venv .venv
fi

if ! .venv/bin/python -c 'import openpyxl, reportlab' >/dev/null 2>&1; then
  .venv/bin/python -m pip install -r requirements.txt
fi
exec .venv/bin/python password_slips.py
