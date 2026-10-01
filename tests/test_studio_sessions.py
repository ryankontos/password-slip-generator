import tempfile
import unittest
from pathlib import Path

from studio_sessions import LibraryConflictError, SessionConflictError, SessionNotFoundError, StudioSessionStore


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

    def test_recent_sessions_are_not_silently_evicted(self):
        first = self.store.create(workspace("Keep this"))
        for index in range(35):
            self.store.create(workspace(str(index)))
        self.assertEqual(len(self.store.list()), 36)
        self.assertEqual(self.store.get(first["id"])["name"], "Keep this")

    def test_summary_preview_uses_visible_non_password_values(self):
        payload = workspace("People")
        payload["document"]["columns"] = [
            {"id": "name", "label": "Name", "type": "text", "visibility": "always"},
            {"id": "secret", "label": "Password", "type": "password", "visibility": "always"},
            {"id": "hidden", "label": "Notes", "type": "text", "visibility": "never"},
        ]
        payload["document"]["rows"] = [
            {"id": "hidden-row", "hidden": True, "values": {"name": "Do not show", "secret": "secret", "hidden": "private"}},
            {"id": "row-1", "hidden": False, "values": {"name": "Cayla Atra", "secret": "Str33t", "hidden": "internal"}},
        ]
        self.store.create(payload)
        self.assertEqual(self.store.list()[0]["preview"], "Cayla Atra")

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

    def test_latest_session_wins_when_timestamps_match(self):
        self.store._now = lambda: "2026-10-01T01:00:00+00:00"
        first = self.store.create(workspace("First"))
        second = self.store.create(workspace("Second"))
        self.assertEqual(self.store.list()[0]["id"], second["id"])
        self.store.save(first["id"], first["revision"], workspace("First updated"))
        self.assertEqual(self.store.list()[0]["id"], first["id"])

    def test_repeated_exit_save_does_not_create_a_false_conflict(self):
        initial = {**workspace(), "savedAt": "2026-09-29T04:00:00Z"}
        created = self.store.create(initial)
        edited = {**workspace("Updated"), "savedAt": "2026-09-29T04:01:00Z"}
        saved = self.store.save(created["id"], 1, edited)
        repeated = {**edited, "savedAt": "2026-09-29T04:01:01Z"}
        result = self.store.save(created["id"], 1, repeated)
        self.assertEqual(result["revision"], saved["revision"])
        self.assertEqual(len(self.store.list()), 1)

    def test_corrupt_primary_falls_back_to_backup(self):
        first = self.store.create(workspace("First"))
        self.store.save(first["id"], first["revision"], workspace("Second"))
        self.store.path.write_text("not json", encoding="utf-8")
        self.assertEqual(self.store.get(first["id"])["name"], "First")

    def test_writing_after_corruption_does_not_destroy_good_backup(self):
        first = self.store.create(workspace("First"))
        self.store.save(first["id"], 1, workspace("Second"))
        self.store.path.write_text("not json", encoding="utf-8")
        self.store.library()
        self.store.path.write_text("not json again", encoding="utf-8")
        self.assertEqual(self.store.get(first["id"])["name"], "First")

    def template(self, name="Reusable", item_id="template-one", stamp="one"):
        return {"id": item_id, "name": name, "savedAt": stamp, "includeData": False, "document": workspace(name)["document"]}

    def test_shared_library_survives_restart_without_truncating_templates(self):
        for index in range(16):
            self.store.update_library({"kind": "templates", "action": "save", "record": self.template(str(index), f"template-{index}")})
        restarted = StudioSessionStore(self.store.path)
        self.assertEqual(len(restarted.library()["templates"]), 16)
        self.assertEqual(restarted.library()["templates"][0]["document"]["rows"], [])

    def test_library_migrates_session_palettes_newest_first(self):
        colors = {key: "#123456" for key in ("accent", "ink", "paperColor", "borderColor")}
        self.store.create({**workspace(), "palettes": [{"id": "p", "name": "Older", "colors": colors}]})
        self.store.create({**workspace(), "palettes": [{"id": "p", "name": "Newest", "colors": colors}]})
        library = self.store.library()
        self.assertEqual([item["name"] for item in library["palettes"]], ["Newest"])
        self.assertEqual(self.store.library()["id"], library["id"])

    def test_unrelated_library_changes_merge_and_import_does_not_overwrite(self):
        one = self.template()
        two = self.template("Second", "template-two")
        self.store.update_library({"kind": "templates", "action": "save", "record": one})
        self.store.update_library({"kind": "templates", "action": "save", "record": two})
        self.store.update_library({"kind": "templates", "action": "import", "record": {**one, "name": "Old cache"}})
        self.assertEqual({item["name"] for item in self.store.library()["templates"]}, {"Reusable", "Second"})

    def test_stale_template_edit_keeps_both_versions_and_retry_is_idempotent(self):
        one = self.template()
        self.store.update_library({"kind": "templates", "action": "save", "record": one})
        self.store.update_library({"kind": "templates", "action": "save", "record": {**one, "savedAt": "two", "name": "Changed"}, "expectedSavedAt": "one"})
        operation = {"operationId": "retry-safe", "kind": "templates", "action": "save", "record": {**one, "name": "My changes", "savedAt": "three"}, "expectedSavedAt": "one"}
        saved = self.store.update_library(operation)
        repeated = self.store.update_library(operation)
        self.assertTrue(saved["recovered"])
        self.assertEqual(repeated["record"]["id"], saved["record"]["id"])
        self.assertEqual({item["name"] for item in self.store.library()["templates"]}, {"Changed", "My changes (copy)"})

    def test_stale_delete_preserves_newer_template(self):
        one = self.template()
        self.store.update_library({"kind": "templates", "action": "save", "record": one})
        self.store.update_library({"kind": "templates", "action": "save", "record": {**one, "savedAt": "two"}, "expectedSavedAt": "one"})
        with self.assertRaises(LibraryConflictError):
            self.store.update_library({"kind": "templates", "action": "delete", "id": one["id"], "expectedSavedAt": "one"})
        self.assertEqual(len(self.store.library()["templates"]), 1)
        self.store.update_library({"kind": "templates", "action": "delete", "id": one["id"], "expectedSavedAt": "two"})
        self.assertEqual(self.store.library()["templates"], [])

    def test_invalid_library_item_is_rejected(self):
        for record in [{}, {"id": "invalid/identifier", "name": "Broken"}, {"id": "p", "name": "Broken", "colors": {}}]:
            with self.assertRaises(ValueError):
                self.store.update_library({"kind": "palettes", "action": "save", "record": record})


if __name__ == "__main__":
    unittest.main()
