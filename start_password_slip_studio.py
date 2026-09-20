#!/usr/bin/env python3
"""One-command launcher for the local Password Slip Studio web app."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser


ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
VENV = Path(os.environ.get("PASSWORD_SLIP_STUDIO_VENV", str(ROOT / ".venv"))).expanduser()
URL = "http://127.0.0.1:8768/"


def say(message: str) -> None:
    print(f"Password Slip Studio  ·  {message}", flush=True)


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def is_running() -> bool:
    try:
        with urllib.request.urlopen(URL + "api/runtime", timeout=0.6) as response:
            return response.status == 200 and "Password Slip Studio" in response.read(2048).decode("utf-8")
    except (OSError, urllib.error.URLError):
        return False


def ensure_environment() -> Path:
    python = venv_python()
    if not python.exists():
        say("Creating the project environment (first run only)…")
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    available = subprocess.run(
        [str(python), "-c", "import openpyxl, reportlab, pymupdf"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0
    if not available:
        say("Installing workbook and PDF support (first run only)…")
        subprocess.run([str(python), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")], check=True)
    return python


def main() -> int:
    no_open = "--no-open" in sys.argv
    arguments = [argument for argument in sys.argv[1:] if argument != "--no-open"]
    if is_running():
        say("The studio is already running.")
        if not no_open:
            webbrowser.open(URL)
        return 0
    try:
        python = ensure_environment()
        env = os.environ.copy()
        env["PYTHONPATH"] = str(SRC) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        process = subprocess.Popen([str(python), str(SRC / "studio_server.py"), *arguments], cwd=ROOT, env=env)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline and process.poll() is None:
            if is_running():
                say(f"Ready at {URL}")
                if not no_open:
                    webbrowser.open(URL)
                return process.wait()
            time.sleep(0.1)
        return process.wait() if process.poll() is not None else 1
    except subprocess.CalledProcessError as exc:
        print(f"Password Slip Studio could not start (setup exited {exc.returncode}).", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
