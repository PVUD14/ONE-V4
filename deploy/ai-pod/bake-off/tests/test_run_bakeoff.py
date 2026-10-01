"""Tests for run_bakeoff.py (ENG-21): the harness against a local fake of the vLLM endpoint.

Why these exist: the harness runs on a pod nobody watches closely, with the inference key on disk.
These pin the parts that must not drift: the request body is the adapter's, the key never reaches
output, plain http leaves only loopback, retries follow the adapter's policy, and the results file
has the shape the repository's importer reads. No network beyond 127.0.0.1; standard library only.

Run: python3 -m unittest discover -s deploy/ai-pod/bake-off/tests
"""
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import run_bakeoff  # noqa: E402

SECRET = "test-key-" + "x" * 24


class FakeEndpoint(object):
    """Answers like vLLM. `script(path, body, index)` returns (status, json) or ("sleep", seconds)."""

    def __init__(self, script, models=("served-model",)):
        self.requests = []
        endpoint = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self, body):
                endpoint.requests.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"), "body": body})
                if self.headers.get("Authorization") != "Bearer " + SECRET:
                    return self._send(401, {"error": "unauthorised " + SECRET})
                if self.command == "GET" and self.path == "/v1/models":
                    return self._send(200, {"object": "list", "data": [{"id": name} for name in models]})
                outcome = script(self.path, body, len(endpoint.requests) - 1)
                if outcome[0] == "sleep":
                    time.sleep(outcome[1])
                    return self._send(200, completion("late"))
                return self._send(outcome[0], outcome[1])

            def _send(self, status, payload):
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except OSError:  # the client gave up (the timeout test)
                    pass

            def do_GET(self):
                self._answer(None)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                self._answer(json.loads(self.rfile.read(length).decode("utf-8")))

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = "http://127.0.0.1:%d/v1" % self.server.server_address[1]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def completion(text, prompt_tokens=50, completion_tokens=10):
    return {"id": "x", "object": "chat.completion", "model": "served-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}}


def tiny_set():
    def case(case_id, task):
        return {"id": case_id, "task": task, "block": "ENGLISH", "category": "X", "language": "en", "source": "s",
                "request": {"messages": [{"role": "system", "content": "sys " + case_id}, {"role": "user", "content": "user " + case_id}],
                            "max_tokens": 64, "temperature": 0}, "expect": {}}
    return {"format": "one-bakeoff-set", "formatVersion": 1, "setKey": "tiny-set", "setVersion": 1,
            "cases": [case("c1", "tutor-hint"), case("c2", "tutor-hint"), case("c3", "lesson-draft"), case("c4", "answer-check")]}


class HarnessTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.set_path = os.path.join(self.dir, "set.json")
        with open(self.set_path, "w", encoding="utf-8") as handle:
            json.dump(tiny_set(), handle)
        self.key_path = os.path.join(self.dir, "api-key")
        with open(self.key_path, "w", encoding="utf-8") as handle:
            handle.write(SECRET + "\n")
        self.out = os.path.join(self.dir, "out")
        self.lines = []
        self.endpoint = None

    def tearDown(self):
        if self.endpoint:
            self.endpoint.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_harness(self, script, extra=(), models=("served-model",), base_url=None):
        self.endpoint = FakeEndpoint(script, models)
        argv = ["--model", "served-model", "--set", self.set_path, "--key-file", self.key_path, "--out", self.out,
                "--base-url", base_url or self.endpoint.base_url, "--concurrency", "2", "--timeout", "2"] + list(extra)
        code = run_bakeoff.main(argv, log=self.lines.append)
        return code

    def results(self):
        files = [name for name in os.listdir(self.out) if name.endswith(".json")]
        self.assertEqual(len(files), 1)
        with open(os.path.join(self.out, files[0]), "r", encoding="utf-8") as handle:
            text = handle.read()
        return json.loads(text), text

    def test_writes_the_documented_results_format(self):
        code = self.run_harness(lambda path, body, index: (200, completion("reply for " + body["messages"][1]["content"])))
        self.assertEqual(code, 0)
        data, _ = self.results()
        self.assertEqual(sorted(data.keys()), sorted(["format", "formatVersion", "harnessVersion", "set", "model", "providerKey", "options",
                                                      "partial", "startedAt", "finishedAt", "batches", "cases"]))
        self.assertEqual((data["format"], data["formatVersion"], data["model"], data["providerKey"], data["partial"]),
                         ("one-bakeoff-results", 1, "served-model", "openai-compatible", False))
        self.assertEqual(data["set"], {"key": "tiny-set", "version": 1, "sha256": run_bakeoff.file_sha256(self.set_path)})
        self.assertEqual([batch["task"] for batch in data["batches"]], ["answer-check", "tutor-hint", "lesson-draft"])
        self.assertEqual([batch["cases"] for batch in data["batches"]], [1, 2, 1])
        self.assertEqual(sorted(case["id"] for case in data["cases"]), ["c1", "c2", "c3", "c4"])
        first = [case for case in data["cases"] if case["id"] == "c1"][0]
        self.assertEqual(first["output"], "reply for user c1")
        self.assertEqual((first["finishReason"], first["promptTokens"], first["completionTokens"], first["attempts"], first["error"]),
                         ("stop", 50, 10, 1, None))
        self.assertRegex(data["startedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

    def test_sends_exactly_the_adapter_body(self):
        self.run_harness(lambda path, body, index: (200, completion("ok")))
        posts = [request for request in self.endpoint.requests if request["method"] == "POST"]
        self.assertEqual(len(posts), 4)
        for request in posts:
            self.assertEqual(request["path"], "/v1/chat/completions")
            self.assertEqual(sorted(request["body"].keys()), ["max_tokens", "messages", "model", "stream", "temperature"])
            self.assertIs(request["body"]["stream"], False)
            self.assertEqual(request["body"]["model"], "served-model")

    def test_chat_template_kwargs_only_when_asked_and_recorded(self):
        self.run_harness(lambda path, body, index: (200, completion("ok")), extra=["--chat-template-kwargs", '{"enable_thinking": false}'])
        posts = [request for request in self.endpoint.requests if request["method"] == "POST"]
        self.assertTrue(all(request["body"]["chat_template_kwargs"] == {"enable_thinking": False} for request in posts))
        data, _ = self.results()
        self.assertEqual(data["options"]["chatTemplateKwargs"], {"enable_thinking": False})

    def test_never_prints_or_writes_the_key(self):
        def script(path, body, index):
            return (500, {"error": "boom " + SECRET}) if index % 2 else (200, completion("fine"))
        self.run_harness(script, extra=["--max-attempts", "1"])
        _, text = self.results()
        self.assertNotIn(SECRET, text)
        self.assertNotIn(SECRET, "\n".join(self.lines))
        self.assertNotIn("boom", text)

    def test_retries_server_errors_with_the_adapter_policy(self):
        calls = {"n": 0}

        def script(path, body, index):
            if body["messages"][1]["content"] == "user c4":
                calls["n"] += 1
                return (503, {}) if calls["n"] < 3 else (200, completion("third time"))
            return (200, completion("ok"))
        original = run_bakeoff.Client.__init__

        def fast(client, *args, **kwargs):
            original(client, *args, **kwargs)
            client.sleep = lambda seconds: None
        run_bakeoff.Client.__init__ = fast
        try:
            self.run_harness(script)
        finally:
            run_bakeoff.Client.__init__ = original
        data, _ = self.results()
        c4 = [case for case in data["cases"] if case["id"] == "c4"][0]
        self.assertEqual((c4["output"], c4["attempts"], c4["error"]), ("third time", 3, None))

    def test_a_timeout_is_recorded_and_not_retried(self):
        def script(path, body, index):
            return ("sleep", 3.5) if body["messages"][1]["content"] == "user c3" else (200, completion("ok"))
        self.run_harness(script)
        data, _ = self.results()
        c3 = [case for case in data["cases"] if case["id"] == "c3"][0]
        self.assertEqual((c3["output"], c3["error"], c3["attempts"]), (None, "PROVIDER_TIMEOUT", 1))
        self.assertGreaterEqual(c3["latencyMs"], 1900)

    def test_malformed_and_empty_replies_are_failure_classes(self):
        def script(path, body, index):
            content = body["messages"][1]["content"]
            if content == "user c1":
                return (200, {"choices": []})
            if content == "user c2":
                return (200, completion("   "))
            return (200, completion("ok"))
        self.run_harness(script)
        data, _ = self.results()
        errors = {case["id"]: case["error"] for case in data["cases"]}
        self.assertEqual(errors, {"c1": "PROVIDER_MALFORMED_RESPONSE", "c2": "PROVIDER_MALFORMED_RESPONSE", "c3": None, "c4": None})

    def test_limit_marks_the_run_partial(self):
        self.run_harness(lambda path, body, index: (200, completion("ok")), extra=["--limit", "1"])
        data, _ = self.results()
        self.assertTrue(data["partial"])
        self.assertEqual(len(data["cases"]), 3)

    def test_a_model_that_is_not_served_stops_before_any_case(self):
        code = self.run_harness(lambda path, body, index: (200, completion("ok")), models=("other-model",))
        self.assertEqual(code, 2)
        self.assertFalse([request for request in self.endpoint.requests if request["method"] == "POST"])

    def test_a_wrong_key_stops_with_exit_3(self):
        with open(self.key_path, "w", encoding="utf-8") as handle:
            handle.write("not-the-key\n")
        code = self.run_harness(lambda path, body, index: (200, completion("ok")))
        self.assertEqual(code, 3)
        self.assertTrue(any("PROVIDER_AUTH_FAILED" in line for line in self.lines))

    def test_plain_http_is_refused_off_loopback(self):
        code = self.run_harness(lambda path, body, index: (200, completion("ok")), base_url="http://pod.example.test:8888/v1")
        self.assertEqual(code, 1)
        self.assertFalse(self.endpoint.requests)
        with self.assertRaises(run_bakeoff.ConfigurationError):
            run_bakeoff.check_base_url("https://user:pw@pod.example.test/v1")
        self.assertEqual(run_bakeoff.check_base_url("https://pod.example.test/v1/"), "https://pod.example.test/v1")

    def test_an_empty_key_file_is_refused(self):
        with open(self.key_path, "w", encoding="utf-8") as handle:
            handle.write("\n")
        self.assertEqual(self.run_harness(lambda path, body, index: (200, completion("ok"))), 1)

    def test_the_set_hash_ignores_line_endings(self):
        crlf = os.path.join(self.dir, "crlf.json")
        lf = os.path.join(self.dir, "lf.json")
        with open(lf, "wb") as handle:
            handle.write(b'{"a": 1,\n "b": 2}\n')
        with open(crlf, "wb") as handle:
            handle.write(b'{"a": 1,\r\n "b": 2}\r\n')
        self.assertEqual(run_bakeoff.file_sha256(lf), run_bakeoff.file_sha256(crlf))

    def test_the_committed_set_loads(self):
        data = run_bakeoff.load_set(os.path.join(os.path.dirname(HERE), "eval-set-v1.json"))
        self.assertEqual((data["setKey"], data["setVersion"], len(data["cases"])), ("one-ai-bakeoff", 1, 200))


if __name__ == "__main__":
    unittest.main()
