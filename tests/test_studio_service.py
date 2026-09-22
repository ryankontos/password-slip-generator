"""Checks for the local service controls without changing system settings."""

from __future__ import annotations

from pathlib import Path
import plistlib
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import studio_service  # noqa: E402


class ServiceControlTests(unittest.TestCase):
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
                    return "new" if args[-1] != "HEAD" or fake_text.updated else "old"
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
