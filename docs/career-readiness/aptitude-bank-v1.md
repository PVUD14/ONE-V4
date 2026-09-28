# Aptitude Skill Map and Item Bank v1 (DRAFT, for subject-expert review)

**What this is.** The reasoning and sources behind the shared aptitude block written for ENG-10: 25 skills
(quantitative, logical, verbal) with four level descriptors and prerequisites, 69 misconception codes, and 300
multiple-choice items, each with an answer key, an explanation, a difficulty band, a four-step hint ladder and at least
one misconception-tagged distractor. The data is `data/engine/aptitude-bank-v1.draft.json`, built from
`packages/persistence/src/aptitude-bank-content/` and imported through `db:import:aptitude-bank-draft`. Design:
`docs/architecture/aptitude-item-bank-design.md`.

**Status.** Model-produced content (program Part B.8). The coding agent wrote it by hand from the public syllabi below;
the product made no model call. **Nothing here is reviewed.** Every skill, code and item carries an `expertCheck` note;
a subject expert checks it, a person submits it, a second person reviews and approves it, and a publish needs a third
check and an approval. No student sees any of it until then.

**What it does not claim.** Difficulty bands (`FOUNDATION`, `INTERMEDIATE`, `ADVANCED`) are the agent's judgement, not
measured difficulty — that is ENG-13's calibration. Levels are descriptions of what a learner can do, never scores.
Nothing here computes or shows a readiness value (ADR-020). Word-problem and table figures are illustrative and describe
no real person, shop, museum, library or place.

## Sources

1. **Staff Selection Commission — Combined Graduate Level Examination notice**, scheme of examination and Tier-I
   syllabus: General Intelligence and Reasoning; Quantitative Aptitude; English Comprehension. <https://ssc.gov.in>
   (Notices). Used for the topic list of all three areas.
2. **UPSC — Civil Services (Preliminary) Examination, General Studies Paper II syllabus**: comprehension; logical
   reasoning and analytical ability; general mental ability; basic numeracy (numbers and their relations, orders of
   magnitude) and data interpretation (charts, graphs, tables, data sufficiency) at Class X level. <https://upsc.gov.in>.
   Used to cross-check the areas and to pitch the level.
3. **NCERT Mathematics textbooks, Classes VII, VIII and X** (comparing quantities; Real Numbers; Pair of Linear
   Equations in Two Variables; Probability). <https://ncert.nic.in/textbook.php>. Used for the school level and the
   standard method each quantitative item uses. NCERT has been issuing new textbooks since 2024; the reviewer confirms
   chapter names against the current editions.

A syllabus is a list of topics. Using it to decide what to cover copies no expression. **Every item, passage, hint,
explanation, level descriptor and misconception description is original wording**; no item is taken or adapted from a
question bank, previous-year paper, coaching book or website. Licence on every record: `AI8HT-Owned` (no attribution
required because nothing is reproduced); the reviewer confirms it at approval with `OWNERSHIP_VERIFIED`.

## The skill map

| Area | Skill | Name | Prerequisites | Items | Misconception codes |
| --- | --- | --- | --- | --- | --- |
| Q | `apt-q-number-properties` | Number properties: factors, HCF and LCM | — | 12 | APT_Q_HCF_LCM_SWAP, APT_Q_LCM_AS_PRODUCT, APT_Q_HCF_ANY_COMMON_FACTOR |
| Q | `apt-q-arithmetic-operations` | Arithmetic: order of operations, fractions and decimals | — | 12 | APT_Q_LEFT_TO_RIGHT_ORDER, APT_Q_FRACTION_ADD_ACROSS, APT_Q_DECIMAL_PLACE_SHIFT |
| Q | `apt-q-percentages` | Percentages | arithmetic | 12 | APT_Q_PCT_WRONG_BASE, APT_Q_PCT_SUCCESSIVE_ADDED |
| Q | `apt-q-ratio-proportion` | Ratio and proportion | arithmetic | 12 | APT_Q_RATIO_PART_AS_WHOLE, APT_Q_RATIO_INVERSE_AS_DIRECT, APT_Q_RATIO_ADDITIVE_REASONING |
| Q | `apt-q-averages` | Averages | arithmetic | 12 | APT_Q_AVG_UNWEIGHTED, APT_Q_AVG_WRONG_COUNT |
| Q | `apt-q-profit-loss-discount` | Profit, loss and discount | percentages | 12 | APT_Q_PL_PROFIT_ON_SP, APT_Q_PL_PERCENTS_ADDED |
| Q | `apt-q-interest` | Simple and compound interest | percentages | 12 | APT_Q_CI_AS_SI, APT_Q_SI_TIME_UNITS, APT_Q_INTEREST_VS_AMOUNT |
| Q | `apt-q-time-work` | Time and work | ratio | 12 | APT_Q_TW_COMBINES_TIMES, APT_Q_TW_AVERAGES_TIMES, APT_Q_TW_OUTFLOW_AS_INFLOW |
| Q | `apt-q-time-speed-distance` | Time, speed and distance | ratio | 12 | APT_Q_TSD_AVERAGE_OF_SPEEDS, APT_Q_TSD_UNIT_CONVERSION, APT_Q_TSD_IGNORES_LENGTH |
| Q | `apt-q-mixtures-alligation` | Mixtures and alligation | averages, ratio | 12 | APT_Q_MIX_SIMPLE_AVERAGE, APT_Q_MIX_RATIO_REVERSED, APT_Q_MIX_REPLACEMENT_LINEAR |
| Q | `apt-q-linear-equations` | Linear equations and word problems | arithmetic | 12 | APT_Q_ALG_SIGN_ON_TRANSPOSE, APT_Q_ALG_INCOMPLETE_INVERSE, APT_Q_ALG_DIVIDE_ONE_TERM, APT_Q_ALG_WRONG_QUANTITY |
| Q | `apt-q-data-interpretation` | Data interpretation | percentages, averages | 12 | APT_Q_DI_CHANGE_ON_LATER_VALUE, APT_Q_DI_ABSOLUTE_VS_RELATIVE, APT_Q_DI_LEVEL_VS_CHANGE |
| Q | `apt-q-counting-probability` | Counting and basic probability | number properties, arithmetic | 12 | APT_Q_PROB_ORDER_COUNTED, APT_Q_PROB_ADDS_INDEPENDENT, APT_Q_PROB_UNEQUAL_OUTCOMES |
| L | `apt-l-series` | Number and letter series | arithmetic | 12 | APT_L_SERIES_REPEATS_LAST_STEP, APT_L_SERIES_POSITION_OFF_BY_ONE |
| L | `apt-l-coding-decoding` | Coding and decoding | — | 12 | APT_L_CODE_SHIFT_DIRECTION, APT_L_CODE_POSITION_MISCOUNT |
| L | `apt-l-blood-relations` | Family relationships | — | 12 | APT_L_REL_GENERATION_SKIP, APT_L_REL_GENDER_ASSUMED, APT_L_REL_IGNORES_ONLY |
| L | `apt-l-direction-sense` | Direction sense | — | 12 | APT_L_DIR_TURN_REFERENCE, APT_L_DIR_PATH_AS_DISTANCE |
| L | `apt-l-syllogisms` | Syllogisms | — | 12 | APT_L_SYL_CONVERSE, APT_L_SYL_SOME_NOT_ASSUMED, APT_L_SYL_UNLINKED_TERMS, APT_L_SYL_OUTSIDE_KNOWLEDGE |
| L | `apt-l-ordering-ranking` | Ordering and ranking | — | 12 | APT_L_RANK_OFF_BY_ONE, APT_L_ORDER_DIRECTION_FLIP |
| L | `apt-l-analogy-classification` | Analogies and classification | vocabulary | 12 | APT_L_ANALOGY_SURFACE_FEATURE |
| V | `apt-v-vocabulary` | Vocabulary: synonyms and antonyms | — | 12 | APT_V_VOCAB_OPPOSITE_CHOSEN, APT_V_VOCAB_SOUND_ALIKE |
| V | `apt-v-grammar` | Grammar: agreement, tense, articles and prepositions | — | 12 | APT_V_GRAM_AGREEMENT, APT_V_GRAM_TENSE, APT_V_GRAM_PREPOSITION, APT_V_GRAM_ARTICLE_BY_SPELLING |
| V | `apt-v-sentence-completion` | Sentence completion | vocabulary, grammar | 12 | APT_V_FILL_CLUE_MISSED, APT_V_FILL_WORD_CONFUSION, APT_V_FILL_COLLOCATION |
| V | `apt-v-reading-comprehension` | Reading comprehension | vocabulary | 12 | APT_V_RC_OUTSIDE_KNOWLEDGE, APT_V_RC_OVERSTATED, APT_V_RC_DETAIL_AS_MAIN_IDEA, APT_V_RC_CHANGED_DETAIL, APT_V_RC_LITERAL_SENSE |
| V | `apt-v-idioms` | Idioms and phrases | vocabulary | 12 | APT_V_IDIOM_LITERAL, APT_V_IDIOM_OPPOSITE_SENSE |

Totals: 156 quantitative, 84 logical and 60 verbal items; 135 FOUNDATION, 123 INTERMEDIATE, 42 ADVANCED; 469 of 900
distractors tagged, every item at least one (`aptitude:validate` prints the current counts).

## How the items were written

- **Quantitative** items come from three templates per skill with four rows of numbers each. The template holds the
  method and the hint ladder; the answer, each distractor and the worked hint step are computed from the numbers. Each
  tagged distractor is the named misconception applied to the same numbers (for example, the product of two numbers as
  their LCM), so the tag is true by construction. Numbers are chosen so every option is a clean value.
- **Coding, direction and ranking** items are computed the same way (the code applied letter by letter, the walk
  traced turn by turn).
- **Series, family relationships, syllogisms, analogies and every verbal item** are written out one by one, with a
  worked hint step and a near-solution hint of their own.
- The **hint ladder** follows the question bank's levels: 1 points at the idea, 2 names the method, 3 does the first
  step, 4 does everything short of choosing. Levels 3 and 4 mark an attempt assisted (ENG-04).

## Decisions taken (recommended answers adopted, per AGENTS.md)

1. **About 300 items: exactly 300, twelve per skill.** Even coverage lets the placement test (ENG-14) sample every
   skill; ENG-13 calibration will show which skills need more.
2. **Four options per item.** The editor allows two to six; four is the convention of the syllabi's examinations.
3. **Syllogism convention.** "Some" means at least one, and "all A are B" lets "some B are A" follow (existence
   assumed). Stated in the syllogism skill's expert note; the reviewer confirms it is what learners are taught.
4. **Standard written English** for grammar items; the two items where Indian English usage differs ("good in",
   "neither … nor" agreement) say so in their expert notes.
5. **Analogy and classification** has one misconception code (surface features); a second code would be invented to
   fill a slot.

## What the subject expert checks

Every record's `expertCheck`. For every item: the answer key is correct and the only defensible option; each tagged
distractor really shows the named misconception; hints 1–2 do not give the answer away. For every code: that it is a
real, common error at this level and is named as a teacher would name it. For every skill: its level descriptors and
prerequisites.
