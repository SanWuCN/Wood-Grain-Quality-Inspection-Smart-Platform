#!/usr/bin/env python3
"""Read-only X11 desktop stream. One encoder, bounded latest-frame buffer."""
import hmac
import json
import os
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ['MUMAI_SCREEN_TOKEN']
WIDTH = int(os.environ.get('MUMAI_SCREEN_WIDTH', '1024'))
HEIGHT = int(os.environ.get('MUMAI_SCREEN_HEIGHT', '600'))
FPS = int(os.environ.get('MUMAI_SCREEN_FPS', '10'))
condition = threading.Condition()
latest = b''
sequence = 0
frame_at = 0.0
process = None
stopping = threading.Event()


def capture():
    global latest, sequence, frame_at, process
    while not stopping.is_set():
        process = subprocess.Popen([
            'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-f', 'x11grab', '-video_size', f'{WIDTH}x{HEIGHT}',
            '-framerate', str(FPS), '-i', os.environ.get('DISPLAY', ':0') + '.0',
            '-an', '-c:v', 'mjpeg', '-q:v', '4', '-threads', '2',
            '-f', 'image2pipe', '-flush_packets', '1', 'pipe:1',
        ], stdout=subprocess.PIPE)
        buffer = bytearray()
        while not stopping.is_set():
            chunk = process.stdout.read1(65536)
            if not chunk:
                break
            buffer.extend(chunk)
            while True:
                start = buffer.find(b'\xff\xd8')
                end = buffer.find(b'\xff\xd9', max(0, start + 2))
                if start < 0 or end < 0:
                    break
                frame = bytes(buffer[start:end+2])
                del buffer[:end+2]
                with condition:
                    latest, frame_at = frame, time.time()
                    sequence += 1
                    condition.notify_all()
            if len(buffer) > 4 * 1024 * 1024:
                buffer.clear()
        process.stdout.close()
        process.wait()
        stopping.wait(2)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def log_message(self, *args):
        pass

    def do_GET(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            self.send_error(401)
            return
        if self.path == '/status':
            data = json.dumps({'online': time.time()-frame_at < 3, 'width': WIDTH,
                               'height': HEIGHT, 'fps': FPS, 'sequence': sequence}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path != '/stream.mjpeg':
            self.send_error(404)
            return
        self.connection.settimeout(10)
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        last = -1
        try:
            while not stopping.is_set():
                with condition:
                    condition.wait_for(lambda: sequence != last or stopping.is_set(), timeout=5)
                    if stopping.is_set() or time.time()-frame_at > 3:
                        break
                    frame, last = latest, sequence
                self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' +
                                 str(len(frame)).encode() + b'\r\n\r\n' + frame + b'\r\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass


def stop(*_):
    stopping.set()
    if process and process.poll() is None:
        process.terminate()
    with condition:
        condition.notify_all()
    raise SystemExit(0)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=capture, daemon=True).start()
    ThreadingHTTPServer((os.environ.get('MUMAI_SCREEN_HOST', '0.0.0.0'),
                         int(os.environ.get('MUMAI_SCREEN_PORT', '8766'))), Handler).serve_forever()
