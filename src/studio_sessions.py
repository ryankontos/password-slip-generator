"""Durable, revisioned Studio sessions shared by local browsers."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path
import tempfile
import threading
import uuid
from typing import Any


class SessionNotFoundError(KeyError):
    pass


class SessionConflictError(RuntimeError):
    def __init__(self, current: dict[str, Any], recovery: dict[str, Any]) -> None:
        super().__init__("This session changed in another browser.")
        self.current = current
        self.recovery = recovery


class LibraryConflictError(RuntimeError):
    def __init__(self, library: dict[str, Any]) -> None:
        super().__init__("This item changed in another browser. Review it before deleting it.")
        self.library = library


class StudioSessionStore:
    """Small JSON store with atomic writes and conflict recovery."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.backup_path = path.with_suffix(path.suffix + ".bak")
        self._lock = threading.RLock()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="microseconds")

    @staticmethod
    def _name(workspace: dict[str, Any], fallback: str = "Untitled password slips") -> str:
        document = workspace.get("document") if isinstance(workspace.get("document"), dict) else workspace
        return str(document.get("name") or fallback)[:120]

    def _empty(self) -> dict[str, Any]:
        return {"version": 1, "sessions": []}

    def _read(self) -> dict[str, Any]:
        for candidate in (self.path, self.backup_path):
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(payload, dict) and isinstance(payload.get("sessions"), list):
                    return payload
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                continue
        return self._empty()

    def _write(self, payload: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            try:
                previous = self.path.read_bytes()
                parsed = json.loads(previous)
                if isinstance(parsed, dict) and isinstance(parsed.get("sessions"), list):
                    self.backup_path.write_bytes(previous)
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                pass
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=".sessions-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(self.path)

    @staticmethod
    def _summary(record: dict[str, Any]) -> dict[str, Any]:
        workspace = record.get("workspace") if isinstance(record.get("workspace"), dict) else {}
        document = workspace.get("document") if isinstance(workspace.get("document"), dict) else workspace
        columns = document.get("columns") if isinstance(document.get("columns"), list) else []
        rows = document.get("rows") if isinstance(document.get("rows"), list) else []
        safe_columns = [
            column for column in columns
            if isinstance(column, dict)
            and column.get("type") != "password"
            and column.get("visibility") != "never"
        ]
        preview_parts: list[str] = []
        for row in rows:
            if not isinstance(row, dict) or row.get("hidden"):
                continue
            values = row.get("values") if isinstance(row.get("values"), dict) else {}
            for column in safe_columns:
                value = str(values.get(str(column.get("id") or ""), "")).strip()
                if value and value not in preview_parts:
                    preview_parts.append(value[:50])
                if len(preview_parts) == 2:
                    break
            if preview_parts:
                break
        return {
            "id": record["id"],
            "name": record.get("name") or "Untitled password slips",
            "updated_at": record.get("updated_at"),
            "created_at": record.get("created_at"),
            "revision": int(record.get("revision", 0)),
            "rows": len(document.get("rows") or []),
            "fields": len(document.get("columns") or []),
            "recovered": bool(record.get("recovered")),
            "preview": " · ".join(preview_parts)[:110],
        }

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            records = sorted(self._read()["sessions"], key=lambda item: str(item.get("updated_at") or ""), reverse=True)
            return [self._summary(record) for record in records]

    def get(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            record = next((item for item in self._read()["sessions"] if item.get("id") == session_id), None)
            if not record:
                raise SessionNotFoundError(session_id)
            return deepcopy(record)

    @staticmethod
    def _validate_library_item(kind: str, record: Any) -> None:
        if kind not in {"templates", "palettes"} or not isinstance(record, dict):
            raise ValueError("Choose a template or palette to save.")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", str(record.get("id") or "")) or not str(record.get("name") or "").strip():
            raise ValueError("The saved item needs a name and identifier.")
        if len(str(record["name"])) > 160:
            raise ValueError("The saved item name is too long.")
        if kind == "palettes":
            colors = record.get("colors")
            if not isinstance(colors, dict) or not all(re.fullmatch(r"#[0-9a-fA-F]{6}", str(colors.get(key, ""))) for key in ("accent", "ink", "paperColor", "borderColor")):
                raise ValueError("The palette contains an invalid colour.")
        else:
            document = record.get("document")
            if not isinstance(document, dict) or not isinstance(document.get("columns"), list) or not isinstance(document.get("rows"), list):
                raise ValueError("The template does not contain valid fields and rows.")

    def _ensure_library(self, payload: dict[str, Any]) -> dict[str, Any]:
        library = payload.get("library")
        if isinstance(library, dict) and library.get("id") and isinstance(library.get("templates"), list) and isinstance(library.get("palettes"), list):
            return library
        library = {"id": uuid.uuid4().hex, "revision": 1, "templates": [], "palettes": []}
        # Upgrade older installations without losing palettes in saved sessions.
        for session in sorted(payload["sessions"], key=lambda item: str(item.get("updated_at") or ""), reverse=True):
            palettes = session.get("workspace", {}).get("palettes", [])
            if not isinstance(palettes, list):
                continue
            for palette in palettes:
                try:
                    self._validate_library_item("palettes", palette)
                except ValueError:
                    continue
                if not any(item["id"] == palette["id"] for item in library["palettes"]):
                    library["palettes"].append(deepcopy(palette))
        payload["library"] = library
        self._write(payload)
        return library

    def library(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._ensure_library(self._read()))

    def update_library(self, operation: dict[str, Any]) -> dict[str, Any]:
        """Change one item, not an entire browser's potentially stale list."""
        kind, action = operation.get("kind"), operation.get("action")
        if kind not in {"templates", "palettes"} or action not in {"save", "import", "delete"}:
            raise ValueError("The library change was invalid.")
        with self._lock:
            payload = self._read()
            library = self._ensure_library(payload)
            items = library[kind]
            operation_id = str(operation.get("operationId") or "")
            receipts = library.setdefault("receipts", {})
            if operation_id and operation_id in receipts:
                receipt = receipts[operation_id]
                saved = next((item for item in items if item.get("id") == receipt.get("id")), None)
                return {"library": deepcopy(library), "record": deepcopy(saved), "recovered": receipt.get("recovered", False)}
            record = deepcopy(operation.get("record"))
            item_id = operation.get("id") if action == "delete" else (record.get("id") if isinstance(record, dict) else None)
            current = next((item for item in items if item.get("id") == item_id), None)
            recovered = False
            if action == "delete":
                if not current:
                    return {"library": deepcopy(library)}
                if current.get("savedAt") != operation.get("expectedSavedAt"):
                    raise LibraryConflictError(deepcopy(library))
                items.remove(current)
            else:
                self._validate_library_item(kind, record)
                if kind == "templates" and record.get("includeData") is False:
                    record["document"]["rows"] = []
                if action == "import" and current:
                    return {"library": deepcopy(library), "record": deepcopy(current)}
                if current == record:
                    return {"library": deepcopy(library), "record": deepcopy(current)}
                same_name = next((item for item in items if str(item.get("name", "")).strip().casefold() == str(record["name"]).strip().casefold()), None)
                if (current and current.get("savedAt") != operation.get("expectedSavedAt")) or (same_name and same_name is not current):
                    # Preserve both versions rather than overwrite unseen changes.
                    record["id"] = uuid.uuid4().hex
                    record["name"] = f"{str(record['name'])[:130]} (copy)"
                    record["savedAt"] = self._now()
                    recovered = True
                elif current:
                    items.remove(current)
                items.insert(0, record)
            library["revision"] = int(library.get("revision", 0)) + 1
            if operation_id:
                receipts[operation_id] = {"id": record.get("id") if isinstance(record, dict) else None, "recovered": recovered}
                library["receipts"] = dict(list(receipts.items())[-500:])
            self._write(payload)
            return {"library": deepcopy(library), "record": record, "recovered": recovered}

    def create(self, workspace: dict[str, Any], *, recovered: bool = False) -> dict[str, Any]:
        if not isinstance(workspace, dict):
            raise ValueError("The session workspace was missing.")
        with self._lock:
            payload = self._read()
            now = self._now()
            name = self._name(workspace)
            if recovered and not name.lower().endswith("(recovered)"):
                name = f"{name} (recovered)"[:120]
            record = {
                "id": uuid.uuid4().hex,
                "name": name,
                "created_at": now,
                "updated_at": now,
                "revision": 1,
                "recovered": recovered,
                "workspace": deepcopy(workspace),
            }
            payload["sessions"].insert(0, record)
            payload["sessions"] = sorted(payload["sessions"], key=lambda item: str(item.get("updated_at") or ""), reverse=True)
            self._write(payload)
            return deepcopy(record)

    def save(self, session_id: str, revision: int, workspace: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(workspace, dict):
            raise ValueError("The session workspace was missing.")
        with self._lock:
            payload = self._read()
            record = next((item for item in payload["sessions"] if item.get("id") == session_id), None)
            if not record:
                raise SessionNotFoundError(session_id)
            # A close-tab beacon may repeat an autosave after it succeeds.
            # The export timestamp is metadata, not an edit to the workspace.
            current_content = {key: value for key, value in record.get("workspace", {}).items() if key != "savedAt"}
            incoming_content = {key: value for key, value in workspace.items() if key != "savedAt"}
            if current_content == incoming_content:
                return deepcopy(record)
            if int(record.get("revision", 0)) != int(revision):
                recovery = self.create(workspace, recovered=True)
                raise SessionConflictError(deepcopy(record), recovery)
            record["workspace"] = deepcopy(workspace)
            record["name"] = self._name(workspace)
            record["updated_at"] = self._now()
            record["revision"] = int(record.get("revision", 0)) + 1
            record["recovered"] = False
            # Keep the latest save first even for older, second-resolution dates.
            payload["sessions"] = [record, *[item for item in payload["sessions"] if item["id"] != record["id"]]]
            payload["sessions"] = sorted(payload["sessions"], key=lambda item: str(item.get("updated_at") or ""), reverse=True)
            self._write(payload)
            return deepcopy(record)
