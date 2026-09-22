#!/usr/bin/env python3
"""Launch Password Slip Studio as a resilient local background service."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
VENV = Path(os.environ.get("PASSWORD_SLIP_STUDIO_VENV", str(ROOT / ".venv"))).expanduser()
LOG = ROOT / "runtime" / "studio-service.log"
sys.path.insert(0, str(SRC))
from studio_service import consume_control_action, control_file_for_port, git_text  # noqa: E402


def say(message: str) -> None:
    print(f"Password Slip Studio  ·  {message}", flush=True)


def target(arguments: list[str]) -> tuple[str, int]:
    host, port = "127.0.0.1", 8768
    for index, arg in enumerate(arguments):
        if arg == "--host" and index + 1 < len(arguments):
            host = arguments[index + 1]
        elif arg.startswith("--host="):
            host = arg.split("=", 1)[1]
        elif arg == "--port" and index + 1 < len(arguments):
            port = int(arguments[index + 1])
        elif arg.startswith("--port="):
            port = int(arg.split("=", 1)[1])
    if host == "localhost":
        host = "127.0.0.1"
    if host != "127.0.0.1" or not 1024 <= port <= 65535:
        raise ValueError("Studio can only run on localhost with a port from 1024 to 65535.")
    return host, port


def service_url(arguments: list[str]) -> str:
    host, port = target(arguments)
    return f"http://{host}:{port}/"


def request_json(url: str, post: bool = False) -> dict | None:
    try:
        request = urllib.request.Request(
            url, method="POST" if post else "GET", data=b"{}" if post else None,
            headers={"Content-Type": "application/json", "User-Agent": "Password Slip Studio launcher"},
        )
        with urllib.request.urlopen(request, timeout=1) as response:
            payload = json.loads(response.read(8192))
        return payload if isinstance(payload, dict) else None
    except (OSError, ValueError):
        return None


def runtime(url: str) -> dict | None:
    result = request_json(url + "api/runtime")
    return result if result and result.get("name") == "Password Slip Studio" else None


def wait_for(url: str, running: bool, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if bool(runtime(url)) is running:
            return True
        time.sleep(0.15)
    return False


def ensure_environment() -> Path:
    python = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        say("Creating the project environment (first run only)…")
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    available = subprocess.run([str(python), "-c", "import openpyxl, reportlab"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0
    if not available:
        say("Installing workbook and PDF support (first run only)…")
        subprocess.run([str(python), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")], check=True)
    return python


def environment() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    return env


def service_log():
    LOG.parent.mkdir(parents=True, exist_ok=True)
    if LOG.exists() and LOG.stat().st_size > 2_000_000:
        LOG.replace(LOG.with_suffix(".log.1"))
    return LOG.open("a", encoding="utf-8")


def supervise(arguments: list[str]) -> int:
    url = service_url(arguments)
    if runtime(url):
        return 0
    control = control_file_for_port(target(arguments)[1])
    control.parent.mkdir(parents=True, exist_ok=True)
    control.unlink(missing_ok=True)
    while True:
        env = environment()
        env["PASSWORD_SLIP_STUDIO_CONTROL"] = str(control)
        with service_log() as log:
            process = subprocess.Popen(
                [str(ensure_environment()), str(SRC / "studio_server.py"),
                 *[arg for arg in arguments if arg != "--no-open"]],
                cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            )
        while True:
            action = consume_control_action(control)
            if action:
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                if action == "quit":
                    return 0
                break
            code = process.poll()
            if code is not None:
                completed_action = consume_control_action(control)
                if completed_action == "quit":
                    return 0
                if completed_action == "restart":
                    break
                if code == 0 or runtime(url):
                    return 0
                say(f"Web process exited ({code}); restarting…")
                break
            time.sleep(0.25)
        time.sleep(0.5)


def start_background(arguments: list[str]) -> int:
    url = service_url(arguments)
    python = ensure_environment()
    with service_log() as log:
        flags = (getattr(subprocess, "DETACHED_PROCESS", 0) |
                 getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)) if os.name == "nt" else 0
        subprocess.Popen(
            [str(python), str(ROOT / "start_password_slip_studio.py"), "--service", *arguments],
            cwd=ROOT, env=environment(), stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT,
            start_new_session=os.name != "nt", creationflags=flags,
        )
    if not wait_for(url, True, 30):
        raise RuntimeError(f"The service did not become ready. Check {LOG}.")
    say(f"Running in the background at {url}")
    if "--no-open" not in arguments:
        webbrowser.open(url)
    return 0


def main() -> int:
    try:
        args = sys.argv[1:]
        service, foreground = "--service" in args, "--foreground" in args
        args = [arg for arg in args if arg not in {"--service", "--foreground"}]
        if "--help" in args or "-h" in args:
            return subprocess.run([sys.executable, str(SRC / "studio_server.py"), "--help"], check=False).returncode
        url = service_url(args)
        if service:
            return supervise(args)
        existing = runtime(url)
        if existing:
            if existing.get("root") and existing["root"] != str(ROOT):
                raise ValueError(f"Port {target(args)[1]} is used by another Studio checkout.")
            same_commit = existing.get("commit_id") == git_text("rev-parse", "HEAD")
            same_mode = bool(existing.get("background")) is not foreground
            if same_commit and same_mode:
                say("Already running.")
                if "--no-open" not in args:
                    webbrowser.open(url)
                return 0
            say("Restarting the running Studio in the requested mode…")
            if not request_json(url + "api/shutdown", post=True) or not wait_for(url, False, 8):
                raise RuntimeError("Could not stop the previous Studio. Close its launcher and try again.")
        python = ensure_environment()
        if foreground:
            if "--no-open" not in args:
                threading.Thread(target=lambda: wait_for(url, True, 15) and webbrowser.open(url),
                                 daemon=True).start()
            return subprocess.run([str(python), str(SRC / "studio_server.py"),
                                   *[arg for arg in args if arg != "--no-open"]],
                                  cwd=ROOT, env=environment(), check=False).returncode
        return start_background(args)
    except (OSError, subprocess.CalledProcessError, ValueError, RuntimeError) as exc:
        print(f"Password Slip Studio could not start: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
