from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import socket
import threading
import webbrowser

ROOT = Path(__file__).resolve().parent / "public"
os.chdir(ROOT)


def find_port(start=8000, end=8010):
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("Could not find a free port from 8000 to 8010.")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


port = find_port()
url = f"http://127.0.0.1:{port}"
server = ThreadingHTTPServer(("127.0.0.1", port), QuietHandler)

print(f"My Workboard is running at {url}")
print("Press Ctrl+C in this window when you want to stop it.")
threading.Timer(0.6, lambda: webbrowser.open(url)).start()

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nWorkboard stopped.")
finally:
    server.server_close()
