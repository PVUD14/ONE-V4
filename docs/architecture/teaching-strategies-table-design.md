# Teaching Strategies — Table Design

**Status:** Adopted (ENG-07), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0049_misconceptions_and_teaching_strategies.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Governance, provenance and `review_state`:** shared with `misconception_codes` — see
`misconception-codes-table-design.md`.

## Why this exists

The planner (ENG-08) outputs "one next action with strategy and reason codes". A strategy must be a
named, versioned, reviewed thing — so a decision can be replayed (C4) and so a person, not the code, owns
the claim that "a worked example suits a new skill". The plan names seven kinds: worked example, guided
practice, Socratic questioning, hint ladder, error correction, retrieval practice, teach-back.

## The table: `teaching_strategies`

One row = one **version** of one strategy.

| Column | Notes |
| --- | --- |
| `id` | uuid PK, also its revision's `entity_id`. |
| `code` | text NOT NULL, `^[A-Z][A-Z0-9_]{2,63}$`, e.g. `WORKED_EXAMPLE`. `UNIQUE (code, version)`. The planner records `code` and `version`. |
| `version` | integer NOT NULL, > 0. |
| `strategy_kind` | text NOT NULL, CHECK in (`WORKED_EXAMPLE`, `GUIDED_PRACTICE`, `SOCRATIC_QUESTIONING`, `HINT_LADDER`, `ERROR_CORRECTION`, `RETRIEVAL_PRACTICE`, `TEACH_BACK`). The closed vocabulary from the plan; several codes may share a kind (e.g. a faded and a full worked example). |
| `title` | text NOT NULL, 1–160. |
| `description` | text NOT NULL, 1–4000. What the strategy does, for staff and the planner's reason text. |
| `applicability` | jsonb NOT NULL, object. The rules below; validated by `validateStrategyApplicability` before insert, and CHECK `jsonb_typeof = 'object'`. |
| `requires_model` | boolean NOT NULL DEFAULT false. True where the strategy cannot be delivered without a model (Socratic questioning and teach-back evaluated by a tutor). **The planner must not choose a `requires_model` strategy while every AI flag is off** (X2) — a rule for ENG-08, recorded here so the data carries it. |
| `basis`, `expert_check_notes`, `source`, `generator_version`, `prompt_version`, `generated_at`, `review_state` | As in the shared design. |
| `content_revision_id` | uuid NOT NULL UNIQUE → `content_revisions(id)`, `entity_type = 'TEACHING_STRATEGY'`. |
| `created_by_user_id`, `created_at` | As in the shared design. |

## Applicability rules

A small, closed JSON shape — every key optional, an absent key means "no restriction":

```json
{
  "modes": ["LEARN", "PRACTICE", "REVIEW"],
  "evidenceStages": ["ESTIMATED", "RETAINED"],
  "triggers": ["NEW_SKILL", "REPEATED_ERROR", "MISCONCEPTION_DETECTED"],
  "misconceptionCodes": ["SUBNET_BOUNDARY_OFF_BY_ONE"],
  "minRecentErrors": 2,
  "maxHintLevel": 2
}
```

- `modes` — `learning_sessions.mode` values (ENG-03) where the strategy fits.
- `evidenceStages` — D.1 stages (ENG-04/05).
- `triggers` — `NEW_SKILL`, `REPEATED_ERROR`, `MISCONCEPTION_DETECTED`, `DUE_REVIEW`, `STUCK`,
  `NEAR_MASTERY`. The situation the planner is in; at least one must match when the key is present.
- `misconceptionCodes` — codes (not versions) this strategy addresses; matches if any is active.
- `minRecentErrors` / `maxHintLevel` — integer thresholds, 0–20 and 0–4.

`strategyApplies(rules, situation)` (pure, `packages/career-readiness`, `teaching-strategy-applicability-v1`)
evaluates the rules against a situation; it is deterministic and does not rank. **Ranking is ENG-08's
policy**, versioned there; putting weights here would split the planner's logic across content and code.

*Rejected: free-form rule text.* The planner could not evaluate it, and C4 replay needs deterministic
inputs. *Rejected: a rules table (one row per condition).* Seven strategies with a handful of conditions
each do not need relational rules; a validated object versioned with the strategy is simpler and is
reviewed as one unit.

## The draft pack

`data/engine/teaching-strategies-v1.draft.json` holds one draft for each of the seven kinds, written by the
agent under ENG-07. It is **model-produced content** (B.8): imported only as `DRAFT` with
`source = 'AGENT_DRAFTED'`, `generator_version`, `prompt_version` and `generated_at`; each entry cites its
basis (learning-science literature, named per entry) and lists in `expertCheckNotes` every claim a
learning-design expert must check. `importTeachingStrategyDraftPack` loads it as drafts under a named
importing user; nothing publishes it. It is never on a screen: no route reads drafts.

## Reading

`listPublishedTeachingStrategies(db)` returns only `PUBLISHED` versions. Until a person publishes some,
the planner has no strategies and must fall back to its non-strategy default and say so.
