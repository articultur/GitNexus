#!/usr/bin/env python3
"""Mock GitNexus eval-server for testing."""

import http.server
import json
import sys
import threading


class MockHandler(http.server.BaseHTTPRequestHandler):
    """Minimal mock that mimics the GitNexus eval-server HTTP API."""

    def do_GET(self):
        if self.path == "/health":
            self._json_response({"status": "ok", "repos": ["mock-repo"]})
        else:
            self._text_response(404, "Not found")

    def do_POST(self):
        if self.path == "/shutdown":
            self._json_response({"status": "shutting_down"})
            threading.Thread(target=self.server.shutdown).start()
        elif self.path.startswith("/tool/"):
            tool_name = self.path.split("/tool/")[1]
            body = self._read_body()
            result = f"Mock result for {tool_name}({json.dumps(body)})"
            self._text_response(200, result)
        else:
            self._text_response(404, "Not found")

    # -- helpers --

    def _json_response(self, data, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _text_response(self, code, text):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(text.encode("utf-8"))

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length:
            return json.loads(self.rfile.read(length).decode())
        return {}

    def log_message(self, format, *args):
        pass  # suppress request logs


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4849
    server = http.server.HTTPServer(("127.0.0.1", port), MockHandler)
    print(f"READY:{port}", flush=True)
    server.serve_forever()
