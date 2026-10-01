# Bake-off human review rubric (template)

What this is: the scale a person uses to score the review sheet that `bake-off:review-sheet` writes for
one bake-off run. Why it exists: ONE's automatic checks can tell whether a hint gives the answer away
or is in the right script, not whether it teaches anything or reads naturally. A PASS for
`tutor.hint` or `content.lesson-draft` is recorded only with a completed sheet
(`docs/architecture/ai-bake-off-design.md`, Decision 4).

**Who scores:** a person — Divakar or a faculty reviewer. Telugu and Hindi items need someone who
reads the language. A model, or the agent that ran the bake-off, never fills in a sheet.
**What not to write:** no names, no personal data, no comments in the sheet. Scores only.

For every item, fill in `scores`:

| Field | Values |
| --- | --- |
| `teaching` | 1–5, below |
| `language` | 1–5 for Telugu and Hindi items, below; leave `"NA"` for English items |
| `factualError` | `true` if the reply states anything factually or mathematically wrong, even if minor; else `false` |

## Teaching quality (`teaching`)

For a **tutor hint**, judge against the level the item's category names (`HINT_L1` … `HINT_L4`):
1 nudge — the idea that matters; 2 strategy — the method; 3 worked step — the first step only;
4 near solution — everything short of choosing the answer.

| Score | Tutor hint | Lesson draft |
| --- | --- | --- |
| 5 | Exactly the requested level, specific to this question, and a student would know what to do next | Accurate, well ordered, the worked example teaches the method, the common mistakes are the real ones |
| 4 | Right level and helpful; small wording or focus issues | Accurate and usable after light editing |
| 3 | Helpful but generic, or a level off (too vague or too far) | Usable after real editing: thin example, or generic mistakes |
| 2 | Barely helpful, or confusing | Major gaps or poor structure; would need rewriting |
| 1 | Useless, misleading, or gives the answer away | Wrong, off-topic, or unusable |

A reply that gives the answer away scores 1 even if the automatic check missed it.

## Language quality (`language`, Telugu and Hindi only)

| Score | Meaning |
| --- | --- |
| 5 | Natural and fluent; a student would read it as written by a fluent speaker |
| 4 | Clear and correct; slightly formal or literal |
| 3 | Understandable, with awkward phrasing or a few errors |
| 2 | Hard to follow; frequent errors or mixed-up script |
| 1 | Not usable in this language |

English terms, numbers and option text kept in Latin script are expected and are not errors.

## Thresholds a PASS needs (recorded with the result)

| Feature | Reviewed items | Mean teaching | Mean language | Factual-error rate |
| --- | --- | --- | --- | --- |
| `tutor.hint` | ≥ 30 | ≥ 3.5 | ≥ 3.5 | ≤ 5 % |
| `content.lesson-draft` | ≥ 15 | ≥ 3.5 | ≥ 3.5 | ≤ 10 % |
