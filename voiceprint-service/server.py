"""Stateless, bounded CPU speaker embeddings. Run only on a private network."""

import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import sherpa_onnx

MODEL_SHA = "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11"
PROFILE = f"campplus-zh-v1:sherpa-2.0.1:s16le-16000-mono:{MODEL_SHA}"


class Extractor:
    def __init__(self, path):
        if hashlib.sha256(Path(path).read_bytes()).hexdigest() != MODEL_SHA:
            raise ValueError("model checksum mismatch")
        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=path, num_threads=2, provider="cpu"
        )
        self.model = sherpa_onnx.SpeakerEmbeddingExtractor(config)
        if self.model.dim != 192:
            raise ValueError("invalid model dimension")

    def extract(self, body):
        if len(body) % 2 or not 96000 <= len(body) <= 320000:
            raise ValueError("invalid_audio")
        samples = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768
        if np.sqrt(np.mean(samples * samples)) < 0.003 or np.mean(np.abs(samples) > 0.99) > 0.05:
            raise ValueError("insufficient_audio")
        stream = self.model.create_stream()
        stream.accept_waveform(16000, samples)
        stream.input_finished()
        if not self.model.is_ready(stream):
            raise ValueError("insufficient_audio")
        vector = np.asarray(self.model.compute(stream), dtype=np.float64)
        norm = np.linalg.norm(vector)
        if vector.shape != (192,) or not np.isfinite(vector).all() or norm < 1e-8:
            raise ValueError("invalid_embedding")
        return {"model": PROFILE, "embedding": (vector / norm).tolist()}


class Server(HTTPServer):
    # No per-request threads or unbounded work queue; inference remains serialized
    # even when a client times out while the native model is still computing.
    request_queue_size = 1

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Never persist audio, headers or caller identities.

    def reply(self, status, payload):
        body = json.dumps(payload, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200 if self.path == "/healthz" else 404, {"model": PROFILE})

    def do_POST(self):
        try:
            lengths = self.headers.get_all("Content-Length", [])
            length = int(lengths[0]) if len(lengths) == 1 else 0
            if (
                self.path != "/embedding"
                or self.headers.get("Transfer-Encoding")
                or self.headers.get("Content-Type") != "application/octet-stream"
                or not 96000 <= length <= 320000
                or length % 2
            ):
                self.reply(400, {"error": "invalid_audio"})
                return
            body = self.rfile.read(length)
            if len(body) != length:
                self.reply(400, {"error": "invalid_audio"})
                return
            self.reply(200, self.server.extractor.extract(body))
        except ValueError:
            self.reply(422, {"error": "insufficient_audio"})
        except (TimeoutError, ConnectionError, BrokenPipeError):
            pass
        except Exception:
            self.reply(500, {"error": "inference_failed"})


if __name__ == "__main__":
    server = Server((os.getenv("LISTEN_HOST", "127.0.0.1"), 8091), Handler)
    server.extractor = Extractor(os.environ["MODEL_PATH"])
    server.serve_forever()
