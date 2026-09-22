"""Background service, login launch, and safe Git updates for the studio."""

from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import threading
import time
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "runtime"
SETTINGS = RUNTIME / "service-settings.json"
SERVICE_LABEL = "com.ryankontos.password-slip-studio"
UPDATE_INTERVAL_SECONDS = 300


def control_file_for_port(port: int) -> Path:
    return RUNTIME / f"service-control-{port}.json"


def git(*arguments: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(ROOT), *arguments], capture_output=True, text=True,
        check=False, timeout=timeout, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )


def git_text(*arguments: str, timeout: int = 30) -> str:
    result = git(*arguments, timeout=timeout)
    return result.stdout.strip() if result.returncode == 0 else ""


def current_branch() -> str:
    return git_text("branch", "--show-current") or "master"


def valid_branch(branch: str) -> bool:
    value = str(branch or "").strip()
    return bool(value and not value.startswith("-") and len(value) <= 240
                and git("check-ref-format", "--branch", value, timeout=5).returncode == 0)


def available_branches() -> list[str]:
    names = git_text("branch", "--remotes", "--format=%(refname:short)")
    result = {line.removeprefix("origin/") for line in names.splitlines()
              if line.startswith("origin/") and line != "origin/HEAD"}
    result = {name for name in result if valid_branch(name)}
    return sorted(result, key=lambda name: (name != current_branch(), name.casefold()))


def read_settings() -> dict[str, Any]:
    try:
        payload = json.loads(SETTINGS.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(values: dict[str, Any]) -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    temporary = SETTINGS.with_suffix(".tmp")
    temporary.write_text(json.dumps(values, indent=2) + "\n", encoding="utf-8")
    temporary.replace(SETTINGS)


def write_control_action(action: str, path: Path) -> None:
    if action not in {"restart", "quit"}:
        raise ValueError("Unknown service action.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"action": action, "at": time.time()}), encoding="utf-8")
    temporary.replace(path)


def consume_control_action(path: Path) -> str:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        path.unlink(missing_ok=True)
    except (OSError, ValueError):
        return ""
    action = payload.get("action") if isinstance(payload, dict) else None
    return action if action in {"restart", "quit"} else ""


class StudioService:
    def __init__(self, server: Any) -> None:
        self.server = server
        self.supervised = bool(os.environ.get("PASSWORD_SLIP_STUDIO_CONTROL"))
        self.control_file = Path(os.environ["PASSWORD_SLIP_STUDIO_CONTROL"]) if self.supervised else control_file_for_port(server.server_port)
        self._lock = threading.RLock()
        self._git_lock = threading.Lock()
        self._stop = threading.Event()
        self._state: dict[str, Any] = {
            "checking": False, "updating": False, "update_available": False,
            "update_error": "", "update_message": "Checking for updates…",
            "remote_commit": "", "behind_count": 0, "last_checked": 0,
            "can_fast_forward": False, "working_tree_clean": False,
        }
        threading.Thread(target=self._poll, name="studio-update-monitor", daemon=True).start()

    def _branch(self) -> str:
        selected = str(read_settings().get("update_branch") or current_branch())
        return selected if valid_branch(selected) else current_branch()

    def _poll(self) -> None:
        while not self._stop.is_set():
            self._check()
            self._stop.wait(UPDATE_INTERVAL_SECONDS)

    def stop(self) -> None:
        self._stop.set()

    def status(self) -> dict[str, Any]:
        with self._lock:
            result = dict(self._state)
        result.update({
            "branch": self._branch(), "branches": available_branches(),
            "current_branch": current_branch(), "current_commit": git_text("rev-parse", "HEAD"),
            "running_commit": self.server.commit_id,
            "background": self.supervised, "start_at_login_supported": sys.platform == "darwin",
            "start_at_login": self._login_agent_path().exists() if sys.platform == "darwin" else False,
        })
        return result

    def request_check(self) -> dict[str, Any]:
        threading.Thread(target=self._check, name="studio-update-check", daemon=True).start()
        return self.status()

    def _check(self) -> None:
        with self._lock:
            if self._state["checking"] or self._state["updating"]:
                return
            self._state.update(checking=True, update_error="", update_message="Checking for updates…")
        branch = self._branch()
        try:
            with self._git_lock:
                if git("remote", "get-url", "origin", timeout=5).returncode != 0:
                    raise RuntimeError("No Git origin is configured for updates.")
                remote_ref = f"refs/remotes/origin/{branch}"
                fetched = git("fetch", "--quiet", "origin", f"+refs/heads/{branch}:{remote_ref}", timeout=60)
                if fetched.returncode != 0:
                    raise RuntimeError(f"Could not check origin/{branch}. Check the network and branch name.")
                remote = git_text("rev-parse", "--verify", remote_ref)
                head = git_text("rev-parse", "HEAD")
                if not remote or not head:
                    raise RuntimeError(f"origin/{branch} is not available.")
                behind = int(git_text("rev-list", "--count", f"HEAD..{remote_ref}") or "0")
                clean = not bool(git_text("status", "--porcelain", "--untracked-files=all"))
                fast_forward = git("merge-base", "--is-ancestor", head, remote).returncode == 0
            with self._lock:
                self._state.update(
                    branch=branch, remote_commit=remote, current_commit=head,
                    behind_count=behind, update_available=remote != head and behind > 0,
                    working_tree_clean=clean, can_fast_forward=fast_forward,
                    update_error="", last_checked=time.time(),
                    update_message=(f"Update available on {branch}." if remote != head and behind > 0 and fast_forward
                                    else "This checkout has diverged from the selected branch. Update it manually."
                                    if remote != head and behind > 0 else f"No updates on {branch}."),
                )
        except (OSError, subprocess.SubprocessError, ValueError, RuntimeError) as exc:
            with self._lock:
                self._state.update(update_error=str(exc), update_message=str(exc), last_checked=time.time())
        finally:
            with self._lock:
                self._state["checking"] = False

    def set_branch(self, branch: str) -> dict[str, Any]:
        if not valid_branch(branch):
            raise ValueError("Choose a valid Git branch.")
        if branch not in available_branches() and branch != current_branch():
            raise ValueError("Choose a branch available on origin.")
        with self._lock:
            if self._state["updating"]:
                raise ValueError("Wait for the update to finish before changing branches.")
        values = read_settings()
        values["update_branch"] = branch
        save_settings(values)
        self.request_check()
        return self.status()

    def request_update(self) -> dict[str, Any]:
        with self._lock:
            if self._state["updating"]:
                return self.status()
            self._state.update(updating=True, update_error="", update_message="Preparing update…")
        threading.Thread(target=self._update, name="studio-git-update", daemon=True).start()
        return self.status()

    def _update(self) -> None:
        branch = self._branch()
        try:
            with self._git_lock:
                if git_text("status", "--porcelain", "--untracked-files=all"):
                    raise RuntimeError("Commit or move local changes before updating Studio.")
                remote_ref = f"refs/remotes/origin/{branch}"
                fetched = git("fetch", "--quiet", "origin", f"+refs/heads/{branch}:{remote_ref}", timeout=60)
                if fetched.returncode != 0:
                    raise RuntimeError(f"Could not download origin/{branch}.")
                remote = git_text("rev-parse", "--verify", remote_ref)
                head = git_text("rev-parse", "HEAD")
                if not remote or not head:
                    raise RuntimeError(f"origin/{branch} is not available.")
                if remote == head:
                    with self._lock:
                        self._state.update(update_available=False, update_message=f"Up to date on {branch}.")
                    return
                if git("merge-base", "--is-ancestor", head, remote).returncode != 0:
                    raise RuntimeError("The selected branch has diverged from this checkout. Update it manually.")
                if current_branch() != branch:
                    switched = git("switch", branch) if git("show-ref", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0 else git("switch", "--track", "-c", branch, f"origin/{branch}")
                    if switched.returncode != 0:
                        raise RuntimeError(f"Could not switch to {branch}. Update it manually.")
                pulled = git("pull", "--ff-only", "origin", branch, timeout=120)
                if pulled.returncode != 0:
                    raise RuntimeError("The update could not fast-forward. Update the checkout manually.")
                new_head = git_text("rev-parse", "HEAD")
                if new_head != remote:
                    raise RuntimeError("The update finished but the new version could not be verified.")
            with self._lock:
                self._state.update(update_available=False, current_commit=new_head, remote_commit=new_head,
                                   behind_count=0, update_message="Restarting Studio…")
            if self.supervised:
                write_control_action("restart", self.control_file)
            else:
                self.server.restart_requested = True
            self._shutdown()
        except (OSError, subprocess.SubprocessError, ValueError, RuntimeError) as exc:
            with self._lock:
                self._state.update(update_error=str(exc), update_message=str(exc))
        finally:
            with self._lock:
                self._state["updating"] = False

    def request_quit(self) -> dict[str, Any]:
        if self.supervised:
            write_control_action("quit", self.control_file)
        self._shutdown()
        return {"stopping": True}

    def _shutdown(self) -> None:
        timer = threading.Timer(0.4, self.server.shutdown)
        timer.daemon = True
        timer.start()

    def _login_agent_path(self) -> Path:
        return Path.home() / "Library" / "LaunchAgents" / f"{SERVICE_LABEL}.plist"

    def _login_agent_payload(self) -> dict[str, Any]:
        return {
            "Label": SERVICE_LABEL,
            "ProgramArguments": [sys.executable, str(ROOT / "start_password_slip_studio.py"),
                                 "--service", "--no-open", "--port", str(self.server.server_port)],
            "WorkingDirectory": str(ROOT), "RunAtLoad": True,
            "KeepAlive": {"SuccessfulExit": False}, "ProcessType": "Background",
            "StandardOutPath": str(RUNTIME / "studio-service.log"),
            "StandardErrorPath": str(RUNTIME / "studio-service.log"),
        }

    def set_start_at_login(self, enabled: bool) -> dict[str, Any]:
        if sys.platform != "darwin":
            raise ValueError("Start at login is available on macOS only.")
        path = self._login_agent_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        RUNTIME.mkdir(parents=True, exist_ok=True)
        previous = path.read_bytes() if path.exists() else None
        if enabled:
            temporary = path.with_suffix(".tmp")
            temporary.write_bytes(plistlib.dumps(self._login_agent_payload(), fmt=plistlib.FMT_XML))
            temporary.replace(path)
        target = f"gui/{os.getuid()}/{SERVICE_LABEL}"
        result = subprocess.run(["launchctl", "enable" if enabled else "disable", target],
                                capture_output=True, text=True, check=False, timeout=10)
        if result.returncode != 0:
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(previous)
            raise RuntimeError("macOS could not change the login setting: " +
                               " ".join((result.stderr or result.stdout).split())[:200])
        if not enabled:
            path.unlink(missing_ok=True)
        return self.status()
