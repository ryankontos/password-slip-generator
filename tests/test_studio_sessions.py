import tempfile
import unittest
from pathlib import Path

from studio_sessions import SessionConflictError, SessionNotFoundError, StudioSessionStore


def workspace(name="Slips", rows=1):
    return {"document": {"name": name, "columns": [{"id": "name"}], "rows": [{} for _ in range(rows)]}}


class StudioSessionStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = StudioSessionStore(Path(self.temporary.name) / "sessions.json")

    def tearDown(self):
        self.temporary.cleanup()

    def test_create_list_get_and_save(self):
        created = self.store.create(workspace())
        self.assertEqual(self.store.list()[0]["rows"], 1)
        saved = self.store.save(created["id"], created["revision"], workspace("Updated", 2))
        self.assertEqual(saved["revision"], 2)
        self.assertEqual(self.store.get(created["id"])["name"], "Updated")

    def test_conflict_creates_recoverable_session(self):
        created = self.store.create(workspace())
        current = self.store.save(created["id"], 1, workspace("Current"))
        with self.assertRaises(SessionConflictError) as caught:
            self.store.save(created["id"], 1, workspace("My edits", 3))
        self.assertEqual(caught.exception.current["revision"], current["revision"])
        self.assertTrue(caught.exception.recovery["recovered"])
        self.assertEqual(caught.exception.recovery["workspace"]["document"]["name"], "My edits")
        self.assertEqual(len(self.store.list()), 2)

    def test_missing_session_is_explicit(self):
        with self.assertRaises(SessionNotFoundError):
            self.store.get("missing")

    def test_corrupt_primary_falls_back_to_backup(self):
        first = self.store.create(workspace("First"))
        self.store.save(first["id"], first["revision"], workspace("Second"))
        self.store.path.write_text("not json", encoding="utf-8")
        self.assertEqual(self.store.get(first["id"])["name"], "First")


if __name__ == "__main__":
    unittest.main()
