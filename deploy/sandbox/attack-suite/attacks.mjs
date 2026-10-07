#!/usr/bin/env node
/**
 * The code sandbox attack suite (ENG-12): hostile Python programs sent to a running sandbox, each with
 * the outcome the sandbox must produce. Exits 1 if any attack is not contained.
 *
 * Why this exists: the sandbox's claims (no network, hard CPU / memory / process / time limits, nothing
 * written outside a per-run scratch, nothing shared between runs, only two routes reachable) are only
 * worth what a hostile program cannot get past. This is that program, scripted, so the claims are
 * re-checked on every image bump and on the VM after provisioning (README.md step 6).
 *
 * Usage: SANDBOX_URL=http://127.0.0.1:2000 SANDBOX_TOKEN=... node attacks.mjs
 * (run.sh starts a local sandbox in Docker and calls this.) Node 18+; no dependencies.
 */
import { randomUUID } from 'node:crypto';

const BASE = (process.env.SANDBOX_URL ?? 'http://127.0.0.1:2000').replace(/\/+$/, '');
const TOKEN = process.env.SANDBOX_TOKEN ?? '';
const LANGUAGE = 'python';
const VERSION = process.env.SANDBOX_PYTHON_VERSION ?? '3.12.0';
// code-sandbox-limits-v1: what the ONE worker asks for (packages/persistence/src/code-sandbox-client.ts).
const LIMITS = { run_timeout: 5000, run_cpu_time: 3000, run_memory_limit: 134_217_728 };

if (!TOKEN) {
  console.error('SANDBOX_TOKEN is required');
  process.exit(2);
}

async function execute(code, extra = {}) {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/v2/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ language: LANGUAGE, version: VERSION, files: [{ name: 'main.py', content: code }], stdin: '', ...LIMITS, ...extra }),
    signal: AbortSignal.timeout(60_000),
  });
  const elapsedMs = Date.now() - started;
  if (!response.ok) throw new Error(`execute answered ${response.status}`);
  const body = await response.json();
  return { ...body.run, elapsedMs };
}

const lines = (run) => (run.stdout ?? '').split('\n').filter(Boolean);
const summary = (run) => `status=${run.status} code=${run.code} signal=${run.signal} wall=${run.wall_time}ms mem=${run.memory}`;

/** Each attack returns { ok, detail }. */
const attacks = [
  {
    name: 'fork bomb is contained (process limit) and the sandbox survives',
    async run() {
      const run = await execute(`
import os, time
count = 0
try:
    while True:
        pid = os.fork()
        if pid == 0:
            time.sleep(30)
            os._exit(0)
        count += 1
except OSError as error:
    print("FORK_REFUSED", count, type(error).__name__, flush=True)
time.sleep(1)
`);
      const refused = lines(run).find((line) => line.startsWith('FORK_REFUSED'));
      const forks = refused ? Number(refused.split(' ')[1]) : Number.NaN;
      const after = await execute('print("alive")');
      const ok = Boolean(refused) && forks < 16 && after.stdout === 'alive\n';
      return { ok, detail: `${refused ?? 'no refusal seen'}; ${summary(run)}; follow-up run: ${JSON.stringify(after.stdout)}` };
    },
  },
  {
    name: 'classic fork bomb (fork in every child) is killed and leaves nothing running',
    async run() {
      const run = await execute(`
import os
while True:
    try:
        os.fork()
    except OSError:
        pass
`);
      const probe = await execute(`
import os
print(len([p for p in os.listdir("/proc") if p.isdigit()]))
`);
      const ok = run.status === 'TO' && run.signal === 'SIGKILL' && Number(probe.stdout) <= 4;
      return { ok, detail: `${summary(run)}; processes visible to the next run: ${probe.stdout.trim()}` };
    },
  },
  {
    name: 'CPU-bound infinite loop is killed by the time limit',
    async run() {
      const run = await execute('while True:\n    pass\n');
      const ok = run.status === 'TO' && run.signal === 'SIGKILL' && run.elapsedMs < 15_000;
      return { ok, detail: `${summary(run)}; round trip ${run.elapsedMs}ms` };
    },
  },
  {
    name: 'sleeping forever is killed by the wall-clock limit',
    async run() {
      const run = await execute('import time\ntime.sleep(600)\n');
      const ok = run.status === 'TO' && run.signal === 'SIGKILL' && run.elapsedMs < 15_000;
      return { ok, detail: `${summary(run)}; round trip ${run.elapsedMs}ms` };
    },
  },
  {
    name: 'memory bomb is stopped at the memory limit',
    async run() {
      const run = await execute(`
chunks = []
while True:
    chunks.append(bytearray(16 * 1024 * 1024))
    print("ALLOCATED", len(chunks) * 16, flush=True)
`);
      const reached = lines(run).filter((line) => line.startsWith('ALLOCATED')).map((line) => Number(line.split(' ')[1]));
      const peakMb = reached.length ? Math.max(...reached) : 0;
      const ok = run.code !== 0 && peakMb <= 128 && (run.status === 'SG' || run.status === 'RE');
      return { ok, detail: `${summary(run)}; peak reported ${peakMb} MiB (limit 128 MiB)` };
    },
  },
  {
    name: 'writes outside the run scratch fail',
    async run() {
      const run = await execute(`
targets = ["/etc/one-sandbox-probe", "/usr/one-sandbox-probe", "/bin/one-sandbox-probe", "/piston/one-sandbox-probe",
           "/piston/packages/one-sandbox-probe", "/one-sandbox-probe", "/proc/one-sandbox-probe", "/dev/one-sandbox-probe"]
for target in targets:
    try:
        with open(target, "w") as handle:
            handle.write("x")
        print("WROTE", target)
    except Exception as error:
        print("REFUSED", target, type(error).__name__)
`);
      const wrote = lines(run).filter((line) => line.startsWith('WROTE'));
      const refused = lines(run).filter((line) => line.startsWith('REFUSED'));
      return { ok: wrote.length === 0 && refused.length === 8, detail: wrote.length ? wrote.join('; ') : `all 8 refused; ${summary(run)}` };
    },
  },
  {
    name: 'a file larger than the file-size limit cannot be written, even in scratch',
    async run() {
      const run = await execute(`
try:
    with open("/tmp/big", "wb") as handle:
        for _ in range(64):
            handle.write(b"x" * 1024 * 1024)
    print("WROTE_64MB")
except Exception as error:
    print("REFUSED", type(error).__name__)
`);
      const ok = !lines(run).includes('WROTE_64MB');
      return { ok, detail: `${summary(run)}; stdout ${JSON.stringify(run.stdout.trim())}` };
    },
  },
  {
    name: 'host secrets and the container runtime are not readable',
    async run() {
      const run = await execute(`
import os
for path in ["/etc/shadow", "/var/run/docker.sock", "/run/docker.sock", "/root/.ssh/id_rsa", "/proc/1/environ"]:
    try:
        with open(path, "rb") as handle:
            data = handle.read()
        print("READ", path, len(data))
    except Exception as error:
        print("REFUSED", path, type(error).__name__)
print("UID", os.getuid())
print("ENV", ",".join(sorted(os.environ.keys())))
with open("/proc/1/cmdline", "rb") as handle:
    print("PID1", handle.read().split(b"\\0")[0].decode())
`);
      const out = lines(run);
      const leaked = out.filter((line) => line.startsWith('READ') && !line.startsWith('READ /proc/1/environ'));
      const environ = out.find((line) => line.startsWith('READ /proc/1/environ'));
      const env = (out.find((line) => line.startsWith('ENV')) ?? '').slice(4).split(',');
      const secretish = env.filter((key) => /TOKEN|SECRET|PASSWORD|DATABASE|KEY|AWS/i.test(key));
      const uid = Number((out.find((line) => line.startsWith('UID')) ?? 'UID -1').split(' ')[1]);
      const pid1 = (out.find((line) => line.startsWith('PID1')) ?? '').slice(5);
      const ok = leaked.length === 0 && secretish.length === 0 && uid !== 0 && !/node|piston/.test(pid1);
      return { ok, detail: `uid=${uid}; env keys=[${env.join(',')}]; pid 1=${pid1}; ${environ ?? 'pid-1 environ refused'}; leaked=${leaked.join('|') || 'none'}` };
    },
  },
  {
    name: 'privilege escalation (setuid 0, mount, chroot) is refused',
    async run() {
      const run = await execute(`
import os, ctypes
for name, attempt in [("setuid", lambda: os.setuid(0)), ("chroot", lambda: os.chroot("/tmp"))]:
    try:
        attempt()
        print("ALLOWED", name)
    except Exception as error:
        print("REFUSED", name, type(error).__name__)
libc = ctypes.CDLL(None, use_errno=True)
result = libc.mount(b"none", b"/tmp", b"tmpfs", 0, None)
print("ALLOWED mount" if result == 0 else "REFUSED mount errno " + str(ctypes.get_errno()))
`);
      const allowed = lines(run).filter((line) => line.startsWith('ALLOWED'));
      return { ok: allowed.length === 0 && lines(run).length === 3, detail: lines(run).join('; ') || summary(run) };
    },
  },
  {
    name: 'outbound network: DNS, TCP to 1.1.1.1:443 and HTTP are all blocked',
    async run() {
      const run = await execute(`
import socket, urllib.request
def attempt(name, action):
    try:
        action()
        print("OPEN", name)
    except Exception as error:
        print("BLOCKED", name, type(error).__name__)
attempt("dns", lambda: socket.gethostbyname("example.com"))
attempt("tcp-1.1.1.1:443", lambda: socket.create_connection(("1.1.1.1", 443), timeout=2).close())
attempt("tcp-8.8.8.8:53", lambda: socket.create_connection(("8.8.8.8", 53), timeout=2).close())
attempt("udp-dns-8.8.8.8", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"x", ("8.8.8.8", 53)))
attempt("http", lambda: urllib.request.urlopen("http://example.com", timeout=2).read())
attempt("https-ip", lambda: urllib.request.urlopen("https://1.1.1.1", timeout=2).read())
with open("/proc/net/dev") as handle:
    interfaces = [line.split(":")[0].strip() for line in handle.readlines()[2:]]
print("INTERFACES", ",".join(interfaces))
`);
      const out = lines(run);
      const open = out.filter((line) => line.startsWith('OPEN'));
      const blocked = out.filter((line) => line.startsWith('BLOCKED'));
      const interfaces = (out.find((line) => line.startsWith('INTERFACES')) ?? '').slice(11);
      const ok = open.length === 0 && blocked.length === 6 && interfaces === 'lo';
      return { ok, detail: `${blocked.join('; ')}; ${open.join('; ')}; interfaces=${interfaces}` };
    },
  },
  {
    name: 'the sandbox network cannot reach the proxy or the Docker host either',
    async run() {
      const run = await execute(`
import socket
for host, port in [("proxy", 8080), ("piston", 2000), ("172.17.0.1", 2375), ("host.docker.internal", 2000), ("127.0.0.1", 2000)]:
    try:
        socket.create_connection((host, port), timeout=2).close()
        print("OPEN", host, port)
    except Exception as error:
        print("BLOCKED", host, port, type(error).__name__)
`);
      const open = lines(run).filter((line) => line.startsWith('OPEN'));
      return { ok: open.length === 0 && lines(run).length === 5, detail: lines(run).join('; ') };
    },
  },
  {
    name: 'scratch is not shared between runs',
    async run() {
      const marker = randomUUID();
      const first = await execute(`
import os
for path in ["/tmp/${marker}", "/box/submission/${marker}", os.path.expanduser("~/${marker}")]:
    try:
        open(path, "w").write("x")
        print("WROTE", path)
    except Exception as error:
        print("REFUSED", path, type(error).__name__)
`);
      const second = await execute(`
import os
found = [p for p in ["/tmp/${marker}", "/box/submission/${marker}", os.path.expanduser("~/${marker}")] if os.path.exists(p)]
print("FOUND", len(found), ",".join(found))
`);
      const wroteSomewhere = lines(first).some((line) => line.startsWith('WROTE'));
      const ok = wroteSomewhere && second.stdout.startsWith('FOUND 0');
      return { ok, detail: `first run: ${lines(first).join('; ')}; second run: ${second.stdout.trim()}` };
    },
  },
  {
    name: 'output flood is cut off at the output limit',
    async run() {
      const run = await execute('import sys\nwhile True:\n    sys.stdout.write("x" * 65536)\n');
      const ok = (run.status === 'OL' || run.status === 'TO') && (run.stdout ?? '').length <= 65536;
      return { ok, detail: `${summary(run)}; stdout kept ${(run.stdout ?? '').length} bytes` };
    },
  },
  {
    name: 'a request above the configured limits is refused, not honoured',
    async run() {
      const response = await fetch(`${BASE}/api/v2/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ language: LANGUAGE, version: VERSION, files: [{ content: 'print(1)' }], run_timeout: 600_000 }),
      });
      return { ok: response.status === 400, detail: `answered ${response.status}` };
    },
  },
  {
    name: 'the proxy forwards only execute and runtimes, and only with the token',
    async run() {
      const results = [];
      const probe = async (label, path, init, expected) => {
        const response = await fetch(`${BASE}${path}`, init);
        results.push(`${label}=${response.status}`);
        return response.status === expected;
      };
      const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
      const checks = await Promise.all([
        probe('execute-no-token', '/api/v2/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 401),
        probe('execute-wrong-token', '/api/v2/execute', { method: 'POST', headers: { ...auth, authorization: 'Bearer wrong' }, body: '{}' }, 401),
        probe('runtimes-no-token', '/api/v2/runtimes', {}, 401),
        probe('install-package', '/api/v2/packages', { method: 'POST', headers: auth, body: JSON.stringify({ language: 'bash', version: '5.2.0' }) }, 404),
        probe('remove-package', '/api/v2/packages', { method: 'DELETE', headers: auth, body: JSON.stringify({ language: LANGUAGE, version: VERSION }) }, 404),
        probe('list-packages', '/api/v2/packages', { headers: auth }, 404),
        probe('websocket-connect', '/api/v2/connect', { headers: auth }, 404),
        probe('execute-get', '/api/v2/execute', { headers: auth }, 403),
      ]);
      return { ok: checks.every(Boolean), detail: results.join(', ') };
    },
  },
];

let failed = 0;
console.log(`ONE code sandbox attack suite against ${BASE} (python ${VERSION})`);
for (const attack of attacks) {
  try {
    const { ok, detail } = await attack.run();
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${attack.name}\n      ${detail}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${attack.name}\n      error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`${attacks.length - failed}/${attacks.length} attacks contained`);
process.exit(failed ? 1 : 0);
