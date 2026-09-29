"""Durable, revisioned Studio sessions shared by local browsers."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import os
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


class StudioSessionStore:
    """Small JSON store with atomic writes and conflict recovery."""

    def __init__(self, path: Path, limit: int = 30) -> None:
        self.path = path
        self.backup_path = path.with_suffix(path.suffix + ".bak")
        self.limit = max(5, limit)
        self._lock = threading.RLock()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

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
                self.backup_path.write_bytes(self.path.read_bytes())
            except OSError:
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
        return {
            "id": record["id"],
            "name": record.get("name") or "Untitled password slips",
            "updated_at": record.get("updated_at"),
            "created_at": record.get("created_at"),
            "revision": int(record.get("revision", 0)),
            "rows": len(document.get("rows") or []),
            "fields": len(document.get("columns") or []),
            "recovered": bool(record.get("recovered")),
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
            payload["sessions"].append(record)
            payload["sessions"] = sorted(payload["sessions"], key=lambda item: str(item.get("updated_at") or ""), reverse=True)[: self.limit]
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
            if int(record.get("revision", 0)) != int(revision):
                if record.get("workspace") == workspace:
                    return deepcopy(record)
                recovery = self.create(workspace, recovered=True)
                raise SessionConflictError(deepcopy(record), recovery)
            record["workspace"] = deepcopy(workspace)
            record["name"] = self._name(workspace)
            record["updated_at"] = self._now()
            record["revision"] = int(record.get("revision", 0)) + 1
            record["recovered"] = False
            payload["sessions"] = sorted(payload["sessions"], key=lambda item: str(item.get("updated_at") or ""), reverse=True)[: self.limit]
            self._write(payload)
            return deepcopy(record)
