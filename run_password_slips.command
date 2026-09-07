#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
exec /usr/bin/python3 start_password_slips.py "$@"
