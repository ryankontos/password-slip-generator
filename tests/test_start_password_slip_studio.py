from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))
import start_password_slip_studio as launcher  # noqa: E402


class LauncherLifecycleTests(unittest.TestCase):
    def test_only_reuses_an_existing_service_from_this_checkout(self) -> None:
        checkout = Path("/tmp/password-slip-studio-test")
        with patch.object(launcher, "ROOT", checkout):
            self.assertEqual(launcher.ensure_runtime_checkout({"root": str(checkout)}), {"root": str(checkout)})
            with self.assertRaisesRegex(RuntimeError, "another Password Slip Studio checkout"):
                launcher.ensure_runtime_checkout({"root": "/tmp/another-studio"})

    def test_old_python_gets_a_clear_launcher_error(self) -> None:
        with patch.object(launcher.sys, "version_info", (3, 8, 19)):
            with self.assertRaisesRegex(RuntimeError, "Python 3.9 or newer"):
                launcher.ensure_environment()


if __name__ == "__main__":
    unittest.main()
