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
UPDATE_INTERVAL_SECONDS = 60
UPDATE_NOTES_DIRECTORY = "update-notes"
UPDATE_NOTES_MAX_COUNT = 20
UPDATE_NOTE_MAX_CHARACTERS = 6000
UPDATE_CHANNELS = {
    "stable": {"label": "Stable releases", "branch": "master"},
    # Keep development isolated from the older, unrelated `main` history.
    "development": {"label": "Development builds", "branch": "development"},
}


def update_notes_since(base_commit: str, target_ref: str) -> list[dict[str, str]]:
    """Read bounded Markdown release notes added or changed by an update."""
    changed = git(
        "diff", "--name-only", "--diff-filter=ACMR",
        f"{base_commit}..{target_ref}", "--", UPDATE_NOTES_DIRECTORY,
    )
    if changed.returncode != 0:
        return []
    notes: list[dict[str, str]] = []
    for path in sorted(set(changed.stdout.splitlines()), reverse=True)[:UPDATE_NOTES_MAX_COUNT]:
        parts = path.split("/")
        if (len(parts) != 2 or parts[0] != UPDATE_NOTES_DIRECTORY
                or not parts[1].lower().endswith(".md")
                or parts[1] in {"", ".", ".."}):
            continue
        result = git("show", f"{target_ref}:{path}", timeout=5)
        if result.returncode != 0:
            continue
        markdown = result.stdout.strip()
        if markdown:
            notes.append({"file": parts[1], "markdown": markdown[:UPDATE_NOTE_MAX_CHARACTERS]})
    return notes


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
            "checking": False, "manual_check": False, "updating": False, "update_available": False,
            "update_error": "", "update_message": "Checking for updates…",
            "remote_commit": "", "behind_count": 0, "last_checked": 0,
            "can_fast_forward": False, "channel_switch_required": False,
            "working_tree_clean": False, "update_notes": [],
        }
        threading.Thread(target=self._poll, name="studio-update-monitor", daemon=True).start()

    def _branch(self) -> str:
        settings = read_settings()
        channel = settings.get("update_channel")
        if isinstance(channel, str) and channel in UPDATE_CHANNELS:
            return UPDATE_CHANNELS[channel]["branch"]
        # Migrate an existing explicit branch choice when possible.
        legacy_branch = str(settings.get("update_branch") or "").strip()
        for config in UPDATE_CHANNELS.values():
            if legacy_branch == config["branch"]:
                return legacy_branch
        return UPDATE_CHANNELS["stable"]["branch"]

    def _channel(self) -> str:
        settings = read_settings()
        channel = settings.get("update_channel")
        if isinstance(channel, str) and channel in UPDATE_CHANNELS:
            return channel
        legacy_branch = str(settings.get("update_branch") or "").strip()
        return next((name for name, config in UPDATE_CHANNELS.items()
                     if legacy_branch == config["branch"]), "stable")

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
            "branch": self._branch(), "update_channel": self._channel(),
            "channel_label": UPDATE_CHANNELS[self._channel()]["label"],
            "channels": {name: {**config, "available": config["branch"] in available_branches()}
                         for name, config in UPDATE_CHANNELS.items()},
            "branches": available_branches(),
            "current_branch": current_branch(), "current_commit": git_text("rev-parse", "HEAD"),
            "running_commit": self.server.commit_id,
            "background": self.supervised, "start_at_login_supported": sys.platform == "darwin",
            "start_at_login": self._login_agent_path().exists() if sys.platform == "darwin" else False,
        })
        return result

    def request_check(self) -> dict[str, Any]:
        with self._lock:
            if self._state["updating"]:
                return self.status()
            if self._state["checking"]:
                self._state["manual_check"] = True
                self._state["update_message"] = "Checking for updates…"
                return self.status()
        threading.Thread(target=self._check, kwargs={"manual": True},
                         name="studio-update-check", daemon=True).start()
        return self.status()

    def _check(self, *, manual: bool = False) -> None:
        with self._lock:
            if self._state["checking"] or self._state["updating"]:
                if manual and self._state["checking"]:
                    self._state["manual_check"] = True
                    self._state["update_message"] = "Checking for updates…"
                return
            self._state["checking"] = True
            self._state["manual_check"] = manual
            if manual:
                self._state.update(update_error="", update_message="Checking for updates…")
        branch = self._branch()
        channel = self._channel()
        try:
            with self._git_lock:
                if git("remote", "get-url", "origin", timeout=5).returncode != 0:
                    raise RuntimeError("No Git origin is configured for updates.")
                remote_ref = f"refs/remotes/origin/{branch}"
                fetched = git("fetch", "--quiet", "origin", f"+refs/heads/{branch}:{remote_ref}", timeout=60)
                if fetched.returncode != 0:
                    remote_branch = git("ls-remote", "--heads", "origin", f"refs/heads/{branch}", timeout=15)
                    if remote_branch.returncode == 0 and not remote_branch.stdout.strip():
                        raise RuntimeError(f"The {UPDATE_CHANNELS[channel]['label']} branch (`{branch}`) is not published on origin.")
                    raise RuntimeError(f"Could not check origin/{branch}. Check the network and repository connection.")
                remote = git_text("rev-parse", "--verify", remote_ref)
                head = git_text("rev-parse", "HEAD")
                if not remote or not head:
                    raise RuntimeError(f"The {UPDATE_CHANNELS[channel]['label']} branch (`{branch}`) is not published yet.")
                on_target_branch = current_branch() == branch
                local_target = git_text("rev-parse", "--verify", f"refs/heads/{branch}") if not on_target_branch else head
                base = local_target or ""
                can_switch_or_fast_forward = True
                behind = 0
                if base:
                    can_switch_or_fast_forward = git("merge-base", "--is-ancestor", base, remote).returncode == 0
                    if can_switch_or_fast_forward:
                        behind = int(git_text("rev-list", "--count", f"{base}..{remote_ref}") or "0")
                else:
                    merge_base = git_text("merge-base", head, remote)
                    behind = int(git_text("rev-list", "--count", f"{merge_base or remote}..{remote_ref}") or "0")
                clean = not bool(git_text("status", "--porcelain", "--untracked-files=all"))
                channel_switch = not on_target_branch
                update_available = channel_switch or (remote != head and behind > 0)
                notes = update_notes_since(head, remote_ref) if update_available else []
            with self._lock:
                self._state.update(
                    branch=branch, remote_commit=remote, current_commit=head,
                    update_channel=channel, channel_label=UPDATE_CHANNELS[channel]["label"],
                    behind_count=behind, update_available=update_available,
                    channel_switch_required=channel_switch,
                    working_tree_clean=clean, can_fast_forward=can_switch_or_fast_forward,
                    update_error="", last_checked=time.time(), update_notes=notes,
                    update_message=(f"Switch to {UPDATE_CHANNELS[channel]['label']} ({branch})." if channel_switch
                                    else f"Update available on {UPDATE_CHANNELS[channel]['label']}." if update_available and can_switch_or_fast_forward
                                    else "This checkout has diverged from the selected update channel. Update it manually."
                                    if update_available else f"Up to date on {UPDATE_CHANNELS[channel]['label']} (branch {branch})."),
                )
        except (OSError, subprocess.SubprocessError, ValueError, RuntimeError) as exc:
            with self._lock:
                self._state.update(update_error=str(exc), update_message=str(exc),
                                   last_checked=time.time(), update_notes=[])
        finally:
            with self._lock:
                self._state["checking"] = False
                self._state["manual_check"] = False

    def set_branch(self, branch: str) -> dict[str, Any]:
        channel = next((name for name, config in UPDATE_CHANNELS.items()
                        if branch == config["branch"]), None)
        if channel is None:
            raise ValueError("Choose an update channel instead of a custom Git branch.")
        return self.set_channel(channel)

    def set_channel(self, channel: str) -> dict[str, Any]:
        if not isinstance(channel, str) or channel not in UPDATE_CHANNELS:
            raise ValueError("Choose Stable releases or Development builds.")
        with self._lock:
            if self._state["updating"] or self._state["checking"]:
                raise ValueError("Wait for the update check to finish before changing channels.")
        values = read_settings()
        values["update_channel"] = channel
        values["update_branch"] = UPDATE_CHANNELS[channel]["branch"]
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
        channel = self._channel()
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
                    raise RuntimeError(f"The {UPDATE_CHANNELS[channel]['label']} branch (`{branch}`) is not published yet.")
                on_target_branch = current_branch() == branch
                if on_target_branch and remote == head:
                    with self._lock:
                        self._state.update(update_available=False, update_message=f"Up to date on {UPDATE_CHANNELS[channel]['label']}.")
                    return
                target_branch_exists = git("show-ref", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0
                if target_branch_exists:
                    target_head = git_text("rev-parse", f"refs/heads/{branch}")
                    if git("merge-base", "--is-ancestor", target_head, remote).returncode != 0:
                        raise RuntimeError("The selected channel branch has local commits or has diverged. No local commits were removed.")
                    if not on_target_branch:
                        switched = git("switch", branch)
                        if switched.returncode != 0:
                            raise RuntimeError(f"Could not switch to {branch}. Update the checkout manually.")
                    if target_head != remote:
                        pulled = git("pull", "--ff-only", "origin", branch, timeout=120)
                        if pulled.returncode != 0:
                            raise RuntimeError("The update could not fast-forward. Update the checkout manually.")
                else:
                    switched = git("switch", "--track", "-c", branch, f"origin/{branch}")
                    if switched.returncode != 0:
                        raise RuntimeError(f"Could not switch to {branch}. Update the checkout manually.")
                new_head = git_text("rev-parse", "HEAD")
                if new_head != remote:
                    raise RuntimeError("The update finished but the new version could not be verified.")
            with self._lock:
                self._state.update(update_available=False, current_commit=new_head, remote_commit=new_head,
                                   behind_count=0, channel_switch_required=False,
                                   update_notes=[], update_message="Restarting Studio…")
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
