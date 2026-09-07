#!/usr/bin/env python3
"""One-command launcher for the local Password Slip Generator web UI."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
REQUIREMENTS = ROOT / "requirements.txt"


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if sys.platform.startswith("win") else "bin/python")


def package_available(python: Path, package: str) -> bool:
    return subprocess.run(
        [str(python), "-c", "import %s" % package],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def main() -> int:
    if sys.version_info < (3, 9):
        print("Python 3.9 or newer is required.")
        return 1
    if importlib.util.find_spec("venv") is None:
        print("Python was installed without venv support.")
        return 1
    python = venv_python()
    if not python.exists():
        print("Password Slip Generator  ·  Preparing first launch…", flush=True)
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    if not all(package_available(python, name) for name in ("openpyxl", "reportlab")):
        print("Password Slip Generator  ·  Installing PDF tools…", flush=True)
        subprocess.run([str(python), "-m", "pip", "install", "-r", str(REQUIREMENTS)], check=True)
    return subprocess.run([str(python), str(ROOT / "password_slips_web.py"), *sys.argv[1:]],
                          cwd=str(ROOT), check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
