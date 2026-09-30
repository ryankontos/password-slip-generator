"""Run browser tests without reading or writing real saved sessions."""
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from studio_server import StudioServer
from studio_sessions import StudioSessionStore

class FixtureService:
    """Disable updater/login actions while exercising the real HTTP handler."""
    supervised = False

    def __init__(self, server):
        pass

    def status(self):
        return {"background": False, "update_available": False, "start_at_login": False}


with TemporaryDirectory(prefix="studio-browser-tests-") as directory, patch("studio_server.StudioService", FixtureService):
    server = StudioServer(("127.0.0.1", 8775))
    server.sessions = StudioSessionStore(Path(directory) / "sessions.json")
    try:
        server.serve_forever()
    finally:
        server.server_close()
