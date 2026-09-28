/**
 * The aptitude skill map (ENG-10): 25 skills in three areas, their four level descriptors, their
 * prerequisites, the misconception codes their items tag, and the public sources they rest on.
 *
 * Why this exists: the shared aptitude block is what every ONE student meets whatever role they
 * choose. The skill list follows public examination syllabi (the sources below); every
 * descriptor, code and item is written for this pack by the coding agent, by hand, and is a
 * DRAFT for a subject expert to check (program B.8). Levels are descriptions of what a learner can
 * do — never numbers, never readiness.
 */
import type { AptitudeArea, AptitudeMisconception, AptitudeSkill, AptitudeSource } from '../aptitude-bank.js';
import type { SkillAuthoring } from './author.js';

export const SOURCES: readonly AptitudeSource[] = [
  {
    id: 'SSC-CGL',
    title: 'Combined Graduate Level Examination — notice of examination: scheme of examination and syllabus (Tier-I: General Intelligence and Reasoning; Quantitative Aptitude; English Comprehension)',
    publisher: 'Staff Selection Commission, Government of India',
    reference: 'https://ssc.gov.in (Notices, Combined Graduate Level Examination). The reviewer confirms the current year\'s notice and its topic list.',
    usedFor: 'The quantitative topics (computation, percentage, ratio and proportion, averages, interest, profit and loss, discount, mixture and alligation, time and distance, time and work, basic algebra, data interpretation), the reasoning topics (series, coding-decoding, relationships, direction, syllogistic reasoning, arrangement, analogy and classification) and the English topics (synonyms and antonyms, spotting errors, fill in the blanks, idioms and phrases, comprehension).',
  },
  {
    id: 'UPSC-CSAT',
    title: 'Civil Services (Preliminary) Examination — General Studies Paper II syllabus',
    publisher: 'Union Public Service Commission',
    reference: 'https://upsc.gov.in, examination notice, scheme and syllabus of the preliminary examination. The reviewer confirms the current notice.',
    usedFor: 'Cross-check of the three areas and their level: comprehension; logical reasoning and analytical ability; general mental ability; basic numeracy (numbers and their relations, orders of magnitude) and data interpretation (charts, graphs, tables, data sufficiency) at Class X level.',
  },
  {
    id: 'NCERT-MATHS',
    title: 'Mathematics textbooks for Classes VII, VIII and X',
    publisher: 'National Council of Educational Research and Training (NCERT)',
    reference: 'https://ncert.nic.in/textbook.php — Class VII and VIII chapters on comparing quantities (ratio, percentage, profit and loss, discount, simple and compound interest); Class X chapters Real Numbers (HCF and LCM), Pair of Linear Equations in Two Variables, and Probability. NCERT has been issuing new textbooks since 2024; the reviewer confirms chapter names against the current editions.',
    usedFor: 'The school level the quantitative skills are pitched at, and the standard method each item uses.',
  },
];

export const SOURCE_BASIS =
  'Skill list and level: SSC Combined Graduate Level Examination syllabus (Tier-I reasoning, quantitative aptitude and English comprehension topics), cross-checked with the UPSC Civil Services (Preliminary) General Studies Paper II syllabus and the NCERT mathematics textbooks for Classes VII, VIII and X. The syllabi are topic lists; every descriptor, misconception code, item, hint and explanation in this pack is original wording by the coding agent, and no item is taken or adapted from any question bank, previous-year paper, coaching book or website. Levels, prerequisites, difficulty bands and misconception codes are the agent\'s proposal for subject-expert review.';

interface SkillDef {
  readonly key: string;
  readonly area: AptitudeArea;
  readonly name: string;
  readonly description: string;
  readonly levels: readonly [string, string, string, string];
  readonly prerequisites: readonly string[];
  /** Which syllabus line(s) the skill rests on. */
  readonly basis: string;
  readonly expertCheck: string;
}

const Q = 'QUANTITATIVE';
const L = 'LOGICAL';
const V = 'VERBAL';

const SSC_Q = 'SSC CGL Tier-I, Quantitative Aptitude';
const SSC_R = 'SSC CGL Tier-I, General Intelligence and Reasoning';
const SSC_E = 'SSC CGL Tier-I, English Comprehension';

const SKILL_DEFS: readonly SkillDef[] = [
  {
    key: 'apt-q-number-properties', area: Q, name: 'Number properties: factors, HCF and LCM',
    description: 'Factors and multiples, highest common factor and least common multiple, and problems where events repeat on different cycles.',
    levels: [
      'Knows what a factor, a multiple, the HCF and the LCM are, and which one a question about "sharing equally" or "happening together again" needs.',
      'Finds the HCF and LCM of two small numbers by listing multiples or by prime factors, following a worked example.',
      'Finds the HCF and LCM of two or three numbers by prime factorisation and applies them to repeat-cycle word problems unaided.',
      'Spots when an answer is the HCF where the LCM was needed (or the product of the numbers), and checks the result divides or is divided by each number.',
    ],
    prerequisites: [],
    basis: `${SSC_Q}: "computation of whole numbers … relationships between numbers"; UPSC GS Paper II "basic numeracy (numbers and their relations)"; NCERT Class X, Real Numbers (HCF and LCM by prime factorisation).`,
    expertCheck: 'Check the HCF/LCM scope is right for the aptitude block, and whether remainders and divisibility tests deserve their own skill.',
  },
  {
    key: 'apt-q-arithmetic-operations', area: Q, name: 'Arithmetic: order of operations, fractions and decimals',
    description: 'The order of operations, adding and simplifying fractions, and multiplying decimals.',
    levels: [
      'Knows that multiplication and division come before addition and subtraction, and that fractions need a common denominator to be added.',
      'Simplifies a short expression and adds two fractions with a written checklist of the steps.',
      'Evaluates expressions, adds and simplifies fractions and multiplies decimals accurately without help.',
      'Finds the step where a wrong result went astray — left-to-right evaluation, adding across fractions, a misplaced decimal point — and corrects it by estimation.',
    ],
    prerequisites: [],
    basis: `${SSC_Q}: "computation of whole numbers, decimals, fractions"; UPSC GS Paper II "basic numeracy".`,
    expertCheck: 'Check whether BODMAS/order-of-operations is pitched at the right level for graduates, or should sit as a foundation-only skill.',
  },
  {
    key: 'apt-q-percentages', area: Q, name: 'Percentages',
    description: 'Percentage of a quantity, percentage change, reversing a percentage change, and successive changes.',
    levels: [
      'Knows that a percentage is a part per hundred and that a percentage change is measured against the original value.',
      'Works out a percentage change and a successive change with a written method (multiplying factors).',
      'Reverses a percentage change and compares two quantities in percentage terms unaided.',
      'Detects when the wrong base was used or successive changes were added, and checks answers by applying the change forwards.',
    ],
    prerequisites: ['apt-q-arithmetic-operations'],
    basis: `${SSC_Q}: "percentage"; NCERT Classes VII and VIII, comparing quantities.`,
    expertCheck: 'Check the "percentage of what" framing of each level is clear to a learner.',
  },
  {
    key: 'apt-q-ratio-proportion', area: Q, name: 'Ratio and proportion',
    description: 'Parts of a whole in a given ratio, direct and inverse proportion, and solving a proportion for an unknown.',
    levels: [
      'Knows that a ratio compares parts, that the parts add to the whole, and the difference between direct and inverse proportion.',
      'Finds a whole or a part from a ratio and solves a proportion with a worked example alongside.',
      'Decides whether a situation is direct or inverse proportion and solves it unaided.',
      'Recognises additive reasoning ("add the same amount") where multiplicative reasoning is needed, and checks that the ratio still holds.',
    ],
    prerequisites: ['apt-q-arithmetic-operations'],
    basis: `${SSC_Q}: "ratio and proportion"; NCERT Class VII, comparing quantities (ratio and proportion).`,
    expertCheck: 'Check that inverse proportion (workers and days) belongs here rather than only in time and work.',
  },
  {
    key: 'apt-q-averages', area: Q, name: 'Averages',
    description: 'The mean of a list, combined (weighted) averages of two groups, and how the mean changes when a value is removed.',
    levels: [
      'Knows that the mean is the total divided by the count and that it differs from the median.',
      'Finds a mean and a combined mean of two groups with a written total-then-divide method.',
      'Solves average problems where the count changes or groups are combined, unaided.',
      'Spots an unweighted average of averages or a divide-by-the-old-count error, and checks with totals.',
    ],
    prerequisites: ['apt-q-arithmetic-operations'],
    basis: `${SSC_Q}: "averages".`,
    expertCheck: 'Check whether median and mode should be covered here or in data interpretation.',
  },
  {
    key: 'apt-q-profit-loss-discount', area: Q, name: 'Profit, loss and discount',
    description: 'Profit and loss percentages on the cost price, successive discounts, and marking up then discounting.',
    levels: [
      'Knows that profit and loss percentages are on the cost price and discounts are on the marked price.',
      'Works out profit percentage and a single or double discount with a checklist of which price is the base.',
      'Solves mark-up-then-discount problems and successive discounts unaided.',
      'Detects profit computed on the selling price or percentages added across different bases, and verifies with actual prices.',
    ],
    prerequisites: ['apt-q-percentages'],
    basis: `${SSC_Q}: "profit and loss, discount"; NCERT Class VIII, comparing quantities.`,
    expertCheck: 'Check the convention that profit percentage is on cost price is stated where a learner needs it.',
  },
  {
    key: 'apt-q-interest', area: Q, name: 'Simple and compound interest',
    description: 'Simple interest over years and months, compound interest compounded annually, and the difference between interest and amount.',
    levels: [
      'Knows the difference between simple and compound interest and between the interest and the amount.',
      'Computes simple interest and two-year compound interest from the formulas with a worked example.',
      'Solves interest problems with months and with annual compounding unaided.',
      'Spots time left in months, compound interest treated as simple, or the amount given as the interest, and checks by year-by-year working.',
    ],
    prerequisites: ['apt-q-percentages'],
    basis: `${SSC_Q}: "interest"; NCERT Class VIII, comparing quantities (compound interest).`,
    expertCheck: 'Check whether half-yearly compounding belongs in the ADVANCED band here.',
  },
  {
    key: 'apt-q-time-work', area: Q, name: 'Time and work',
    description: 'Combined work rates, finding one worker\'s time from a combined time, and pipes that fill and empty a tank.',
    levels: [
      'Knows that work rates (work per day) add, not the days themselves.',
      'Finds a combined time from two individual times by adding rates, following a worked example.',
      'Solves work problems including an emptying pipe unaided.',
      'Detects days added or averaged instead of rates, or an outflow counted as inflow, and checks by the work done in one day.',
    ],
    prerequisites: ['apt-q-ratio-proportion'],
    basis: `${SSC_Q}: "time and work".`,
    expertCheck: 'Check the pipes-and-cisterns items sit well under this skill.',
  },
  {
    key: 'apt-q-time-speed-distance', area: Q, name: 'Time, speed and distance',
    description: 'Average speed over equal distances, converting km/h to m/s, and trains crossing a platform.',
    levels: [
      'Knows that distance equals speed times time and that units must match.',
      'Converts between km/h and m/s and finds an average speed with total distance over total time, with the formula to hand.',
      'Solves average-speed and train-length problems unaided.',
      'Spots an average of speeds taken as the average speed, a missing unit conversion or a missing length, and checks with total distance and time.',
    ],
    prerequisites: ['apt-q-ratio-proportion'],
    basis: `${SSC_Q}: "time and distance".`,
    expertCheck: 'Check whether boats and streams should be added at the ADVANCED band.',
  },
  {
    key: 'apt-q-mixtures-alligation', area: Q, name: 'Mixtures and alligation',
    description: 'Concentration of a mixture, the ratio for mixing two qualities to a target price, and repeated replacement.',
    levels: [
      'Knows that a mixture\'s concentration is a weighted average of its parts.',
      'Finds a mixture\'s concentration and a mixing ratio using the alligation diagram with guidance.',
      'Solves mixing-ratio and repeated-replacement problems unaided.',
      'Detects an unweighted average, a reversed alligation ratio or a linear treatment of replacement, and checks by computing the mixture back.',
    ],
    prerequisites: ['apt-q-averages', 'apt-q-ratio-proportion'],
    basis: `${SSC_Q}: "mixture and alligation".`,
    expertCheck: 'Check the replacement items are not beyond the intended level.',
  },
  {
    key: 'apt-q-linear-equations', area: Q, name: 'Linear equations and word problems',
    description: 'Solving a linear equation in one unknown, the sum-and-difference problem, and age problems.',
    levels: [
      'Knows that an equation stays balanced when the same operation is done to both sides.',
      'Solves a one-step or two-step linear equation and sets up a sum-and-difference problem with guidance.',
      'Translates word problems (sums, differences, ages) into equations and solves them unaided.',
      'Finds a sign error on moving a term, an operation undone on only one term, or an answer to the wrong quantity, and checks by substituting back.',
    ],
    prerequisites: ['apt-q-arithmetic-operations'],
    basis: `${SSC_Q}: "basic algebra"; NCERT Class X, Pair of Linear Equations in Two Variables.`,
    expertCheck: 'Check age problems are appropriate for the INTERMEDIATE and ADVANCED bands.',
  },
  {
    key: 'apt-q-data-interpretation', area: Q, name: 'Data interpretation',
    description: 'Reading a small table of values by year: percentage change, the largest absolute change and the largest relative change.',
    levels: [
      'Knows the difference between a value, an absolute change and a percentage change in a table.',
      'Reads values from a table and computes a percentage change with the formula to hand.',
      'Compares absolute and relative changes across periods unaided.',
      'Spots a change divided by the later value, a level mistaken for a change, or absolute and relative growth confused, and rechecks from the table.',
    ],
    prerequisites: ['apt-q-percentages', 'apt-q-averages'],
    basis: `${SSC_Q}: "data interpretation"; UPSC GS Paper II "data interpretation (charts, graphs, tables, data sufficiency etc.) — Class X level".`,
    expertCheck: 'Tables are written in text; check that is acceptable before charts exist in the item format. All figures are illustrative and describe no real organisation.',
  },
  {
    key: 'apt-q-counting-probability', area: Q, name: 'Counting and basic probability',
    description: 'Choosing a group (combinations), the probability of independent events together, and sums of two dice.',
    levels: [
      'Knows that probability is favourable outcomes over equally likely outcomes, and when order matters in counting.',
      'Counts selections and computes a simple probability with a listed sample space.',
      'Solves combination and independent-event problems unaided.',
      'Detects order counted when it does not matter, independent probabilities added, or outcomes treated as equally likely when they are not.',
    ],
    prerequisites: ['apt-q-number-properties', 'apt-q-arithmetic-operations'],
    basis: `${SSC_Q} (arithmetic reasoning); NCERT Class X, Probability.`,
    expertCheck: 'Check whether combinations are in scope for the aptitude block at this level.',
  },
  {
    key: 'apt-l-series', area: L, name: 'Number and letter series',
    description: 'Finding the rule of a number or letter series and the next term.',
    levels: [
      'Knows that a series follows a rule — a difference, a ratio, a pattern in the differences — and that letters can be read as positions 1 to 26.',
      'Finds the next term of a constant-difference or constant-ratio series by writing the differences.',
      'Finds rules with changing differences, mixed operations and letter positions unaided.',
      'Tests a proposed rule against every given term and notices when a repeated difference does not fit.',
    ],
    prerequisites: ['apt-q-arithmetic-operations'],
    basis: `${SSC_R}: "number series, alphabetical series".`,
    expertCheck: 'Check every series has one clear rule and the answer is unambiguous.',
  },
  {
    key: 'apt-l-coding-decoding', area: L, name: 'Coding and decoding',
    description: 'Letter-shift codes in either direction and letter-to-number codes.',
    levels: [
      'Knows that a code applies one rule to every letter and that the rule can be found from a worked example.',
      'Finds a shift from a coded example and applies it to a new word with an alphabet strip.',
      'Decodes and encodes with forward, backward and number codes unaided, including wrap-around from Z to A.',
      'Checks a decoded word letter by letter and catches a shift in the wrong direction or miscounted by one.',
    ],
    prerequisites: [],
    basis: `${SSC_R}: "coding and decoding".`,
    expertCheck: 'Check the words used are neutral and the wrap-around cases are fair.',
  },
  {
    key: 'apt-l-blood-relations', area: L, name: 'Family relationships',
    description: 'Working out how two people are related from a chain of statements.',
    levels: [
      'Knows the basic relation words and that each statement adds one link between two people.',
      'Draws a family tree from the statements and reads a relation from it with guidance.',
      'Works out relations across two or three generations unaided, including the words "only" and "no sons".',
      'Notices a skipped generation or an assumed gender and redraws the tree to check.',
    ],
    prerequisites: [],
    basis: `${SSC_R}: "blood relations".`,
    expertCheck: 'Check the relation words and family structures are neutral and familiar across Indian regions and family types.',
  },
  {
    key: 'apt-l-direction-sense', area: L, name: 'Direction sense',
    description: 'Tracking turns and walks to find a final direction and a straight-line distance.',
    levels: [
      'Knows the eight compass directions and that left and right depend on which way a person faces.',
      'Traces a walk on a sketch and finds the final direction with a compass drawn.',
      'Finds direction and straight-line distance after several turns unaided.',
      'Catches left and right taken from the reader\'s view, or the total path given as the distance, and redraws to check.',
    ],
    prerequisites: [],
    basis: `${SSC_R}: "direction sense".`,
    expertCheck: 'Check the distance items stay within the Pythagorean triples a learner can do without a calculator.',
  },
  {
    key: 'apt-l-syllogisms', area: L, name: 'Syllogisms',
    description: 'Deciding which conclusions follow from statements about groups (all, some, no), using only the statements.',
    levels: [
      'Knows what "all", "some" and "no" claim, and that a conclusion must follow from the statements alone.',
      'Tests a conclusion with a Venn diagram of the statements with guidance.',
      'Decides which conclusions definitely follow from two statements unaided.',
      'Catches a conversed "all", an assumed "some are not", a link through an undistributed middle term, or outside knowledge used instead of the statements.',
    ],
    prerequisites: [],
    basis: `${SSC_R}: "syllogistic reasoning"; UPSC GS Paper II "logical reasoning and analytical ability".`,
    expertCheck: 'Check each item\'s answer under the convention that "some" means "at least one" and "all A are B" implies "some B are A" (existence assumed), and that this convention is stated to learners.',
  },
  {
    key: 'apt-l-ordering-ranking', area: L, name: 'Ordering and ranking',
    description: 'Positions in a row or queue from both ends, and arranging people or objects from clues.',
    levels: [
      'Knows that a position counted from one end and from the other end share the person being counted.',
      'Places people from clues on a numbered sketch with guidance.',
      'Solves rank and arrangement problems from several clues unaided.',
      'Catches an off-by-one count or a flipped left/right or before/after, and checks every clue against the final order.',
    ],
    prerequisites: [],
    basis: `${SSC_R}: "arrangement", "ranking".`,
    expertCheck: 'Check the arrangement items have exactly one order that satisfies every clue.',
  },
  {
    key: 'apt-l-analogy-classification', area: L, name: 'Analogies and classification',
    description: 'Completing a word analogy by its relationship, and finding the odd one out of a group.',
    levels: [
      'Knows that an analogy repeats a relationship (tool to use, worker to place) and that an odd-one-out has one clear shared category.',
      'States the relationship in the first pair as a sentence and tests each option against it.',
      'Completes analogies and classifications unaided.',
      'Rejects options that share only a surface feature with the pair, and checks the chosen relationship fits both pairs.',
    ],
    prerequisites: ['apt-v-vocabulary'],
    basis: `${SSC_R}: "analogies", "classification".`,
    expertCheck: 'Check every item has one intended relationship and no second defensible answer.',
  },
  {
    key: 'apt-v-vocabulary', area: V, name: 'Vocabulary: synonyms and antonyms',
    description: 'Choosing the word closest or opposite in meaning to a given word.',
    levels: [
      'Knows what a synonym and an antonym are and that the question asks for one or the other.',
      'Chooses a synonym or antonym for common words, using the word in a sentence to test.',
      'Chooses synonyms and antonyms for less common words unaided.',
      'Catches an antonym picked for a synonym (or the reverse) and a word chosen because it looks or sounds like the given one.',
    ],
    prerequisites: [],
    basis: `${SSC_E}: "synonyms", "antonyms".`,
    expertCheck: 'Check the words are at the right level and each has one clearly best option.',
  },
  {
    key: 'apt-v-grammar', area: V, name: 'Grammar: agreement, tense, articles and prepositions',
    description: 'Choosing the grammatically correct sentence among close variants.',
    levels: [
      'Knows that a verb agrees with its subject and that tense, article and preposition choices follow rules.',
      'Finds the error in a sentence with a checklist (subject, verb, tense, article, preposition).',
      'Chooses the correct sentence among close variants unaided.',
      'Explains why each wrong variant is wrong — agreement with the nearest noun, tense sequence, "a" before a vowel sound, a fixed preposition.',
    ],
    prerequisites: [],
    basis: `${SSC_E}: "spot the error", "sentence improvement".`,
    expertCheck: 'Check each item against standard written English as taught in Indian classrooms, and that no variant marked wrong is accepted in Indian English usage.',
  },
  {
    key: 'apt-v-sentence-completion', area: V, name: 'Sentence completion',
    description: 'Filling a blank using the sentence\'s clue words, word forms and fixed expressions.',
    levels: [
      'Knows that a blank is fixed by the sentence around it, including clue words such as although, despite and so … that.',
      'Uses the clue word to decide whether the blank continues or contrasts, with guidance.',
      'Completes sentences with the right word and word form unaided.',
      'Catches a missed contrast signal, a confused word form or an unidiomatic pairing, and rereads the sentence with the choice in place.',
    ],
    prerequisites: ['apt-v-vocabulary', 'apt-v-grammar'],
    basis: `${SSC_E}: "fill in the blanks".`,
    expertCheck: 'Check each blank has one best answer.',
  },
  {
    key: 'apt-v-reading-comprehension', area: V, name: 'Reading comprehension',
    description: 'Main idea, detail, inference and word meaning from a short passage.',
    levels: [
      'Knows the difference between a passage\'s main idea, a detail and an inference.',
      'Finds a stated detail and the main idea with guidance.',
      'Answers main-idea, detail, inference and vocabulary-in-context questions unaided.',
      'Rejects options that overstate the passage, bring in outside knowledge, change a detail or take a word literally, and points to the line that decides.',
    ],
    prerequisites: ['apt-v-vocabulary'],
    basis: `${SSC_E}: "comprehension passage"; UPSC GS Paper II "comprehension".`,
    expertCheck: 'The three passages are original and describe no real place or organisation; check they are neutral and at the right reading level.',
  },
  {
    key: 'apt-v-idioms', area: V, name: 'Idioms and phrases',
    description: 'The meaning of common English idioms.',
    levels: [
      'Knows that an idiom\'s meaning is not the sum of its words.',
      'Chooses the meaning of a common idiom from a sentence that uses it.',
      'Chooses meanings of common idioms without a supporting sentence.',
      'Rejects the literal reading and the opposite sense, and checks the meaning in a sentence of their own.',
    ],
    prerequisites: ['apt-v-vocabulary'],
    basis: `${SSC_E}: "idioms and phrases".`,
    expertCheck: 'Check the idioms chosen are common in Indian English and the meanings match a standard dictionary.',
  },
];

export const SKILLS: readonly AptitudeSkill[] = SKILL_DEFS.map((def) => ({
  stableKey: def.key, area: def.area, name: def.name, description: def.description,
  levels: { AWARE: def.levels[0], GUIDED: def.levels[1], INDEPENDENT: def.levels[2], TROUBLESHOOT: def.levels[3] },
  prerequisites: [...def.prerequisites], basis: def.basis, expertCheck: def.expertCheck,
}));

interface CodeDef {
  readonly code: string;
  readonly skill: string;
  readonly title: string;
  readonly description: string;
  /** The rationale a distractor tagged with this code carries when it gives none of its own. */
  readonly typical: string;
}

const CODE_DEFS: readonly CodeDef[] = [
  // Number properties
  { code: 'APT_Q_HCF_LCM_SWAP', skill: 'apt-q-number-properties', title: 'Swaps HCF and LCM', description: 'Gives the highest common factor where the least common multiple is asked for, or the reverse.', typical: 'This is the other one of HCF and LCM.' },
  { code: 'APT_Q_LCM_AS_PRODUCT', skill: 'apt-q-number-properties', title: 'Takes the product as the LCM', description: 'Multiplies the numbers together and takes the product as their least common multiple, ignoring shared factors.', typical: 'This is the product of the numbers, which is a common multiple but not the least one when they share a factor.' },
  { code: 'APT_Q_HCF_ANY_COMMON_FACTOR', skill: 'apt-q-number-properties', title: 'Takes any common factor as the HCF', description: 'Stops at a common factor that is not the highest one.', typical: 'This divides both numbers but is not the highest such number.' },
  // Arithmetic
  { code: 'APT_Q_LEFT_TO_RIGHT_ORDER', skill: 'apt-q-arithmetic-operations', title: 'Evaluates strictly left to right', description: 'Adds before multiplying because the addition comes first, ignoring the order of operations.', typical: 'This comes from doing the addition first, left to right.' },
  { code: 'APT_Q_FRACTION_ADD_ACROSS', skill: 'apt-q-arithmetic-operations', title: 'Adds numerators and denominators', description: 'Adds two fractions by adding the numerators and adding the denominators.', typical: 'This adds the tops and the bottoms separately.' },
  { code: 'APT_Q_DECIMAL_PLACE_SHIFT', skill: 'apt-q-arithmetic-operations', title: 'Misplaces the decimal point', description: 'Multiplies the digits correctly but counts the decimal places in the product wrongly.', typical: 'The digits are right but the decimal point is in the wrong place.' },
  // Percentages
  { code: 'APT_Q_PCT_WRONG_BASE', skill: 'apt-q-percentages', title: 'Uses the wrong base for a percentage', description: 'Takes a percentage of the new value, or of the other quantity, when the question measures against the original.', typical: 'This takes the percentage of the wrong quantity.' },
  { code: 'APT_Q_PCT_SUCCESSIVE_ADDED', skill: 'apt-q-percentages', title: 'Adds successive percentage changes', description: 'Adds or cancels successive percentage changes as if they applied to the same base.', typical: 'This treats the two changes as cancelling or adding, but the second applies to a different base.' },
  // Ratio
  { code: 'APT_Q_RATIO_PART_AS_WHOLE', skill: 'apt-q-ratio-proportion', title: 'Gives a part as the whole', description: 'Finds one part of a ratio (or the other group) and gives it as the total.', typical: 'This is the size of the other group, not the total.' },
  { code: 'APT_Q_RATIO_INVERSE_AS_DIRECT', skill: 'apt-q-ratio-proportion', title: 'Uses direct proportion where it is inverse', description: 'Scales the answer up with more workers (or speed) when the quantity actually falls.', typical: 'This scales directly, but more workers means fewer days.' },
  { code: 'APT_Q_RATIO_ADDITIVE_REASONING', skill: 'apt-q-ratio-proportion', title: 'Reasons additively about a ratio', description: 'Keeps the difference between the terms the same instead of keeping their ratio.', typical: 'This keeps the difference the same instead of the ratio.' },
  // Averages
  { code: 'APT_Q_AVG_UNWEIGHTED', skill: 'apt-q-averages', title: 'Averages the averages', description: 'Combines group averages without weighting them by the group sizes.', typical: 'This is the simple average of the two averages, ignoring how many are in each group.' },
  { code: 'APT_Q_AVG_WRONG_COUNT', skill: 'apt-q-averages', title: 'Divides by the wrong count', description: 'Divides a total by the wrong number of values, for example the count before a value was removed.', typical: 'The total is right but it is divided by the wrong number of values.' },
  // Profit and loss
  { code: 'APT_Q_PL_PROFIT_ON_SP', skill: 'apt-q-profit-loss-discount', title: 'Computes profit on the selling price', description: 'Expresses profit or loss as a percentage of the selling price instead of the cost price.', typical: 'This divides the profit by the selling price instead of the cost price.' },
  { code: 'APT_Q_PL_PERCENTS_ADDED', skill: 'apt-q-profit-loss-discount', title: 'Adds percentages on different bases', description: 'Adds or subtracts discount and mark-up percentages as if they applied to the same price.', typical: 'This adds the percentages, but each applies to a different price.' },
  // Interest
  { code: 'APT_Q_CI_AS_SI', skill: 'apt-q-interest', title: 'Treats compound interest as simple', description: 'Computes interest on the principal only, each year, when interest is compounded.', typical: 'This is the simple interest; compounding also earns interest on the first year\'s interest.' },
  { code: 'APT_Q_SI_TIME_UNITS', skill: 'apt-q-interest', title: 'Leaves time in months', description: 'Uses a period in months with an annual rate without converting to years.', typical: 'This uses the number of months as if it were years.' },
  { code: 'APT_Q_INTEREST_VS_AMOUNT', skill: 'apt-q-interest', title: 'Confuses interest with amount', description: 'Gives the amount (principal plus interest) where the interest alone is asked for.', typical: 'This is the amount, principal plus interest, not the interest.' },
  // Time and work
  { code: 'APT_Q_TW_COMBINES_TIMES', skill: 'apt-q-time-work', title: 'Adds or subtracts times instead of rates', description: 'Combines the days taken rather than the work done per day.', typical: 'This adds or subtracts the times, but it is the rates of work that combine.' },
  { code: 'APT_Q_TW_AVERAGES_TIMES', skill: 'apt-q-time-work', title: 'Averages the times', description: 'Takes the average of the individual times as the time working together.', typical: 'This averages the two times; working together must be faster than either alone.' },
  { code: 'APT_Q_TW_OUTFLOW_AS_INFLOW', skill: 'apt-q-time-work', title: 'Counts an emptying pipe as filling', description: 'Adds the rate of a pipe that empties the tank instead of subtracting it.', typical: 'This treats the emptying pipe as if it also fills the tank.' },
  // Time, speed, distance
  { code: 'APT_Q_TSD_AVERAGE_OF_SPEEDS', skill: 'apt-q-time-speed-distance', title: 'Averages the speeds', description: 'Takes the mean of two speeds as the average speed over equal distances.', typical: 'This is the mean of the two speeds, but more time is spent at the slower speed.' },
  { code: 'APT_Q_TSD_UNIT_CONVERSION', skill: 'apt-q-time-speed-distance', title: 'Converts km/h and m/s the wrong way', description: 'Multiplies by 3.6 (or divides by it) in the wrong direction, or mixes units.', typical: 'This converts in the wrong direction.' },
  { code: 'APT_Q_TSD_IGNORES_LENGTH', skill: 'apt-q-time-speed-distance', title: 'Leaves out a length', description: 'Uses only the train\'s length (or only the platform\'s) as the distance covered in crossing.', typical: 'This covers only one of the two lengths.' },
  // Mixtures
  { code: 'APT_Q_MIX_SIMPLE_AVERAGE', skill: 'apt-q-mixtures-alligation', title: 'Averages concentrations without weights', description: 'Takes the simple average of two concentrations regardless of the quantities mixed.', typical: 'This is the simple average of the two strengths, ignoring the quantities.' },
  { code: 'APT_Q_MIX_RATIO_REVERSED', skill: 'apt-q-mixtures-alligation', title: 'Reverses the alligation ratio', description: 'Pairs each price difference with the wrong ingredient, giving the ratio upside down.', typical: 'This is the right ratio turned upside down.' },
  { code: 'APT_Q_MIX_REPLACEMENT_LINEAR', skill: 'apt-q-mixtures-alligation', title: 'Treats repeated replacement as linear', description: 'Subtracts the removed quantity each time as if it were all pure, ignoring that later removals take out a mixture.', typical: 'This subtracts the same amount of pure milk each time, but the second removal takes out a mixture.' },
  // Linear equations
  { code: 'APT_Q_ALG_SIGN_ON_TRANSPOSE', skill: 'apt-q-linear-equations', title: 'Keeps the sign when moving a term', description: 'Moves a term to the other side of the equation without changing its sign.', typical: 'This moves the constant across without changing its sign.' },
  { code: 'APT_Q_ALG_INCOMPLETE_INVERSE', skill: 'apt-q-linear-equations', title: 'Undoes only one operation', description: 'Undoes the addition but not the multiplication (or halving), stopping one step short.', typical: 'This stops one step short: the last operation is not undone.' },
  { code: 'APT_Q_ALG_DIVIDE_ONE_TERM', skill: 'apt-q-linear-equations', title: 'Divides only one term', description: 'Divides one side by the coefficient but not every term on it.', typical: 'This divides only part of the expression.' },
  { code: 'APT_Q_ALG_WRONG_QUANTITY', skill: 'apt-q-linear-equations', title: 'Answers for a different quantity', description: 'Solves correctly but reports another quantity from the problem (a future age, the other person) instead of the one asked.', typical: 'This is another quantity from the problem, not the one asked for.' },
  // Data interpretation
  { code: 'APT_Q_DI_CHANGE_ON_LATER_VALUE', skill: 'apt-q-data-interpretation', title: 'Divides a change by the later value', description: 'Computes a percentage change against the later value instead of the earlier one.', typical: 'This divides the change by the later year\'s value instead of the earlier one.' },
  { code: 'APT_Q_DI_ABSOLUTE_VS_RELATIVE', skill: 'apt-q-data-interpretation', title: 'Confuses absolute and relative change', description: 'Takes the largest absolute change for the largest percentage change, or reads an absolute difference as a percentage.', typical: 'This mixes up the change in units with the change in percent.' },
  { code: 'APT_Q_DI_LEVEL_VS_CHANGE', skill: 'apt-q-data-interpretation', title: 'Picks the highest value instead of the highest change', description: 'Chooses the period with the largest value when the question asks about the largest change.', typical: 'This is the year with the highest value, not the highest increase.' },
  // Counting and probability
  { code: 'APT_Q_PROB_ORDER_COUNTED', skill: 'apt-q-counting-probability', title: 'Counts order when it does not matter', description: 'Counts arrangements (permutations) where only the choice of members matters.', typical: 'This counts each group once for every order of its members.' },
  { code: 'APT_Q_PROB_ADDS_INDEPENDENT', skill: 'apt-q-counting-probability', title: 'Adds probabilities of events that must both happen', description: 'Adds the probabilities of independent events instead of multiplying them.', typical: 'This adds the probabilities; for both to happen they multiply.' },
  { code: 'APT_Q_PROB_UNEQUAL_OUTCOMES', skill: 'apt-q-counting-probability', title: 'Treats unequal outcomes as equally likely', description: 'Counts the possible sums of two dice as if each sum were equally likely.', typical: 'This treats the eleven possible sums as equally likely; they are not.' },
  // Series
  { code: 'APT_L_SERIES_REPEATS_LAST_STEP', skill: 'apt-l-series', title: 'Repeats the last step', description: 'Adds the last difference again (or repeats the last step) without finding the rule the differences follow.', typical: 'This repeats the last difference, but the differences themselves change.' },
  { code: 'APT_L_SERIES_POSITION_OFF_BY_ONE', skill: 'apt-l-series', title: 'Miscounts a letter position', description: 'Counts letters in the alphabet one too many or too few.', typical: 'This is one letter away from the rule\'s answer.' },
  // Coding
  { code: 'APT_L_CODE_SHIFT_DIRECTION', skill: 'apt-l-coding-decoding', title: 'Shifts in the wrong direction', description: 'Applies the code\'s shift backwards instead of forwards, or the reverse.', typical: 'This shifts the letters the opposite way.' },
  { code: 'APT_L_CODE_POSITION_MISCOUNT', skill: 'apt-l-coding-decoding', title: 'Miscounts the shift', description: 'Shifts each letter one place too far or counts alphabet positions from zero.', typical: 'This shifts every letter one place too far.' },
  // Blood relations
  { code: 'APT_L_REL_GENERATION_SKIP', skill: 'apt-l-blood-relations', title: 'Skips or adds a generation', description: 'Gives a relation one generation away from the right one (father for grandfather, sister for daughter).', typical: 'This is one generation away from the right relation.' },
  { code: 'APT_L_REL_GENDER_ASSUMED', skill: 'apt-l-blood-relations', title: 'Assumes or swaps a gender', description: 'Gives a gendered relation the statements do not support, or the wrong gender.', typical: 'The statements do not give this gender.' },
  { code: 'APT_L_REL_IGNORES_ONLY', skill: 'apt-l-blood-relations', title: 'Ignores "only"', description: 'Allows for another sibling or child when the statement says "only".', typical: 'This needs another sibling, but the statement says "only".' },
  // Direction
  { code: 'APT_L_DIR_TURN_REFERENCE', skill: 'apt-l-direction-sense', title: 'Takes left and right from the reader\'s view', description: 'Turns left or right as seen on the page rather than from the direction the person faces.', typical: 'This turns the other way, as if left and right were fixed on the page.' },
  { code: 'APT_L_DIR_PATH_AS_DISTANCE', skill: 'apt-l-direction-sense', title: 'Gives the path length as the distance', description: 'Adds every leg walked instead of finding the straight-line distance from the start.', typical: 'This is the total distance walked, not the straight-line distance from the start.' },
  // Syllogisms
  { code: 'APT_L_SYL_CONVERSE', skill: 'apt-l-syllogisms', title: 'Converts "all A are B" to "all B are A"', description: 'Reads a universal statement as if it also held in reverse.', typical: 'This reverses an "all" statement, which does not follow.' },
  { code: 'APT_L_SYL_SOME_NOT_ASSUMED', skill: 'apt-l-syllogisms', title: 'Assumes "some are not"', description: 'Takes "some A are B" (or "all") to imply that some A are not B.', typical: '"Some" means at least one; it does not say that some are not.' },
  { code: 'APT_L_SYL_UNLINKED_TERMS', skill: 'apt-l-syllogisms', title: 'Links two terms the statements never link', description: 'Concludes a relation between two groups that only share a middle group.', typical: 'The statements never connect these two groups directly.' },
  { code: 'APT_L_SYL_OUTSIDE_KNOWLEDGE', skill: 'apt-l-syllogisms', title: 'Uses outside knowledge', description: 'Judges a conclusion by what is true in the world instead of by the statements given.', typical: 'This uses real-world knowledge; only the statements count.' },
  // Ordering
  { code: 'APT_L_RANK_OFF_BY_ONE', skill: 'apt-l-ordering-ranking', title: 'Counts the person twice or not at all', description: 'Adds positions from both ends without subtracting the shared person, or miscounts a position by one.', typical: 'This is one place off: the person counted is counted twice or missed.' },
  { code: 'APT_L_ORDER_DIRECTION_FLIP', skill: 'apt-l-ordering-ranking', title: 'Flips left and right or before and after', description: 'Places someone on the wrong side of a clue\'s reference person.', typical: 'This places someone on the wrong side of the clue.' },
  // Analogy and classification
  { code: 'APT_L_ANALOGY_SURFACE_FEATURE', skill: 'apt-l-analogy-classification', title: 'Matches a surface feature', description: 'Chooses an option that is associated with the words, or shares a surface trait, instead of repeating the relationship or the category.', typical: 'This is associated with the words but does not share the relationship.' },
  // Vocabulary
  { code: 'APT_V_VOCAB_OPPOSITE_CHOSEN', skill: 'apt-v-vocabulary', title: 'Chooses the opposite of what is asked', description: 'Picks an antonym when a synonym is asked for, or a synonym when an antonym is asked for.', typical: 'This means the opposite of what the question asks for.' },
  { code: 'APT_V_VOCAB_SOUND_ALIKE', skill: 'apt-v-vocabulary', title: 'Chooses a word that looks or sounds alike', description: 'Picks a word because it resembles the given word in spelling or sound.', typical: 'This looks or sounds like the given word but means something else.' },
  // Grammar
  { code: 'APT_V_GRAM_AGREEMENT', skill: 'apt-v-grammar', title: 'Agrees the verb with the wrong noun', description: 'Makes the verb agree with the nearest noun or with the meaning instead of the grammatical subject.', typical: 'The verb agrees with the wrong noun.' },
  { code: 'APT_V_GRAM_TENSE', skill: 'apt-v-grammar', title: 'Uses the wrong tense', description: 'Breaks the tense sequence, uses a simple present for a continuing state, or a future after "if".', typical: 'The tense does not fit the time the sentence describes.' },
  { code: 'APT_V_GRAM_PREPOSITION', skill: 'apt-v-grammar', title: 'Uses the wrong preposition', description: 'Uses a preposition that the word or time expression does not take (since/for, good at, prefer to).', typical: 'The preposition does not go with this word or time expression.' },
  { code: 'APT_V_GRAM_ARTICLE_BY_SPELLING', skill: 'apt-v-grammar', title: 'Chooses "a" or "an" by spelling', description: 'Chooses the article by the first letter instead of the first sound.', typical: 'The article follows the first letter, not the first sound.' },
  // Sentence completion
  { code: 'APT_V_FILL_CLUE_MISSED', skill: 'apt-v-sentence-completion', title: 'Misses the clue word', description: 'Ignores the word (although, despite, so … that, therefore) that fixes whether the blank continues or contrasts.', typical: 'This ignores the clue word that fixes the meaning of the blank.' },
  { code: 'APT_V_FILL_WORD_CONFUSION', skill: 'apt-v-sentence-completion', title: 'Confuses similar words or word forms', description: 'Picks a word that is close in spelling or a different form of the right word.', typical: 'This is a similar-looking word or the wrong form of the right word.' },
  { code: 'APT_V_FILL_COLLOCATION', skill: 'apt-v-sentence-completion', title: 'Ignores the fixed pairing', description: 'Picks a word with roughly the right meaning that does not pair idiomatically with the words around it.', typical: 'The meaning is close, but the word does not go with the words around it.' },
  // Reading
  { code: 'APT_V_RC_OUTSIDE_KNOWLEDGE', skill: 'apt-v-reading-comprehension', title: 'Answers from outside knowledge', description: 'Chooses an option that may be true or plausible but is not supported by the passage.', typical: 'The passage does not say this.' },
  { code: 'APT_V_RC_OVERSTATED', skill: 'apt-v-reading-comprehension', title: 'Chooses an overstated option', description: 'Chooses an option with "all", "only", "always" or "never" that goes beyond the passage.', typical: 'This goes further than the passage does.' },
  { code: 'APT_V_RC_DETAIL_AS_MAIN_IDEA', skill: 'apt-v-reading-comprehension', title: 'Takes a detail for the main idea', description: 'Chooses a true detail of the passage when the question asks for its main idea.', typical: 'This is a detail from the passage, not what the whole passage is about.' },
  { code: 'APT_V_RC_CHANGED_DETAIL', skill: 'apt-v-reading-comprehension', title: 'Misreads a detail', description: 'Chooses an option that changes a detail the passage states.', typical: 'This changes what the passage actually says.' },
  { code: 'APT_V_RC_LITERAL_SENSE', skill: 'apt-v-reading-comprehension', title: 'Takes a word in its everyday sense', description: 'Chooses a word\'s common meaning instead of the meaning it has in the passage.', typical: 'This is the everyday meaning of the word, not its meaning in the passage.' },
  // Idioms
  { code: 'APT_V_IDIOM_LITERAL', skill: 'apt-v-idioms', title: 'Reads the idiom literally', description: 'Takes the words of an idiom at face value.', typical: 'This reads the words literally.' },
  { code: 'APT_V_IDIOM_OPPOSITE_SENSE', skill: 'apt-v-idioms', title: 'Chooses the opposite sense', description: 'Chooses a meaning opposite to the idiom\'s.', typical: 'This is the opposite of what the idiom means.' },
];

const skillBasis = new Map(SKILL_DEFS.map((def) => [def.key, def.basis]));

export const MISCONCEPTIONS: readonly AptitudeMisconception[] = CODE_DEFS.map((def) => ({
  code: def.code, skill: def.skill, title: def.title, description: def.description,
  basis: `A common error for ${def.skill} (${skillBasis.get(def.skill)}), described from standard teaching of the topic in the agent's own words; no source lists it verbatim.`,
  expertCheck: 'Check the misconception is real and common among learners at this level, and that its title and description are how a teacher would name it.',
}));

/** Per-skill authoring context for the item files. */
export function authoringFor(skill: string): SkillAuthoring {
  const def = SKILL_DEFS.find((entry) => entry.key === skill);
  if (!def) throw new Error(`unknown skill ${skill}`);
  const rationale: Record<string, string> = {};
  for (const code of CODE_DEFS.filter((entry) => entry.skill === skill)) rationale[code.code] = code.typical;
  return {
    skill,
    basis: `${def.basis} Item written for this pack in original wording; not taken or adapted from any question bank.`,
    expertCheck: def.expertCheck,
    rationale,
  };
}
