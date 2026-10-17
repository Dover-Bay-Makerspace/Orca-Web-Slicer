#!/usr/bin/env python3
"""Local test server for Orca Web Slicer.

Serves this folder with the two headers the multithreaded engine needs
(Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy) and the right
MIME type for .wasm.

    python3 tools/serve.py            # http://localhost:8080
    python3 tools/serve.py 9000
    python3 tools/serve.py 8080 --host 0.0.0.0   # reachable from other computers*

* Browsers only allow the engine on "secure" origins: https:// or
  http://localhost. Other computers on the network need HTTPS (see README).
"""
import argparse
import functools
import http.server
import os
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("QUIET"):
            return
        super().log_message(fmt, *args)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--root", default=ROOT)
    a = ap.parse_args()
    handler = functools.partial(Handler, directory=a.root)
    with Server((a.host, a.port), handler) as httpd:
        print(f"Serving {a.root} at http://{'localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host}:{a.port}/  (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
