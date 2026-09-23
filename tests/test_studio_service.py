"""Checks for the local service controls without changing system settings."""

from __future__ import annotations

from pathlib import Path
import plistlib
import sys
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import studio_service  # noqa: E402


class ServiceControlTests(unittest.TestCase):
    def test_channel_preferences_map_to_configured_refs(self) -> None:
        service = studio_service.StudioService.__new__(studio_service.StudioService)
        with patch.object(studio_service, "read_settings", return_value={"update_channel": "development"}):
            self.assertEqual(service._channel(), "development")
            self.assertEqual(service._branch(), "development")
        with patch.object(studio_service, "read_settings", return_value={"update_branch": "main"}):
            self.assertEqual(service._branch(), "master")
            self.assertEqual(service._channel(), "stable")
        with patch.object(studio_service, "read_settings", return_value={"update_channel": ["unexpected"]}):
            self.assertEqual(service._branch(), "master")
            self.assertEqual(service._channel(), "stable")

    def test_set_channel_persists_and_starts_a_check(self) -> None:
        service = studio_service.StudioService.__new__(studio_service.StudioService)
        service._lock = threading.RLock()
        service._state = {"checking": False, "updating": False}
        service.request_check = Mock(return_value={"checking": True})
        service.status = Mock(return_value={"checking": True})
        with (patch.object(studio_service, "read_settings", return_value={"keep": "value"}),
              patch.object(studio_service, "save_settings") as save):
            self.assertEqual(service.set_channel("development"), {"checking": True})
        save.assert_called_once_with({"keep": "value", "update_channel": "development",
                                      "update_branch": "development"})
        service.request_check.assert_called_once_with()

    def test_channel_switch_can_create_tracking_branch_without_resetting_old_branch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = studio_service.StudioService.__new__(studio_service.StudioService)
            service._lock = threading.RLock()
            service._git_lock = threading.Lock()
            service._state = {"updating": True, "update_error": ""}
            service._branch = Mock(return_value="development")
            service._channel = Mock(return_value="development")
            service.supervised = True
            service.control_file = Path(directory) / "control.json"
            service._shutdown = Mock()
            service.server = Mock()

            def fake_text(*args, **_kwargs):
                if args[:2] == ("status", "--porcelain"):
                    return ""
                if args[0] == "rev-parse" and args[-1] == "refs/remotes/origin/development":
                    return "development-commit"
                if args[0] == "rev-parse" and args[-1] == "HEAD":
                    return "development-commit" if fake_text.switched else "master-commit"
                return ""

            fake_text.switched = False

            def fake_git(*args, **_kwargs):
                if args[:3] == ("show-ref", "--verify", "--quiet"):
                    return Mock(returncode=1)
                if args[:2] == ("switch", "--track"):
                    fake_text.switched = True
                return Mock(returncode=0)

            with (patch.object(studio_service, "git_text", side_effect=fake_text),
                  patch.object(studio_service, "git", side_effect=fake_git),
                  patch.object(studio_service, "current_branch", return_value="master")):
                service._update()

            self.assertEqual(studio_service.consume_control_action(service.control_file), "restart")
            self.assertFalse(service._state["updating"])
            service._shutdown.assert_called_once()

    def test_channel_switch_is_reported_before_installing(self) -> None:
        service = studio_service.StudioService.__new__(studio_service.StudioService)
        service._lock = threading.RLock()
        service._git_lock = threading.Lock()
        service._state = {"checking": False, "updating": False}
        service._branch = Mock(return_value="development")
        service._channel = Mock(return_value="development")

        def fake_text(*args, **_kwargs):
            if args[0] == "rev-parse" and args[-1] == "refs/remotes/origin/development":
                return "development-commit"
            if args[0] == "rev-parse" and args[-1] == "HEAD":
                return "master-commit"
            if args[0] == "rev-list":
                return "3"
            return ""

        with (patch.object(studio_service, "git", return_value=Mock(returncode=0)),
              patch.object(studio_service, "git_text", side_effect=fake_text),
              patch.object(studio_service, "current_branch", return_value="master"),
              patch.object(studio_service, "update_notes_since", return_value=[{"file": "notes.md", "markdown": "Changes"}])):
            service._check(manual=True)

        self.assertTrue(service._state["update_available"])
        self.assertTrue(service._state["channel_switch_required"])
        self.assertTrue(service._state["can_fast_forward"])
        self.assertEqual(service._state["behind_count"], 3)
        self.assertEqual(service._state["update_notes"], [{"file": "notes.md", "markdown": "Changes"}])
        self.assertFalse(service._state["checking"])

    def test_missing_channel_ref_has_a_clear_status(self) -> None:
        service = studio_service.StudioService.__new__(studio_service.StudioService)
        service._lock = threading.RLock()
        service._git_lock = threading.Lock()
        service._state = {"checking": False, "updating": False}
        service._branch = Mock(return_value="development")
        service._channel = Mock(return_value="development")

        def fake_git(*args, **_kwargs):
            if args[0] == "fetch":
                return subprocess.CompletedProcess(args, 1, "", "missing branch")
            if args[0] == "ls-remote":
                return subprocess.CompletedProcess(args, 0, "", "")
            return subprocess.CompletedProcess(args, 0, "", "")

        with (patch.object(studio_service, "git", side_effect=fake_git),
              patch.object(studio_service, "git_text", return_value="")):
            service._check()

        self.assertIn("Development builds branch (`development`) is not published", service._state["update_error"])
        self.assertFalse(service._state["checking"])
    def test_update_notes_only_read_top_level_markdown_and_bound_content(self) -> None:
        long_note = "N" * (studio_service.UPDATE_NOTE_MAX_CHARACTERS + 25)

        def fake_git(*args, **_kwargs):
            if args[:2] == ("diff", "--name-only"):
                return subprocess.CompletedProcess(args, 0, "\n".join([
                    "update-notes/first.md", "update-notes/second.MD",
                    "update-notes/nested/ignored.md", "update-notes/unsafe\\nname.md",
                    "web/app.js",
                ]), "")
            if args[0] == "show" and args[-1] == "target:update-notes/first.md":
                return subprocess.CompletedProcess(args, 0, long_note, "")
            if args[0] == "show" and args[-1] == "target:update-notes/second.MD":
                return subprocess.CompletedProcess(args, 0, "  ## Changes  \n", "")
            return subprocess.CompletedProcess(args, 1, "", "missing")

        with patch.object(studio_service, "git", side_effect=fake_git):
            notes = studio_service.update_notes_since("base", "target")

        self.assertEqual([note["file"] for note in notes], ["second.MD", "first.md"])
        self.assertEqual(notes[0]["markdown"], "## Changes")
        self.assertEqual(len(notes[1]["markdown"]), studio_service.UPDATE_NOTE_MAX_CHARACTERS)

    def test_control_actions_are_consumed_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "control.json"
            studio_service.write_control_action("restart", target)
            self.assertEqual(studio_service.consume_control_action(target), "restart")
            self.assertEqual(studio_service.consume_control_action(target), "")
            with self.assertRaises(ValueError):
                studio_service.write_control_action("delete", target)

    def test_login_agent_can_be_written_and_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = root / "LaunchAgents" / "com.ryankontos.password-slip-studio.plist"
            service = studio_service.StudioService.__new__(studio_service.StudioService)
            service.server = Mock(server_port=8878)
            service.status = Mock(side_effect=lambda: {"start_at_login": agent.exists()})
            with (patch.object(studio_service, "RUNTIME", root / "runtime"),
                  patch.object(studio_service, "SERVICE_LABEL", "com.ryankontos.password-slip-studio"),
                  patch.object(studio_service.StudioService, "_login_agent_path", return_value=agent),
                  patch.object(studio_service.sys, "platform", "darwin"),
                  patch.object(studio_service.subprocess, "run", return_value=Mock(returncode=0))):
                self.assertTrue(service.set_start_at_login(True)["start_at_login"])
                payload = plistlib.loads(agent.read_bytes())
                self.assertIn("--service", payload["ProgramArguments"])
                self.assertIn("--no-open", payload["ProgramArguments"])
                self.assertIn("8878", payload["ProgramArguments"])
                self.assertFalse(service.set_start_at_login(False)["start_at_login"])
                self.assertFalse(agent.exists())

    def test_update_refuses_local_edits(self) -> None:
        service = studio_service.StudioService.__new__(studio_service.StudioService)
        service._lock = threading.RLock()
        service._git_lock = threading.Lock()
        service._state = {"updating": True, "update_error": ""}
        service._branch = Mock(return_value="master")
        service.supervised = False
        service.server = Mock()
        with patch.object(studio_service, "git_text", return_value=" M web/app.js"):
            service._update()
        self.assertIn("local changes", service._state["update_error"])
        self.assertFalse(service._state["updating"])
        service.server.shutdown.assert_not_called()

    def test_update_refuses_to_reset_a_diverged_channel_branch(self) -> None:
        service = studio_service.StudioService.__new__(studio_service.StudioService)
        service._lock = threading.RLock()
        service._git_lock = threading.Lock()
        service._state = {"updating": True, "update_error": ""}
        service._branch = Mock(return_value="development")
        service._channel = Mock(return_value="development")
        service.supervised = False
        service.server = Mock()
        service._shutdown = Mock()

        def fake_text(*args, **_kwargs):
            if args[:2] == ("status", "--porcelain"):
                return ""
            if args[0] == "rev-parse" and args[-1] == "refs/remotes/origin/development":
                return "remote-commit"
            if args[0] == "rev-parse" and args[-1] == "HEAD":
                return "master-commit"
            if args[0] == "rev-parse" and args[-1] == "refs/heads/development":
                return "local-development-commit"
            return ""

        calls = []

        def fake_git(*args, **_kwargs):
            calls.append(args)
            return Mock(returncode=1 if args[0] == "merge-base" else 0)

        with (patch.object(studio_service, "git_text", side_effect=fake_text),
              patch.object(studio_service, "git", side_effect=fake_git),
              patch.object(studio_service, "current_branch", return_value="master")):
            service._update()

        self.assertIn("No local commits were removed", service._state["update_error"])
        self.assertFalse(service._state["updating"])
        self.assertFalse(any(call[0] == "switch" for call in calls))
        service._shutdown.assert_not_called()

    def test_clean_update_requests_supervisor_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = studio_service.StudioService.__new__(studio_service.StudioService)
            service._lock = threading.RLock()
            service._git_lock = threading.Lock()
            service._state = {"updating": True, "update_error": ""}
            service._branch = Mock(return_value="master")
            service.supervised = True
            service.control_file = Path(directory) / "control.json"
            service._shutdown = Mock()
            service.server = Mock()

            def fake_text(*args, **_kwargs):
                if args[:2] == ("status", "--porcelain"):
                    return ""
                if args[0] == "rev-parse":
                    if args[-1] == "HEAD":
                        return "new" if fake_text.updated else "old"
                    if args[-1] == "refs/remotes/origin/master":
                        return "new"
                    if args[-1] == "refs/heads/master":
                        return "new" if fake_text.updated else "old"
                return ""

            fake_text.updated = False

            def fake_git(*args, **_kwargs):
                if args[0] == "pull":
                    fake_text.updated = True
                return Mock(returncode=0)

            with (patch.object(studio_service, "git_text", side_effect=fake_text),
                  patch.object(studio_service, "git", side_effect=fake_git),
                  patch.object(studio_service, "current_branch", return_value="master")):
                service._update()
            self.assertEqual(studio_service.consume_control_action(service.control_file), "restart")
            service._shutdown.assert_called_once()
            self.assertFalse(service._state["updating"])


if __name__ == "__main__":
    unittest.main()
