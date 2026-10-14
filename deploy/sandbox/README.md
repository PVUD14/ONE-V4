# Code sandbox — runbook (ENG-12)

What this folder is: the deployment for ONE's isolated code sandbox — Piston behind a token-checking
proxy, for **one dedicated VM** — and the attack suite that proves it is contained. Design and threat
model: `docs/architecture/code-sandbox-design.md`. Decision: ADR-034 §6; evidence: ADR-049.

**Provisioning stops at HG-1 / HG-7.** Nothing in this repository creates a VM, a security group or a
DNS record. Steps 1–3 are Divakar's, by hand, once AWS access exists. Until then the worker's
`ONE_CODE_SANDBOX_URL` is blank, every submission ends `FAILED / SANDBOX_UNAVAILABLE`, and the
`learning.code-sandbox` flag is off anyway.

| File | What it is |
|---|---|
| `docker-compose.yml` | Piston (privileged, read-only root, tmpfs scratch, internal network with no route out) and the nginx proxy (the only published port) |
| `docker-compose.install.yml` | Overlay that gives Piston an outbound route **only while runtimes are installed** |
| `proxy/sandbox.conf.template` | Forwards `POST /api/v2/execute` and `GET /api/v2/runtimes` with the bearer token; everything else 404/403 |
| `attack-suite/run.sh` | One command: start locally, install Python, drop the route, run the attacks |
| `attack-suite/attacks.mjs` | The attacks and what each must produce |

## Run it locally (any machine with Docker + cgroup v2, Node 18+)

    bash deploy/sandbox/attack-suite/run.sh

It prints one line per attack and `15/15 attacks contained`, checks the Piston container itself has no
egress, and leaves the sandbox on `127.0.0.1:2000` with a throwaway token so the C8 test can use it:

    PISTON_URL=http://127.0.0.1:2000 PISTON_TOKEN=<printed> DATABASE_URL=... \
      corepack pnpm --filter @planthepath/api exec vitest run src/http/code-submissions.integration.spec.ts

Stop it: `docker compose -p one-sandbox-local -f deploy/sandbox/docker-compose.yml down -v`.
Docker Desktop on Windows (WSL2) works: Piston needs `--privileged` and cgroup v2, both available there.

## Provision the VM (HG-1 / HG-7 — Divakar)

1. **VM.** A small dedicated instance (2 vCPU, 4 GiB) in the same VPC as the application server, in a
   private subnet, **no public IP**, nothing else installed or running on it, no IAM role, no
   credentials of any kind. Ubuntu 24.04 (cgroup v2 by default). Install Docker Engine and the compose
   plugin.
2. **Security group.**
   - Inbound: TCP `2000` **only from the application server's private address** (the worker). SSH only
     through whatever administrative path the account already uses — never `0.0.0.0/0`.
   - Outbound: **none.** Temporarily allow HTTPS (443) only for step 4, then remove it. (The Docker
     `internal` network and isolate's per-run network namespace block egress too; this is the third layer.)
3. **Token.** Generate a long random value on the VM and on the application server, never in the
   repository: `openssl rand -hex 32`. On the VM it is `SANDBOX_TOKEN` in `/etc/one-sandbox.env`
   (mode 600, root); on the application server it is `ONE_CODE_SANDBOX_TOKEN` in the worker's
   environment.
4. **Install the runtime** (the only time Piston has an outbound route):

       cd /opt/one/deploy/sandbox   # a checkout of this folder
       set -a; . /etc/one-sandbox.env; set +a
       export SANDBOX_BIND=<the VM's private IP>
       docker compose -f docker-compose.yml -f docker-compose.install.yml up -d --wait
       docker compose exec -T piston node -e "const b=JSON.stringify({language:'python',version:'3.12.0'});const r=require('http').request({host:'127.0.0.1',port:2000,path:'/api/v2/packages',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(b)}},s=>{s.pipe(process.stdout)});r.end(b)"

5. **Run without the route** and remove the temporary 443 egress rule:

       docker compose -f docker-compose.yml up -d --wait --remove-orphans

6. **Prove it on the VM**: run the attack suite from the VM against itself (it needs Node; or copy
   `attacks.mjs` to any host that can reach the proxy):

       SANDBOX_URL=http://<private IP>:2000 SANDBOX_TOKEN=$SANDBOX_TOKEN node attack-suite/attacks.mjs

   Every line must be `PASS`. Keep the output with the release record.
7. **Point the worker at it.** In the worker's environment (never a request handler's):
   `ONE_CODE_SANDBOX_URL=http://<private IP>:2000`, `ONE_CODE_SANDBOX_TOKEN=<token>`. Restart the worker.
8. **Switch on** `learning.code-sandbox` in Operations → Platform controls. Turning it on is the
   high-risk direction (second person, or the solo cool-off). Its daily cap (2,000 submissions across
   ONE) is the flag's `cap_value`.

## Operating it

- **Image bumps:** change the digest in `docker-compose.yml`, run `attack-suite/run.sh` locally, then
  repeat steps 4–6 on the VM. Never use a moving tag.
- **Limits** (`code-sandbox-limits-v1`): the worker asks for 5 s wall, 3 s CPU, 128 MiB per run. The
  `PISTON_RUN_*` ceilings here must be at least those, or every job ends `SANDBOX_REJECTED`. Changing
  the worker's values is a new limits version (`packages/persistence/src/code-sandbox-client.ts`).
- **Sandbox down:** submissions end `FAILED / SANDBOX_UNAVAILABLE`; students see "the code runner is not
  available" and can send again. Nothing else in ONE is affected. To stop new submissions, switch the
  flag off.
- **Logs:** Piston logs job ids and runtimes, not programs. Nothing on the VM is personal data beyond
  the program text while a run is in flight (it lives in tmpfs and is destroyed with the box).
