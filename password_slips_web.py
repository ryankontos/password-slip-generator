#!/usr/bin/env python3
"""Entry point for the local Password Slip Generator web interface."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

from slip_web import cli  # noqa: E402


if __name__ == "__main__":
    cli()
