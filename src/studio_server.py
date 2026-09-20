"""Local-only HTTP server for Password Slip Studio."""

from __future__ import annotations

import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import socket
import threading
from typing import Any
from urllib.parse import urlparse

from studio_core import StudioError, parse_workbook, render_pdf


ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "web"
MAX_BODY = 80 * 1024 * 1024
SAFE_PATH = re.compile(r"^/[A-Za-z0-9._/-]*$")


class StudioHandler(BaseHTTPRequestHandler):
    server_version = "PasswordSlipStudio/1.0"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:
        if getattr(self.server, "verbose", False):
            super().log_message(format, *args)

    def _send(self, body: bytes, content_type: str, status: int = 200, disposition: str | None = None) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            if disposition:
                self.send_header("Content-Disposition", disposition)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass

    def _json(self, payload: Any, status: int = 200) -> None:
        self._send(json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def _request_json(self) -> dict[str, Any]:
        if self.headers.get_content_type() != "application/json":
            raise StudioError("Requests must use JSON.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise StudioError("The request size was invalid.") from exc
        if length <= 0 or length > MAX_BODY:
            raise StudioError("The request was empty or too large.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise StudioError("The request contained invalid JSON.") from exc
        if not isinstance(payload, dict):
            raise StudioError("The request must be an object.")
        return payload

    def _origin_allowed(self) -> bool:
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if not (host.startswith("127.0.0.1:") or host.startswith("localhost:")):
            return False
        return origin is None or origin in {f"http://{host}", f"https://{host}"}

    def do_GET(self) -> None:  # noqa: N802
        if not self._origin_allowed():
            self._json({"error": "This server accepts localhost requests only."}, 403)
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/runtime":
            self._json({"name": "Password Slip Studio", "pid": os.getpid()})
            return
        path = "/index.html" if parsed.path == "/" else parsed.path
        if not SAFE_PATH.match(path) or ".." in path:
            self._json({"error": "Not found."}, 404)
            return
        target = (WEB_ROOT / path.lstrip("/")).resolve()
        if WEB_ROOT.resolve() not in target.parents or not target.is_file():
            self._json({"error": "Not found."}, 404)
            return
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if mime.startswith("text/") or mime in {"application/javascript", "application/json"}:
            mime += "; charset=utf-8"
        self._send(target.read_bytes(), mime)

    def do_POST(self) -> None:  # noqa: N802
        if not self._origin_allowed():
            self._json({"error": "This server accepts localhost requests only."}, 403)
            return
        try:
            payload = self._request_json()
            path = urlparse(self.path).path
            if path == "/api/import":
                filename = str(payload.get("filename", "workbook.xlsx"))[:240]
                try:
                    content = base64.b64decode(str(payload.get("content", "")), validate=True)
                except ValueError as exc:
                    raise StudioError("The uploaded file data was invalid.") from exc
                self._json(parse_workbook(filename, content))
                return
            if path == "/api/pdf":
                document = payload.get("document")
                if not isinstance(document, dict):
                    raise StudioError("The studio document was missing.")
                pdf = render_pdf(document)
                name = re.sub(r"[^A-Za-z0-9._ -]+", "", str(document.get("name") or "password-slips")).strip() or "password-slips"
                self._send(pdf, "application/pdf", disposition=f'attachment; filename="{name}.pdf"')
                return
            if path == "/api/shutdown":
                self._json({"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            self._json({"error": "Not found."}, 404)
        except StudioError as exc:
            self._json({"error": str(exc)}, 400)
        except Exception:
            self._json({"error": "An unexpected local server error occurred."}, 500)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Password Slip Studio locally.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        parser.error("Password Slip Studio may only bind to localhost.")
    server = ThreadingHTTPServer((args.host, args.port), StudioHandler)
    server.verbose = args.verbose  # type: ignore[attr-defined]
    print(f"Password Slip Studio  ·  http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
