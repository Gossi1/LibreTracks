"""Local HTTP service that runs the allin1 structure analysis for LibreTracks.

Endpoints
---------
GET  /health       -> is the model usable, and which one
POST /analyze      -> {"path": "C:/.../ref.mp3", "useCache": true}
POST /cache/clear  -> drop cached analyses

Everything binds to 127.0.0.1. This process exists only so the Tauri webview
can ask a Python model for section boundaries without LibreTracks shipping a
Python runtime or a neural network inside the app bundle.

Security posture: it is a loopback-only server that accepts an absolute audio
path, decodes it, and returns timings — it never returns file contents. On top
of that it only accepts known audio extensions and skips symlinked paths, so it
cannot be repurposed as a general file reader.

Run:  python server.py            (or start-service.bat on Windows)
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import analyzer

DEFAULT_PORT = 8799
MAX_BODY_BYTES = 64 * 1024


def _port() -> int:
    raw = os.environ.get("LT_MIR_PORT", "")
    try:
        return int(raw) if raw else DEFAULT_PORT
    except ValueError:
        return DEFAULT_PORT


class Handler(BaseHTTPRequestHandler):
    server_version = "LibreTracksMIR/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # The dev webview runs on a Vite origin; allow it explicitly.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            # Client went away mid-write (user closed the dialog) — not an
            # error worth logging as a traceback.
            pass

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("Request body too large")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("JSON body must be an object")
        return parsed

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # Keep the console readable: one line per request, no timestamps noise.
        sys.stderr.write("[mir] %s\n" % (fmt % args))

    # -- routes -----------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler hook
        self._send_json({"success": True})

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler hook
        path = urlparse(self.path).path
        if path == "/health":
            self._handle_health()
            return
        self._send_json({"success": False, "error": "Not found"}, status=404)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler hook
        path = urlparse(self.path).path
        try:
            body = self._read_json()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json({"success": False, "error": str(exc)}, status=400)
            return

        if path == "/analyze":
            self._handle_analyze(body)
        elif path == "/cache/clear":
            removed = analyzer.clear_cache()
            self._send_json({"success": True, "removed": removed})
        else:
            self._send_json({"success": False, "error": "Not found"}, status=404)

    def _handle_health(self) -> None:
        available, detail = analyzer.is_available()
        self._send_json(
            {
                "success": True,
                "available": available,
                "detail": detail,
                "model": analyzer.model_name(),
                "cache": analyzer.cache_stats(),
                "service": "libretracks-mir",
                "version": "1.0.0",
            }
        )

    def _handle_analyze(self, body: dict) -> None:
        audio_path = body.get("path")
        if not isinstance(audio_path, str) or not audio_path.strip():
            self._send_json(
                {"success": False, "error": "Missing 'path' in request body"},
                status=400,
            )
            return

        use_cache = body.get("useCache", True)
        if not isinstance(use_cache, bool):
            use_cache = True

        try:
            payload = analyzer.analyze(audio_path.strip(), use_cache=use_cache)
        except analyzer.AnalysisError as exc:
            self._send_json({"success": False, "error": str(exc)}, status=422)
            return
        except FileNotFoundError as exc:
            self._send_json(
                {"success": False, "error": f"Audio file not found: {exc.filename}"},
                status=404,
            )
            return
        except Exception:  # noqa: BLE001 - return a real diagnostic, not a 500
            traceback.print_exc()
            self._send_json(
                {
                    "success": False,
                    "error": "Unexpected server error — see the analysis-service console.",
                },
                status=500,
            )
            return

        self._send_json({"success": True, **payload})


def main() -> int:
    host = "127.0.0.1"
    port = _port()
    analyzer.ensure_ffmpeg_on_path()

    available, detail = analyzer.is_available()
    print(f"[mir] LibreTracks MIR analysis service on http://{host}:{port}")
    print(f"[mir] model={analyzer.model_name()} available={available} ({detail})")
    if not available:
        print("[mir] /health will report available=false until the model is installed.")

    try:
        server = ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        print(f"[mir] could not bind {host}:{port}: {exc}", file=sys.stderr)
        return 1

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[mir] shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
