"""Real-model boundary tests. MODEL_PATH must point to the pinned ONNX artifact."""
import http.client
import json
import os
import threading
import unittest

from server import Extractor, Handler, PROFILE, Server


class ModelHTTPTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(("127.0.0.1", 0), Handler)
        cls.server.extractor = Extractor(os.environ["MODEL_PATH"])
        cls.thread = threading.Thread(target=cls.server.serve_forever)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    def request(self, path, body=None, headers=None):
        client = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            client.request("GET" if body is None else "POST", path, body, headers or {})
            response = client.getresponse()
            return response.status, json.loads(response.read())
        finally:
            client.close()

    def test_model_health_and_silence(self):
        self.assertEqual(self.request("/healthz"), (200, {"model": PROFILE}))
        status, _ = self.request("/embedding", bytes(96000), {"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 422)

    def test_invalid_lengths_and_encoding(self):
        for size in [100, 96001, 320002]:
            status, _ = self.request("/embedding", bytes(size), {"Content-Type": "application/octet-stream"})
            self.assertEqual(status, 400)
        status, _ = self.request("/embedding", bytes(96000), {"Content-Type": "audio/wav"})
        self.assertEqual(status, 400)

    def test_optional_real_speech(self):
        path = os.getenv("VOICEPRINT_TEST_PCM")
        if not path:
            self.skipTest("set VOICEPRINT_TEST_PCM to a 3–10 second real speech clip")
        with open(path, "rb") as source:
            body = source.read()
        status, result = self.request("/embedding", body, {"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 200)
        self.assertEqual(result["model"], PROFILE)
        self.assertEqual(len(result["embedding"]), 192)
        self.assertAlmostEqual(sum(x*x for x in result["embedding"]), 1.0)
