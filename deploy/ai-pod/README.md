# ONE inference pod (RunPod) — setup and daily use

What this is: how to bring ONE's model endpoint up on the RunPod GPU pod, and how to connect ONE to
it. Why it exists: ADR-047 runs inference on a pod Divakar created, and the pod has **no persistent
volume** — every stop wipes the software, the model and the server. `setup-pod.sh` rebuilds all of
it, the same way, every time.

ONE never starts, stops or scales the pod. The pod bills while it runs.

## The pod (as of 2026-10-01)

| | |
|---|---|
| GPU | 1 × RTX A6000 (48 GB), Secure Cloud, US-KS-2 |
| Cost | about **$0.57 an hour** while running (about $410 a month if never stopped) |
| Driver / CUDA | 570 / 12.8 |
| Model | `Qwen/Qwen2.5-14B-Instruct` (Apache-2.0), served as **`qwen2.5-14b-instruct`** |
| Server | vLLM 0.11.0, `--max-model-len 16384 --gpu-memory-utilization 0.90`, port 8888 |
| Endpoint | `https://<pod-id>-8888.proxy.runpod.net/v1` — currently `https://sc8nlai7mv5i08-8888.proxy.runpod.net/v1`; the pod id changes if the pod is recreated |
| Key | `/root/one-ai/api-key` on the pod (mode 600). vLLM rejects any request without it (401) |

### Version notes (why the pins)

- **vllm 0.11.0 + torch 2.8.0+cu128.** The latest vLLM (0.30, built on torch for CUDA 13) fails on
  this pod with "NVIDIA driver too old". Do not upgrade without checking the driver first.
- **transformers >=4.56,<4.58.** transformers 5.x breaks vLLM 0.11 (`Qwen2Tokenizer` has no
  `all_special_tokens_extended`).

## Divakar's steps

### 1. Start the pod only when it is needed

RunPod console → the pod → **Start**. When you are done for the day, **Stop** it: it costs about
$0.57 every hour it runs, used or not. Stopping erases everything on it, the key file
included: the next start creates a new key unless you restore the old one first (step 5).

### 2. After every start, run the setup script

Open the pod's web terminal (or SSH) as root and run:

```
mkdir -p /root/one-ai && cd /root/one-ai
# copy setup-pod.sh here from the repository (deploy/ai-pod/setup-pod.sh), then:
bash setup-pod.sh
```

The first run on a fresh pod downloads the Python packages and about 30 GB of model weights, then
loads the model: allow 15–30 minutes. A second run on a pod that is already serving only re-runs the
self-test. The last lines should read:

```
[setup-pod] self-test: no key -> 401
[setup-pod] self-test: key -> 200 (model=qwen2.5-14b-instruct prompt_tokens=... completion_tokens=... answered=yes)
```

If it fails, the message says which step. The server log is `/root/one-ai/vllm.log`.

The script never prints the key and never passes it on a command line.

### 3. Note the endpoint

`https://<pod-id>-8888.proxy.runpod.net/v1`, where `<pod-id>` is shown in the RunPod console
(the pod's **Connect** → HTTP 8888 link, without any path, plus `/v1`).

### 4. Put the endpoint and key on the ONE server (once per key)

On the pod, show the key **only in your own terminal** to copy it:

```
cat /root/one-ai/api-key
```

On the ONE server (the AWS host), as the admin user, in the compose directory:

```
cd /srv/planthepath-next/deploy/vps        # wherever docker-compose.yml lives on the server
sudo nano .env
```

Set:

```
ONE_AI_BASE_URL=https://<pod-id>-8888.proxy.runpod.net/v1
ONE_AI_API_KEY=<paste the key>
ONE_AI_MODEL=qwen2.5-14b-instruct
```

Then apply and check (full procedure: `docs/ops/runbook-inference-endpoint.md`):

```
docker compose up -d api
docker compose exec -w /app/packages/persistence api node --import tsx src/run-ai-probe.ts
```

The probe prints `"configured":true,"reachable":true,"modelServed":true` and the same appears in
**Operations → AI Operations → Inference endpoint**. Never paste the key into a ticket, chat,
commit or incident note.

### 5. Keeping the same key across restarts (optional)

Because the pod's disk is wiped on stop, `setup-pod.sh` creates a **new** key on a fresh start. Either
copy the new key to the server each time (step 4), or before running the script recreate the old one:

```
mkdir -p /root/one-ai && (umask 077; nano /root/one-ai/api-key)   # paste the key the server already has
```

The script keeps an existing key file.

### 6. Rotating the key

On the pod: `rm /root/one-ai/api-key`, stop vLLM (`kill $(cat /root/one-ai/vllm.pid)`), run
`bash setup-pod.sh` again, then repeat step 4. The old key stops working as soon as vLLM restarts.

### 7. Switching the served model, and the bake-off (ENG-21)

`setup-pod.sh` serves `Qwen/Qwen2.5-14B-Instruct` unless told otherwise. `MODEL_REPO`,
`SERVED_MODEL_NAME` and, for quantised models, `VLLM_EXTRA_ARGS` (e.g. `--quantization awq_marlin`)
switch it; `MAX_MODEL_LEN` and `GPU_MEMORY_UTILIZATION` can be overridden too. Running the script with
a different model stops the one on port 8888 and starts the new one. ONE's server must then be given
the new `ONE_AI_MODEL`, and no feature runs on it until it has its own passing evaluation.

How to compare candidates with ONE's evaluation set, and record the result:
`deploy/ai-pod/bake-off/README.md`.

## What the script does not do

- It does not open any port other than 8888, does not expose JupyterLab (it stops it), and does not
  touch ONE's server or database.
- It does not switch any AI feature on. In ONE, every AI feature stays off until it has a passing
  evaluation and a second person's approval (AI Operations), and the global kill switch overrides all.
- No AI reaches a student until the privacy notice names the pod's US processing (HG-6).
