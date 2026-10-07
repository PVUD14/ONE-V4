# Content Retrieval — Embeddings Table, Embedding Job and Tenant-Scoped Retrieval (ENG-24)

**Status:** Adopted (ENG-24). Recommended options taken per AGENTS.md ("ask once, recommend, carry on");
every decision records what was rejected. The one decision that needs Divakar — the database image — is
called out in Decision 1 and in ADR-050, and nothing in this step depends on it.
**Date:** 2026-10-08
**Migration:** `0114_content_embeddings.sql`
**ADR:** ADR-050 (vectors without pgvector for now; the embedding job is TypeScript)
**Rule:** Written before the migration, per the migrations rule in `CLAUDE.md`. The table decides what
approved content a model is shown on a student's behalf, and whose content that may be, so it is a table
with consequences.

## Why this exists

Program plan, ENG-24: "Enable pgvector; content_embeddings (content revision, chunk, embedding, model
version, tenant scope); an offline embedding job (jobs/embeddings); tenant-scoped retrieval for the tutor.
Acceptance: retrieval never returns another tenant's private content; embeddings rebuild from approved
content only."

The tutor (ENG-22) today grounds a hint only in the question and its published hint ladder. Retrieval lets
it also be shown the approved lesson text that teaches the skill — and only approved text, and only text
the student's tenant may see.

## What exists and what does not

- **Approved content** is a `content_revisions` row in state `PUBLISHED` under a `PUBLISHED` release
  manifest (0004). Published rows are immutable; the one change they take is `PUBLISHED → ARCHIVED`
  (0090), which archives *every* published revision of the item. A newer published revision of a base
  lesson sets `lesson_versions.superseded_at` on the old version (0065); a lesson variant has no
  `lesson_versions` row and is served as "the latest `PUBLISHED` revision of the variant" (ENG-16).
- **There is no tenant on content today.** Every content revision is platform content, authored and
  published by operators (OPS-09a/b/c). Nothing marks a revision as one institution's own.
- **pgvector is not available** in any database ONE runs: production and the demo use
  `postgres:16-alpine` (`deploy/vps/docker-compose.yml`), and the local development container is the same
  image — `pg_available_extensions` has no `vector` row (checked 2026-10-08).

## Decision 1: how vectors are stored — `real[]`, exact scan, no pgvector yet

**Chosen: the vector is a `real[]` column, unit-normalised on write, and retrieval is an exact
inner-product scan in SQL over the rows the tenant and approval filters leave.** No extension is created.

Why this is enough now: retrieval runs over *approved lessons* — tens to hundreds today, a few thousand
chunks at the plan's horizon — never over student data. An exact scan costs about 0.28 ms per 1,024-dimension
chunk ("Measured" below): a few hundred milliseconds for today's corpus, about 1.4 s at 5,000 chunks. That is
inside the tutor's 45-second pending window, runs in a worker rather than a request, and, unlike an
approximate index, can never miss the best passage.

**The upgrade path, when the corpus or the latency needs it.** A later migration (not this one) adds a
pgvector column cast from the same array — `embedding::vector(1024)` — with an HNSW index, partial on one
dimension count. The table, the job and the retrieval contract do not change; only the `ORDER BY` in
`retrieveApprovedContent` does. That migration needs pgvector in the image, which is Divakar's decision
(below). Triggers to take it: more than about 5,000 chunks of one model, or a measured retrieval p95 above
1 second.

**What Divakar must decide before pgvector can be used anywhere.** The production database runs
`postgres:16-alpine` (musl libc). The published `pgvector/pgvector:pg16` image is Debian (glibc). The two
libcs sort text differently under the same locale name: musl's `en_US.utf8` collates by code point, glibc's
linguistically. Starting the Debian image on the existing alpine data directory therefore leaves every
B-tree index on a collatable text column ordered by the old rule — lookups and `UNIQUE` checks can silently
miss rows until the indexes are rebuilt. Two safe ways, in order of preference:

1. **Keep alpine and add pgvector to it.** Same libc, same collation, no reindex. Recommended. Built and
   checked locally on 2026-10-08 (the image built, `CREATE EXTENSION vector` gave 0.8.0, and `real[]` casts to
   `vector`); the image was then deleted, and nothing was pushed or deployed:

   ```dockerfile
   FROM postgres:16-alpine
   RUN apk add --no-cache --virtual .pgvector-build git build-base     && git clone --branch v0.8.0 --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector     && cd /tmp/pgvector && make with_llvm=no OPTFLAGS="" && make with_llvm=no install     && cd / && rm -rf /tmp/pgvector && apk del .pgvector-build
   ```

   `with_llvm=no` skips the JIT bitcode, which needs a clang matching the image's LLVM; `OPTFLAGS=""` drops
   `-march=native`, so the binary does not depend on the build machine's CPU. Pin the `postgres:16-alpine`
   digest the server already runs, so the swap changes nothing but the added extension.
2. **Move to the Debian image by dump and restore**, never by reusing the data directory: `pg_dumpall`
   from the old container, a fresh volume for the new one, restore (which rebuilds every index under the new
   collation), then check the row counts. If the data directory is ever reused instead, the runbook is:
   stop the API and workers; start the new image; `REINDEX DATABASE <db>` (every database, including the
   sandbox's); look for duplicates that a misordered unique index admitted
   (`SELECT ... GROUP BY ... HAVING count(*) > 1` on each unique text key) before the reindex can succeed;
   `ALTER DATABASE <db> REFRESH COLLATION VERSION`; start the services.

Either way the change is a production data-safety operation run by hand, after a fresh verified backup.
This step changes no image and needs neither.

**Rejected:**

- *Create the extension only if it is available (a `DO` block in the migration).* Production, the demo and
  every test database would then have different schemas from the same migration, the ledger runner (ADR-035)
  would record it applied either way, and the tests would only ever exercise the path production does not
  run. A migration means one schema.
- *Require pgvector now.* It blocks the step on an image change with the collation risk above, for a corpus
  an exact scan handles.
- *A separate vector database or service.* A new always-on component on a one-person operation (ADR-034's
  rule), and a second place tenant scope would have to be enforced.
- *Vectors in `jsonb` or `bytea`.* No element type check, and every comparison would decode first.
- *Similarity in TypeScript after fetching candidates.* Moves megabytes of vectors per query out of the
  database to rank them; the SQL scan returns `k` rows.

## Decision 2: the tenant model — global content and institution-private content

**Chosen: a content revision carries `owner_institution_id` (0114, nullable, fixed at creation).** `NULL`
is platform content, visible to every learner; a value is that institution's private content. It must name
an organisation of kind `INSTITUTION`, and it never changes — not even on a draft — because a revision's
audience is part of what was reviewed. Every existing revision is `NULL`: today's content stays global and
nothing an editor does changes. No authoring path sets it yet; institution-authored content is a later
step, and the column exists now so that the embeddings table and retrieval enforce the rule from the start
instead of being retrofitted.

**A chunk inherits its scope from its revision, and the database checks it.** `content_embeddings` copies
`owner_institution_id` from the revision, and its insert trigger refuses a row whose value differs. The copy
is there so the retrieval filter is a column comparison on the table being scanned; it is never the only
check (Decision 4).

**Who may retrieve what.** The reader is a student. The reader's institutions are derived *in the query*
from their `ACTIVE` `institution_student_profiles` rows — never passed in by the caller, so a caller cannot
widen the scope. A chunk is retrievable by a reader when its revision is approved now (Decision 3) and
either it is global or its owner is one of the reader's active institutions. Consequences:

- institution A's private content is never returned to a student of B, nor to a student with no
  institution (who sees global content only);
- a student whose relationship with A ends stops seeing A's content on their next retrieval;
- a private chunk can never be served "as global": the filter compares the chunk's owner and the
  revision's owner, and a `NULL` owner on a chunk whose revision has an owner fails the trigger at insert.

**Rejected:**

- *Scope on the embeddings table only.* It would have no source of truth to inherit from; the table would be
  asserting a tenant nobody recorded.
- *A separate `content_revision_owners` table.* The same fact one join further away, and a revision could
  exist without it — "no row" would have to mean global, which is the unsafe default.
- *The caller passes the institution.* The tutor job has `tutor_hints.institution_id`, but that is the
  institution at request time and is the caller's claim. Deriving it at query time is both current and not
  forgeable.
- *Naming the column `institution_id`.* Everywhere else in the schema that name means "the institution the
  student belonged to when this row was written" (ADR-034), and the offboarding purge plan classifies tables
  by it. Here it means the content's owner, so it is named for that.

## Decision 3: what "approved" means — one view

**Chosen: a view, `content_retrieval_sources`, is the single definition**, used by the job to choose what to
embed, by the insert trigger to refuse anything else, and by retrieval at query time:

- entity type `LESSON` (base lessons and their language/level/style variants);
- revision state `PUBLISHED`, and its release manifest `PUBLISHED` (a rolled-back release withdraws it);
- the latest `PUBLISHED` revision of its entity (an older published revision is never current);
- for a base lesson, its `lesson_versions` row not superseded (archive and republish both set it).

**Questions are not embedded.** A question revision's body carries its options and, with them, the material
of its answer key and explanation. Retrieved into the tutor's context for a *different* question on the same
skill, it could hand the student that question's answer. Skills (`TOPIC`) carry a name and one line — too
little to be worth a vector. Both can be added later as new source kinds with their own review.

## Decision 4: withdrawal is immediate; the job only tidies

**Chosen: retrieval joins `content_retrieval_sources` on every query.** When a revision is archived, its
release rolled back, or a newer revision published, its chunks stop being retrievable in the same
transaction that changed the content — not at the next job run. The job deletes the orphaned rows later;
that is housekeeping, not the safety mechanism.

A newly published revision has no chunks until the job runs. Until then that lesson is simply absent from
retrieval (the old revision is already excluded): stale-but-safe, never stale text.

**Rejected:** *a trigger on `content_revisions` that deletes chunks on archive.* It would make the content
editor's transactions depend on the embeddings table, would not cover a rolled-back manifest or a superseded
lesson version, and still leaves retrieval trusting the table's contents. The live join covers every way
content stops being current, including ways added later, because they all change what the view returns.

## Decision 5: the table

`content_embeddings` — one row per chunk of an approved revision, per embedding model and recipe. A
**projection**: rebuildable from approved content at any time, never edited, deletable.

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `content_revision_id` | `uuid` FK `content_revisions` | must be in `content_retrieval_sources` at insert (trigger) |
| `entity_type` | `text` | `LESSON` only (CHECK) |
| `owner_institution_id` | `uuid` FK `organizations`, nullable | equals the revision's (trigger) |
| `tenant_scope` | `text` | `GLOBAL` iff owner is `NULL`, else `INSTITUTION` (CHECK) |
| `language` | `text` | one of the eleven lesson languages (CHECK) |
| `chunk_index` / `chunk_count` | `smallint` | `0 ≤ index < count ≤ 64` (CHECK) |
| `chunk_text` | `text` | 1–4,000 characters: exactly what was embedded |
| `chunk_hash` | `text` | SHA-256 hex of `chunk_text` |
| `source_content_hash` | `text` | the revision's `content_hash` (trigger) |
| `embedding` | `real[]` | one dimension, no NULL, no NaN or infinity, unit length ±2% (CHECK) |
| `dimensions` | `smallint` | `= cardinality(embedding)`, 8–4,096 (CHECK) |
| `embedding_model` | `text` | the model id the feature policy asked for (the endpoint is held to it) |
| `embedding_version` | `text` | the recipe, `content-embedding@1` (CHECK on shape) |
| `source` | `text` | `AI_GENERATED` (CHECK) |
| `generator_version` | `text` | the orchestrator and adapter that produced it |
| `prompt_version` | `text` | equals `embedding_version` (CHECK): the recipe is the "prompt" of an embedding |
| `generated_at` | `timestamptz` | when the endpoint answered |
| `created_at` | `timestamptz` | database clock |

`UNIQUE (content_revision_id, embedding_model, embedding_version, chunk_index)` makes the job idempotent
(`ON CONFLICT DO NOTHING`). Indexes: the retrieval filter `(embedding_model, embedding_version, dimensions,
language)` and `(content_revision_id)` for pruning. Updates are refused by trigger; deletes are allowed.

**Provenance, and the one rule that does not fit.** CLAUDE.md asks every model output to be stored with
`source`, `generator_version`, `prompt_version`, `review_state` and `generated_at`, landing as `DRAFT` for a
human to publish. The row carries the first four and `generated_at`. It carries **no `review_state`**: a
vector is never shown to anyone and cannot be read or reviewed by a person. What a person reviewed is the
source text — it is in this table only because it is `PUBLISHED` — and whatever the tutor writes from it is
still guarded and stored as `DRAFT` by ENG-22. A `DRAFT` stamp on rows that are used would be untrue, and a
`DRAFT` stamp on rows that are not used would make the feature inert. ADR-050 records this as an explicit,
narrow reading of the rule for derived indexes, for Divakar to confirm.

**Privacy.** No person's data: content text and vectors only. The tutor's query text is embedded and
discarded, never stored; the metering row (`ai_generations`) carries the student's id as every tutor call
does. No export or deletion section is needed. Institution-private chunks will need an entry in the
offboarding purge plan when institution-authored content exists (follow-up; there is none to purge today).

## Decision 6: model and recipe versions

A vector is only comparable with vectors from the same model, the same recipe (chunking and any input
prefix) and the same dimension count. So:

- every row records `embedding_model`, `embedding_version` and `dimensions`;
- retrieval embeds the query with the model of the `tutor.retrieval` policy and compares only with rows of
  that model, the current recipe and the query's dimension count. A mismatch — the job's model changed and
  it has not re-run, or the two policies name different models — returns **no passages, with the reason
  `NO_INDEX_FOR_MODEL`**, never a comparison across models;
- the job prunes rows of any other model or recipe, then embeds whatever approved revision lacks rows for
  the current one. A model change is therefore: change the policy's model (which switches it off until an
  evaluation for the new model passes, 0089), run the job;
- **rebuild mode** deletes every row and re-embeds from `content_retrieval_sources`. It is how "embeddings
  rebuild from approved content only" is demonstrated, and the recovery for anything doubtful.

The recipe (`content-embedding@1`: lesson title, then up to 1,200 characters of paragraph-packed lesson
text per chunk, at most 64 chunks per revision, no input prefix) lives in code next to the prompts. Changing
any of it is a new version, and the job re-embeds everything.

## Decision 7: the embedding capability and the job

**Through ONE AI Orchestration only.** The provider-agnostic package gains an embedding capability:
`OpenAICompatibleProvider.embed` (POST `/embeddings`, same timeout, retry and no-leak rules as chat) and
`AiOrchestrator.embed`, which applies the same order of checks as `generate` — kill switch, the feature's
switch, its cap, the input size — and meters every call, refusal and failure into `ai_generations`. The
endpoint comes from `ONE_AI_EMBEDDING_BASE_URL`, `ONE_AI_EMBEDDING_API_KEY` and `ONE_AI_EMBEDDING_MODEL`,
all or nothing; blank is "unavailable". Separate variables because a vLLM server serves one model, so the
embedding model is a second endpoint (or a second port on the pod).

**Two features, each default off with its own cap**, registered (off) by `ai:register-features`:

| Feature | Used by | Cap (default) | Input limit |
| --- | --- | --- | --- |
| `content.embeddings` | the offline job, one call per revision | 2,000 calls a day | 80,000 characters |
| `tutor.retrieval` | the tutor's retrieval, one call per query | 1,000 calls a day | 2,000 characters |

Both run the recipe `content-embedding@1`, so switching either on needs a passing `ai_evaluations` record for
its model and that recipe (0089). For embeddings the evaluation is a retrieval benchmark (recall of the
right lesson for a set of practice questions) — the set is a follow-up; until it exists neither can be
switched on, which is the intended state. The default model id is `embedding-model-not-chosen`: no
embedding model has been chosen, and an endpoint serving any real model refuses a call naming it.

**The job** (`ai:content-embeddings`, TypeScript, in `packages/persistence`): read the policy and the
endpoint configuration — off or unconfigured means do nothing and say so in one log line; prune; select
approved revisions without rows for the current model and recipe; chunk; one orchestrated call per revision;
write that revision's rows in one statement (all or none). A cap, a kill switch, a switch-off or a provider
failure stops the run with its reason; the next run resumes. `--rebuild` starts from an empty index. A
systemd timer runs it nightly; installing it is Divakar's step. Why TypeScript rather than ADR-034's Python
`jobs/embeddings`: ADR-050.

## Decision 8: retrieval for the tutor — a seam, not yet wired

`retrieveApprovedContent` (in `packages/persistence/src/content-retrieval.ts`, worker-only like
`ai-workers.ts`; the API boundary test forbids `apps/` from importing it) takes the student, the query text
and the languages wanted (the hint's language, then English), embeds the query through `tutor.retrieval`, and
returns at most 3 passages (at most 3,000 characters in all) with their revision ids and scores — or
`UNAVAILABLE` with a reason (`QUERY_EMPTY`, `FEATURE_DISABLED`, `CAP_REACHED`, `INPUT_TOO_LARGE`,
`ENDPOINT_UNCONFIGURED`, `PROVIDER_FAILED`, `NO_INDEX_FOR_MODEL`). It never throws for an AI reason, so a caller's fallback is the existing human path.

**It is not wired into the tutor hint job.** Putting passages in front of the model means a new prompt
version (`tutor-hint@3`, with a `retrievedContent` parameter), and a new prompt version needs a new bake-off
run and a passing evaluation before it may be switched on (0089) — wiring it now would switch `tutor.hint`
off in every environment that has it on. The seam: when ENG-25 takes the tutor further, the hint job calls
`retrieveApprovedContent` before building the brief (only for a student with `ai-tutoring` consent, which the
job already checks), and passes the passages to `tutor-hint@3`.

## Measured

2026-10-08, local development container (`postgres:16-alpine`, Docker on Windows), the retrieval query exactly
as `retrieveApprovedContent` issues it — approval view, owner check and student scope included — over 100
published lessons x 50 chunks = **5,000 chunks of random 1,024-dimension unit vectors**: **1.39 s** execution
(`EXPLAIN ANALYZE`, one run, warm cache). The scoring subquery is almost all of it; the joins and filters are
index lookups. Cost is linear in chunks x dimensions, so 500 chunks is about 0.14 s, and a 384-dimension model
costs a little over a third of the 1,024-dimension figure. Writing the 5,000 rows took about 1.4 s. The script
was a throwaway run in a rolled-back transaction; it is not in the repository.

## Acceptance, and where it is proved

`packages/persistence/test/content-retrieval.integration.test.ts`, against the real database, with a
deterministic fake embedding provider:

- institution A's private lesson is returned to A's student and never to B's student or to a student with no
  institution; a chunk cannot be inserted with a scope different from its revision's;
- draft, in-review, approved-but-unpublished, unreleased and superseded revisions are never embedded, and the
  database refuses a direct insert for one;
- archiving a revision, or rolling back its release, removes its chunks from retrieval before the job runs
  again; publishing a newer revision does the same for the older one;
- rebuild mode deletes everything and re-creates exactly the rows for approved content;
- a model or recipe mismatch returns `NO_INDEX_FOR_MODEL`, and the job replaces the old model's rows;
- the job does nothing, and says so, when the endpoint is unconfigured or the feature is off.

## Follow-ups

1. Divakar: the database image (Decision 1) when the corpus or latency calls for pgvector.
2. A retrieval evaluation set and an embedding model choice for the pod; then evaluations for
   `content.embeddings` and `tutor.retrieval`.
3. `tutor-hint@3` with retrieved passages, its bake-off, and the wiring in the hint job (ENG-25).
4. Institution-authored content: the authoring path that sets `owner_institution_id`, and its entry in the
   offboarding purge plan (for `content_embeddings` too).
