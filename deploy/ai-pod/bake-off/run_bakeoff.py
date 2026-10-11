#!/usr/bin/env python3
"""run_bakeoff.py - run ONE's AI evaluation set against a served model and write a results file.

What this is: the bake-off harness for ENG-21. It runs on the inference pod (ADR-047), against the
vLLM endpoint on the pod itself, and only collects: for every case it sends exactly the request
body ONE's inference adapter (ENG-20) sends, and records the reply text, finish reason, tokens,
latency and attempts. Scoring, the report and recording in ai_evaluations happen in the repository
(packages/ai-evaluation, `ai:bake-off-import`), so the numbers that can let a model reach students
are computed by ONE's own code from these raw replies.

Why Python with the standard library only: the pod's disk is wiped on every stop, and this must run
in its stock python3 with nothing to install.

Usage (on the pod, as root):
    python3 run_bakeoff.py --model qwen2.5-14b-instruct
    python3 run_bakeoff.py --model qwen2.5-7b-instruct --model other-name --out results/
    python3 run_bakeoff.py --model qwen2.5-14b-instruct --only explain-topic

By default every committed set runs (one-ai-bakeoff v1 and, for ADR-052, one-ai-explain v1), one results
file per set and model. --set picks set files (repeatable); --only explain-topic runs only the explain set.

The key is read from --key-file (default /root/one-ai/api-key). It is never accepted on the
command line or from the environment, never printed and never written to the results file.
Plain http:// is refused except for loopback, as in the adapter.

Exit codes: 0 done; 1 bad arguments or configuration; 2 a requested model is not served;
3 the endpoint refused the key or could not be reached.

Design: docs/architecture/ai-bake-off-design.md (Decision 7).
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import http.client
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HARNESS_VERSION = "one-bakeoff-harness-v1"
RESULTS_FORMAT = "one-bakeoff-results"
RESULTS_FORMAT_VERSION = 1
SET_FORMAT = "one-bakeoff-set"
SET_FORMAT_VERSION = 1
PROVIDER_KEY = "openai-compatible"  # ENG-20 records the venue as configuration, the model by name
# explain-topic (ADR-052) lives in its own set, eval-set-explain-v1.json; the order is per set.
TASK_ORDER = ("answer-check", "tutor-hint", "lesson-draft", "explain-topic")
DEFAULT_SETS = ("eval-set-v1.json", "eval-set-explain-v1.json")
RETRY_STATUSES = (429, 500, 502, 503, 504)
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
DEFAULT_BASE_URL = "http://127.0.0.1:8888/v1"
DEFAULT_KEY_FILE = "/root/one-ai/api-key"


class HarnessError(Exception):
    """A failure with an ENG-20 failure class; the message never carries the upstream body or the key."""

    def __init__(self, failure_class, attempts=0, status=None):
        Exception.__init__(self, failure_class)
        self.failure_class = failure_class
        self.attempts = attempts
        self.status = status


class ConfigurationError(Exception):
    pass


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def file_sha256(path):
    """SHA-256 of the file with CRLF normalised to LF, matching the repository's contentSha256."""
    with open(path, "rb") as handle:
        data = handle.read()
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def load_set(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if data.get("format") != SET_FORMAT or data.get("formatVersion") != SET_FORMAT_VERSION:
        raise ConfigurationError("not a one-bakeoff-set v1 file: " + path)
    cases = data.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ConfigurationError("the set has no cases")
    seen = set()
    for case in cases:
        if case.get("task") not in TASK_ORDER or not isinstance(case.get("request"), dict):
            raise ConfigurationError("a case has no known task or no request")
        if case.get("id") in seen:
            raise ConfigurationError("case ids repeat")
        seen.add(case.get("id"))
    return data


def read_key(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            key = handle.read().strip()
    except OSError:
        raise ConfigurationError("cannot read the key file " + path)
    if not key or any(character.isspace() for character in key):
        raise ConfigurationError("the key file " + path + " is empty or malformed")
    return key


def check_base_url(url):
    """https anywhere; http only to loopback; no credentials, query or fragment."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ConfigurationError("the base URL must be http(s)://host[:port]/v1")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConfigurationError("the base URL must not carry credentials, a query or a fragment")
    if parsed.scheme == "http" and parsed.hostname not in LOOPBACK_HOSTS:
        raise ConfigurationError("plain http is allowed only to loopback; the key would travel in clear text")
    return url.rstrip("/")


class Client(object):
    """The adapter's call policy: no streaming, a per-attempt timeout that is not retried, and up to
    max_attempts attempts with backoff 0.5 s doubling for 429/5xx and connections that never opened."""

    def __init__(self, base_url, key, timeout_seconds, max_attempts, backoff_seconds=0.5, sleep=time.sleep):
        self.base_url = base_url
        self._key = key
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds
        self.sleep = sleep
        # No proxies: the endpoint is the pod's own loopback, and a proxy would see the key.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _headers(self):
        return {"Authorization": "Bearer " + self._key, "Content-Type": "application/json", "Accept": "application/json"}

    def _once(self, method, path, body):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.base_url + path, data=data, headers=self._headers(), method=method)
        with self._opener.open(request, timeout=self.timeout_seconds) as response:
            return response.read()

    def call(self, method, path, body=None):
        """Returns (parsed JSON, attempts). Raises HarnessError."""
        attempts = 0
        while True:
            attempts += 1
            try:
                raw = self._once(method, path, body)
            except urllib.error.HTTPError as error:
                status = error.code
                try:
                    error.close()  # the body is never read or kept: it can echo the prompt
                except Exception:
                    pass
                if status in (401, 403):
                    raise HarnessError("PROVIDER_AUTH_FAILED", attempts, status)
                if status == 404:
                    raise HarnessError("PROVIDER_NOT_FOUND", attempts, status)
                if status in RETRY_STATUSES:
                    if attempts < self.max_attempts:
                        self.sleep(self.backoff_seconds * (2 ** (attempts - 1)))
                        continue
                    raise HarnessError("PROVIDER_RATE_LIMITED" if status == 429 else "PROVIDER_SERVER_ERROR", attempts, status)
                raise HarnessError("PROVIDER_REJECTED", attempts, status)
            except (socket.timeout, TimeoutError):
                raise HarnessError("PROVIDER_TIMEOUT", attempts)
            except urllib.error.URLError as error:
                if isinstance(error.reason, (socket.timeout, TimeoutError)):
                    raise HarnessError("PROVIDER_TIMEOUT", attempts)
                if attempts < self.max_attempts:
                    self.sleep(self.backoff_seconds * (2 ** (attempts - 1)))
                    continue
                raise HarnessError("PROVIDER_UNREACHABLE", attempts)
            except (ConnectionError, OSError, http.client.HTTPException):
                if attempts < self.max_attempts:
                    self.sleep(self.backoff_seconds * (2 ** (attempts - 1)))
                    continue
                raise HarnessError("PROVIDER_UNREACHABLE", attempts)
            try:
                return json.loads(raw.decode("utf-8")), attempts
            except (ValueError, UnicodeDecodeError):
                raise HarnessError("PROVIDER_MALFORMED_RESPONSE", attempts)

    def served_models(self):
        data, _ = self.call("GET", "/models")
        entries = data.get("data") if isinstance(data, dict) else None
        if not isinstance(entries, list):
            raise HarnessError("PROVIDER_MALFORMED_RESPONSE", 1)
        return [entry.get("id") for entry in entries if isinstance(entry, dict)]

    def complete(self, body):
        data, attempts = self.call("POST", "/chat/completions", body)
        try:
            choice = data["choices"][0]
            text = choice["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise HarnessError("PROVIDER_MALFORMED_RESPONSE", attempts)
        if not isinstance(text, str) or not text.strip():
            raise HarnessError("PROVIDER_MALFORMED_RESPONSE", attempts)
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}

        def tokens(name):
            value = usage.get(name)
            return value if isinstance(value, int) and value >= 0 else 0

        return {
            "output": text,
            "finishReason": choice.get("finish_reason") if isinstance(choice.get("finish_reason"), str) else None,
            "promptTokens": tokens("prompt_tokens"),
            "completionTokens": tokens("completion_tokens"),
            "attempts": attempts,
        }


def request_body(model, case, chat_template_kwargs):
    """Exactly the adapter's body (model, messages, max_tokens, temperature, stream=false), plus
    chat_template_kwargs only when the operator asked for it (recorded in the results)."""
    request = case["request"]
    body = {
        "model": model,
        "messages": request["messages"],
        "max_tokens": request["max_tokens"],
        "temperature": request["temperature"],
        "stream": False,
    }
    if chat_template_kwargs is not None:
        body["chat_template_kwargs"] = chat_template_kwargs
    return body


def run_case(client, model, case, chat_template_kwargs, clock=time.monotonic):
    started = clock()
    entry = {"id": case["id"], "task": case["task"], "output": None, "finishReason": None,
             "promptTokens": 0, "completionTokens": 0, "latencyMs": 0, "attempts": 0, "error": None}
    try:
        reply = client.complete(request_body(model, case, chat_template_kwargs))
        entry.update(reply)
    except HarnessError as error:
        entry["error"] = error.failure_class
        entry["attempts"] = error.attempts
    entry["latencyMs"] = int(round((clock() - started) * 1000))
    return entry


def percentile(values, p):
    if not values:
        return 0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, -(-p * len(ordered) // 100) - 1))
    return ordered[int(index)]


def run_model(client, model, data, set_sha, options, log):
    cases = data["cases"]
    started_at = utc_now()
    results, batches, partial = [], [], False
    for task in TASK_ORDER:
        group = [case for case in cases if case["task"] == task]
        if options.limit is not None and len(group) > options.limit:
            group, partial = group[: options.limit], True
        if not group:
            continue
        wall_start = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=options.concurrency) as pool:
            done = list(pool.map(lambda case: run_case(client, model, case, options.chat_template_kwargs), group))
        wall = max(time.monotonic() - wall_start, 0.001)
        batches.append({"task": task, "cases": len(group), "wallSeconds": round(wall, 3), "concurrency": options.concurrency})
        results.extend(done)
        latencies = [entry["latencyMs"] for entry in done]
        errors = [entry["error"] for entry in done if entry["error"]]
        log("[bake-off] %s %s: %d cases in %.1fs, errors %d, latency p50 %d ms p95 %d ms, tokens in %d out %d" % (
            model, task, len(done), wall, len(errors), percentile(latencies, 50), percentile(latencies, 95),
            sum(entry["promptTokens"] for entry in done), sum(entry["completionTokens"] for entry in done)))
        if errors:
            log("[bake-off]   error classes: %s" % ", ".join(sorted(set(errors))))
    return {
        "format": RESULTS_FORMAT,
        "formatVersion": RESULTS_FORMAT_VERSION,
        "harnessVersion": HARNESS_VERSION,
        "set": {"key": data.get("setKey"), "version": data.get("setVersion"), "sha256": set_sha},
        "model": model,
        "providerKey": PROVIDER_KEY,
        "options": {"concurrency": options.concurrency, "timeoutSeconds": options.timeout, "maxAttempts": options.max_attempts,
                    "chatTemplateKwargs": options.chat_template_kwargs},
        "partial": partial,
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "batches": batches,
        "cases": results,
    }


def parse_args(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Run ONE's AI evaluation set against served models (ENG-21).")
    parser.add_argument("--model", action="append", required=True, help="served model name; repeat for several")
    parser.add_argument("--set", action="append", default=None,
                        help="an evaluation set file; repeat for several (default: every committed set)")
    parser.add_argument("--only", choices=("explain-topic",), default=None,
                        help="run only the sets for this task (explain-topic: eval-set-explain-v1.json)")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="OpenAI-compatible base ending in /v1")
    parser.add_argument("--key-file", default=DEFAULT_KEY_FILE, help="file holding the bearer key (never printed)")
    parser.add_argument("--out", default=os.path.join(here, "results"), help="directory for results files")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--timeout", type=int, default=120, help="seconds per attempt")
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--limit", type=int, default=None, help="smoke run: at most N cases per task (marked partial; never recordable)")
    parser.add_argument("--chat-template-kwargs", default=None,
                        help='JSON object sent as chat_template_kwargs, e.g. \'{"enable_thinking": false}\' for Qwen3; recorded in the results')
    options = parser.parse_args(argv)
    if options.concurrency < 1 or options.timeout < 1 or options.max_attempts < 1 or (options.limit is not None and options.limit < 1):
        parser.error("concurrency, timeout, max-attempts and limit must be positive")
    if options.chat_template_kwargs is not None:
        try:
            options.chat_template_kwargs = json.loads(options.chat_template_kwargs)
        except ValueError:
            parser.error("--chat-template-kwargs must be JSON")
        if not isinstance(options.chat_template_kwargs, dict):
            parser.error("--chat-template-kwargs must be a JSON object")
    for model in options.model:
        if not model or model != model.strip() or len(model) > 200:
            parser.error("a model name must be 1-200 characters with no surrounding spaces")
    if options.only and options.set:
        parser.error("--only and --set cannot be combined")
    if options.only == "explain-topic":
        options.set = [os.path.join(here, "eval-set-explain-v1.json")]
    elif not options.set:
        options.set = [os.path.join(here, name) for name in DEFAULT_SETS]
    return options


def main(argv=None, log=None):
    log = log or (lambda line: print(line, flush=True))
    options = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        base_url = check_base_url(options.base_url)
        sets = [(load_set(path), file_sha256(path)) for path in options.set]
        key = read_key(options.key_file)
    except (ConfigurationError, OSError, ValueError) as error:
        log("[bake-off] FAILED: %s" % error)
        return 1
    client = Client(base_url, key, options.timeout, options.max_attempts)
    try:
        served = client.served_models()
    except HarnessError as error:
        log("[bake-off] FAILED: the endpoint answered %s when listing models" % error.failure_class)
        return 3
    missing = [model for model in options.model if model not in served]
    if missing:
        log("[bake-off] FAILED: not served here: %s (served: %s)" % (", ".join(missing), ", ".join(str(name) for name in served)))
        return 2
    os.makedirs(options.out, exist_ok=True)
    for data, set_sha in sets:
        log("[bake-off] set %s v%s, %d cases, sha256 %s" % (data.get("setKey"), data.get("setVersion"), len(data["cases"]), set_sha))
    for model in options.model:
        for data, set_sha in sets:
            results = run_model(client, model, data, set_sha, options, log)
            stamp = results["startedAt"].replace(":", "").replace("-", "").replace(".", "")
            safe = lambda value: re.sub(r"[^A-Za-z0-9._-]", "_", str(value))
            name = "results-%s-%s-%s.json" % (safe(data.get("setKey")), safe(model), stamp)
            path = os.path.join(options.out, name)
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(results, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            log("[bake-off] wrote %s%s" % (path, " (PARTIAL: smoke run, not recordable)" if results["partial"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
