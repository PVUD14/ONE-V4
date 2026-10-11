# ADR-050 — Retrieval over approved content: vectors as arrays until the image carries pgvector, and a TypeScript embedding job

Records how ENG-24 stores and searches embeddings without changing the production database image, and
why its offline job is TypeScript where ADR-034 expected Python.

- **Status:** Accepted — 2026-10-08. Proposed with a recommendation and carried on per the repository's
  "ask once, recommend, carry on" rule. Decision 1's image question is Divakar's and is not taken here.
- **Context:** ADR-034 (§5: Python offline, "and, gated by HG-2, `jobs/embeddings`"), ADR-047 (inference
  on a RunPod pod through `packages/ai-orchestration`), ADR-035 (migration ledger), CLAUDE.md's AI rules.
  Design: `docs/architecture/content-retrieval-design.md`.
- **Amends:** ADR-034 §5, for the embedding job only. ADR-034 is not otherwise changed.

## Decision

1. **No pgvector in this step.** `content_embeddings.embedding` is a unit-normalised `real[]`; retrieval
   is an exact inner-product scan in SQL after the approval and tenant filters. Migration 0114 creates no
   extension and runs on the `postgres:16-alpine` image that production, the demo and development use.
2. **The upgrade is a later migration plus an image Divakar chooses.** When the corpus passes about 5,000
   chunks of one model, or retrieval's p95 passes 1 second (measured: 1.39 s for 5,000 chunks of 1,024
   dimensions on the development container), a new migration adds a `vector` column cast from the array with
   an HNSW index. The table, the job and the retrieval contract stay as they are.
3. **The recommended image is alpine with pgvector compiled in**, not the Debian `pgvector/pgvector:pg16`
   image. Same musl libc, so text collation and every existing index are unchanged. Moving to a glibc image
   is acceptable only by dump and restore (or, if the data directory is reused, `REINDEX DATABASE` on every
   database, a duplicate check on unique text keys, and `ALTER DATABASE … REFRESH COLLATION VERSION`), after
   a verified backup, by hand. The runbook is in the design document, Decision 1.
4. **The embedding job is TypeScript** (`ai:content-embeddings` in `packages/persistence`, run by a systemd
   timer), not Python under `jobs/embeddings`.
5. **Embeddings carry provenance but no review state.** Each row records `source`, `generator_version`,
   `prompt_version` (the embedding recipe) and `generated_at`. It is not `DRAFT` for a person to publish: a
   vector cannot be read or reviewed, the text it indexes is already human-published content (the database
   refuses anything else), and the tutor output that uses it is still guarded and stored as `DRAFT`. This
   reading applies to derived indexes of published content only, never to generated text.

## Why TypeScript, against ADR-034 §5

ADR-034 put offline work in Python for one reason: the fitting libraries (`py-irt`, `girth`) are Python, and
the API should never wait for them. An embedding job fits nothing. It reads approved rows, splits text,
makes HTTP calls to an inference endpoint and writes rows. The deciding rule is CLAUDE.md's "everything goes
through ONE AI Orchestration": the kill switch, each feature's switch and cap, the evaluation gate, metering
and the no-leak error handling all live in `packages/ai-orchestration`. A Python job would be a second
inference client that either re-implements every one of those or skips them. The job still keeps ADR-034's
other constraints: it is a batch command under a timer, nothing in the request path calls it or waits for
it, and it writes only its own table (and the metering rows every AI call writes).

## Rejected

- **Creating the extension only where it is available.** One migration, two schemas; tests would cover only
  the path production does not run; the ledger would record it applied either way.
- **Switching production to `pgvector/pgvector:pg16` now.** A libc change under an existing data directory
  can leave text indexes misordered — silent missed lookups and missed unique violations — and that is a
  production data-safety decision for Divakar, not a side effect of a feature.
- **A vector database or a retrieval service.** A new always-on component for a corpus an exact scan
  handles, and a second place tenant scope would have to be enforced.
- **A Python `jobs/embeddings` calling the endpoint directly.** Bypasses orchestration (above).
- **Marking embeddings `DRAFT` until someone publishes them.** Either untrue (used while `DRAFT`) or inert
  (never used); nobody can review a vector.

## Consequences

- ENG-24 ships without touching `deploy/vps/docker-compose.yml` or any server.
- Retrieval quality is exact; its cost grows linearly with chunks of one model, which is what the upgrade
  trigger watches.
- Two AI features exist, `content.embeddings` and `tutor.retrieval`, both off, both needing a passing
  evaluation for their model and `content-embedding@1` before they can be switched on. No embedding model is
  chosen or served yet.
