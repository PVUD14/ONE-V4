/**
 * Logical reasoning items (ENG-10): 7 skills, 12 items each.
 *
 * Why this exists: series, family relationships, syllogisms and analogies are written out item by
 * item; coding, direction and ranking items are computed from their inputs (the code applied
 * letter by letter, the walk traced step by step) so the answer is never typed by hand. Every item
 * is original wording; names are common Indian first names chosen for variety and describe no
 * real person.
 */
import type { AptitudeItem } from '../aptitude-bank.js';
import { authoringFor } from './skills.js';
import { buildItem, itemKey, num, ordinal, type ItemSpec, type WrongOption } from './author.js';

type Maker = (index: number) => ItemSpec;

function skillItems(skill: string, makers: readonly Maker[]): AptitudeItem[] {
  const authoring = authoringFor(skill);
  return makers.map((make, index) => buildItem(authoring, make(index + 1)));
}

/** A hand-written item: the skill's nudge and strategy, then the item's own worked step and near-solution. */
function written(skill: string, difficulty: ItemSpec['difficulty'], prompt: string, answer: string, wrong: readonly [WrongOption, WrongOption, WrongOption],
  explanation: string, ladder: { readonly nudge: string; readonly strategy: string; readonly step: string; readonly near: string }, check?: string): Maker {
  return (i) => ({
    key: itemKey(skill, i), difficulty, prompt, answer, wrong, explanation,
    hints: [ladder.nudge, ladder.strategy, ladder.step, ladder.near],
    ...(check ? { check } : {}),
  });
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------
const SE = 'apt-l-series';
const seriesNudge = 'Write the difference between each pair of neighbouring terms.';
const seriesStrategy = 'If the differences are not constant, look for a pattern in the differences themselves, or a multiplying rule.';
const REPEAT = 'APT_L_SERIES_REPEATS_LAST_STEP';
const OFF = 'APT_L_SERIES_POSITION_OFF_BY_ONE';
const series: Maker[] = [
  written(SE, 'FOUNDATION', 'What comes next? 2, 6, 12, 20, 30, ?', '42', [{ text: '40', code: REPEAT }, { text: '36' }, { text: '44' }],
    'The differences are 4, 6, 8, 10, so the next difference is 12: 30 + 12 = 42. (Each term is n × (n + 1).)',
    { nudge: seriesNudge, strategy: seriesStrategy, step: 'The differences are 4, 6, 8, 10.', near: 'The differences go up by 2 each time; add the next one to 30.' }),
  written(SE, 'FOUNDATION', 'What comes next? 3, 6, 12, 24, ?', '48', [{ text: '36', code: REPEAT, why: 'This adds the last difference (12) again, but each term doubles.' }, { text: '30' }, { text: '42' }],
    'Each term is twice the one before: 24 × 2 = 48.',
    { nudge: seriesNudge, strategy: seriesStrategy, step: 'The differences are 3, 6, 12 — they double too.', near: 'Each term is a fixed multiple of the one before; apply it to 24.' }),
  written(SE, 'FOUNDATION', 'What comes next? 1, 4, 9, 16, 25, ?', '36', [{ text: '34', code: REPEAT }, { text: '35' }, { text: '30' }],
    'These are the squares 1², 2², 3², 4², 5², so the next is 6² = 36.',
    { nudge: seriesNudge, strategy: seriesStrategy, step: 'The differences are 3, 5, 7, 9.', near: 'The differences are consecutive odd numbers; the next is 11.' }),
  written(SE, 'INTERMEDIATE', 'What comes next? 5, 11, 23, 47, ?', '95', [{ text: '71', code: REPEAT }, { text: '94' }, { text: '96' }],
    'Each term is double the previous one plus 1: 47 × 2 + 1 = 95.',
    { nudge: seriesNudge, strategy: seriesStrategy, step: '5 × 2 + 1 = 11 and 11 × 2 + 1 = 23.', near: 'Apply "double and add 1" to 47.' }),
  written(SE, 'INTERMEDIATE', 'What comes next? 2, 3, 5, 8, 12, 17, ?', '23', [{ text: '22', code: REPEAT }, { text: '24' }, { text: '25' }],
    'The differences are 1, 2, 3, 4, 5, so the next is 6: 17 + 6 = 23.',
    { nudge: seriesNudge, strategy: seriesStrategy, step: 'The differences are 1, 2, 3, 4, 5.', near: 'The next difference is one more than 5; add it to 17.' }),
  written(SE, 'INTERMEDIATE', 'What comes next? 100, 96, 88, 76, ?', '60', [{ text: '64', code: REPEAT }, { text: '62' }, { text: '56' }],
    'The terms fall by 4, 8, 12, so next by 16: 76 − 16 = 60.',
    { nudge: seriesNudge, strategy: seriesStrategy, step: 'The drops are 4, 8, 12.', near: 'The drops grow by 4 each time; take the next one from 76.' }),
  written(SE, 'FOUNDATION', 'What comes next? 7, 14, 28, 56, ?', '112', [{ text: '84', code: REPEAT }, { text: '70' }, { text: '120' }],
    'Each term doubles: 56 × 2 = 112.',
    { nudge: seriesNudge, strategy: seriesStrategy, step: 'The differences are 7, 14, 28 — each twice the last.', near: 'Double 56.' }),
  written(SE, 'INTERMEDIATE', 'What comes next? 1, 1, 2, 3, 5, 8, ?', '13', [{ text: '11', code: REPEAT }, { text: '12' }, { text: '16' }],
    'Each term is the sum of the two before it: 5 + 8 = 13.',
    { nudge: seriesNudge, strategy: 'Look at how each term relates to the two terms before it.', step: '1 + 1 = 2, 1 + 2 = 3, 2 + 3 = 5.', near: 'Add the last two terms.' }),
  written(SE, 'FOUNDATION', 'What comes next? A, C, E, G, ?', 'I', [{ text: 'H', code: OFF }, { text: 'J' }, { text: 'K' }],
    'The letters skip one each time (positions 1, 3, 5, 7), so the next is position 9: I.',
    { nudge: 'Turn each letter into its position in the alphabet (A = 1).', strategy: seriesStrategy, step: 'A, C, E, G are 1, 3, 5, 7.', near: 'The next position is 9; count to the ninth letter.' }),
  written(SE, 'FOUNDATION', 'What comes next? B, E, H, K, ?', 'N', [{ text: 'M', code: OFF }, { text: 'O' }, { text: 'L' }],
    'Positions 2, 5, 8, 11 go up by 3, so the next is 14: N.',
    { nudge: 'Turn each letter into its position in the alphabet (A = 1).', strategy: seriesStrategy, step: 'B, E, H, K are 2, 5, 8, 11.', near: 'Add 3 to 11 and find that letter.' }),
  written(SE, 'ADVANCED', 'What comes next? Z, X, U, Q, ?', 'L', [{ text: 'M', code: REPEAT, why: 'This steps back by 4 again, but the steps grow: 2, 3, 4, then 5.' }, { text: 'K', code: OFF }, { text: 'N' }],
    'Positions 26, 24, 21, 17 fall by 2, 3, 4, so next by 5: 12, which is L.',
    { nudge: 'Turn each letter into its position in the alphabet (A = 1).', strategy: seriesStrategy, step: 'Z, X, U, Q are 26, 24, 21, 17.', near: 'The steps back are 2, 3, 4; take the next step back from 17.' }),
  written(SE, 'INTERMEDIATE', 'What comes next? AZ, BY, CX, ?', 'DW', [{ text: 'DV', code: OFF }, { text: 'EW' }, { text: 'CW' }],
    'The first letter moves forward one (A, B, C, D) and the second moves back one (Z, Y, X, W): DW.',
    { nudge: 'Look at the first letters and the second letters separately.', strategy: 'Find the rule for each position of the pair.', step: 'First letters: A, B, C. Second letters: Z, Y, X.', near: 'Continue each: one forward, one back.' }),
];

// ---------------------------------------------------------------------------
// Coding and decoding (computed)
// ---------------------------------------------------------------------------
const CD = 'apt-l-coding-decoding';
const shiftWord = (word: string, by: number): string =>
  [...word].map((char) => String.fromCharCode(((char.charCodeAt(0) - 65 + by) % 26 + 26) % 26 + 65)).join('');
const positions = (word: string): string => [...word].map((char) => String(char.charCodeAt(0) - 64)).join('');
const positionsShifted = (word: string, by: number): string => [...word].map((char) => String(char.charCodeAt(0) - 64 + by)).join('');
const WAY = (by: number): string => (by > 0 ? 'after' : 'before');
const PLACES = (by: number): string => (Math.abs(by) === 1 ? '1 place' : `${Math.abs(by)} places`);

const coding: Maker[] = [
  ...([[3, 'CAT', 'DOG'], [2, 'COLD', 'WARM'], [1, 'BOOK', 'LAMP'], [4, 'TIME', 'NOTE'],
    [-1, 'FISH', 'BIRD'], [-2, 'GOAL', 'TEAM'], [-3, 'RIVER', 'STONE'], [-1, 'MAP', 'ROAD']] as const).map(([by, example, target]) => (i: number): ItemSpec => ({
    key: itemKey(CD, i), difficulty: Math.abs(by) >= 3 || target.length >= 5 ? 'INTERMEDIATE' : 'FOUNDATION',
    prompt: `In a code, each letter is replaced by the letter ${PLACES(by)} ${WAY(by)} it in the alphabet (Z is followed by A). ${example} is written as ${shiftWord(example, by)}. How is ${target} written?`,
    answer: shiftWord(target, by),
    wrong: [
      { text: shiftWord(target, -by), code: 'APT_L_CODE_SHIFT_DIRECTION' },
      { text: shiftWord(target, by + Math.sign(by)), code: 'APT_L_CODE_POSITION_MISCOUNT' },
      { text: shiftWord(target, by - Math.sign(by)) === target ? [...shiftWord(target, by)].reverse().join('') : shiftWord(target, by - Math.sign(by)) },
    ],
    explanation: `Move each letter of ${target} ${PLACES(by)} ${by > 0 ? 'forward' : 'back'}: ${[...target].map((char) => `${char}→${shiftWord(char, by)}`).join(', ')}, giving ${shiftWord(target, by)}.`,
    hints: [
      'The same rule is applied to every letter.',
      `Check the rule on the example: ${example[0]} becomes ${shiftWord(example[0]!, by)}.`,
      `The first letter of ${target} is ${target[0]}; ${PLACES(by)} ${WAY(by)} it is ${shiftWord(target[0]!, by)}.`,
      `Apply the same move to the remaining letters ${target.slice(1)}.`,
    ],
  })),
  ...([['CAB', 'BED'], ['DAB', 'FACE'], ['BAG', 'HID'], ['ACE', 'BEAD']] as const).map(([example, target]) => (i: number): ItemSpec => ({
    key: itemKey(CD, i), difficulty: 'FOUNDATION',
    prompt: `In a code, each letter is written as its position in the alphabet (A = 1, B = 2, …), and the numbers are written side by side. ${example} is written as ${positions(example)}. How is ${target} written?`,
    answer: positions(target),
    wrong: [
      { text: positionsShifted(target, 1), code: 'APT_L_CODE_POSITION_MISCOUNT', why: 'Each letter is counted one place too far (as if A were 2).' },
      { text: [...target].reverse().map((char) => String(char.charCodeAt(0) - 64)).join('') },
      { text: positionsShifted(target, -1), code: 'APT_L_CODE_POSITION_MISCOUNT', why: 'Each letter is counted from zero (as if A were 0).' },
    ],
    explanation: `${[...target].map((char) => `${char} = ${char.charCodeAt(0) - 64}`).join(', ')}, so ${target} is written ${positions(target)}.`,
    hints: [
      'Every letter becomes a number the same way.',
      `Check on the example: ${example[0]} is written ${example.charCodeAt(0) - 64}.`,
      `${target[0]} is letter number ${target.charCodeAt(0) - 64}.`,
      `Write the positions of ${[...target.slice(1)].join(', ')} after it, in order.`,
    ],
  })),
];

// ---------------------------------------------------------------------------
// Family relationships
// ---------------------------------------------------------------------------
const BR = 'apt-l-blood-relations';
const brNudge = 'Draw a small family tree: one line per statement.';
const brStrategy = 'Place each person, mark who is male or female only where the statement says so, and read the relation across the generations.';
const GEN = 'APT_L_REL_GENERATION_SKIP';
const GENDER = 'APT_L_REL_GENDER_ASSUMED';
const ONLY = 'APT_L_REL_IGNORES_ONLY';
const relations: Maker[] = [
  written(BR, 'FOUNDATION', 'Arjun is the brother of Meera. Meera is the daughter of Kavita. How is Arjun related to Kavita?', 'Son',
    [{ text: 'Brother', code: GEN }, { text: 'Daughter', code: GENDER, why: 'Arjun is stated to be a brother, so he is male.' }, { text: 'Nephew' }],
    'Meera is Kavita\'s daughter and Arjun is Meera\'s brother, so Arjun is also Kavita\'s child — her son.',
    { nudge: brNudge, strategy: brStrategy, step: 'Meera is one generation below Kavita.', near: 'Arjun is Meera\'s brother, so he is in the same generation as Meera.' }),
  written(BR, 'FOUNDATION', 'Prakash is the father of Nisha. Nisha is the mother of Rohan. How is Prakash related to Rohan?', 'Grandfather',
    [{ text: 'Father', code: GEN }, { text: 'Grandmother', code: GENDER }, { text: 'Uncle' }],
    'Prakash is Nisha\'s father and Nisha is Rohan\'s mother, so Prakash is Rohan\'s mother\'s father: his grandfather.',
    { nudge: brNudge, strategy: brStrategy, step: 'Prakash → Nisha → Rohan is two generations.', near: 'Prakash is male and two generations above Rohan.' }),
  written(BR, 'INTERMEDIATE', 'Pointing to a man, Riya says, "He is the son of my grandfather\'s only son." How is the man related to Riya?', 'Brother',
    [{ text: 'Cousin', code: ONLY }, { text: 'Father', code: GEN }, { text: 'Uncle' }],
    'Riya\'s grandfather\'s only son is Riya\'s father. The man is her father\'s son: her brother.',
    { nudge: brNudge, strategy: brStrategy, step: 'Riya\'s grandfather has only one son. Who must that be?', near: 'That only son is Riya\'s father; the man is his son.' }),
  written(BR, 'INTERMEDIATE', 'Kiran is the sister of Nikhil. Nikhil is the son of Latha. Latha is the wife of Mohan. How is Kiran related to Mohan?', 'Daughter',
    [{ text: 'Sister', code: GEN }, { text: 'Son', code: GENDER }, { text: 'Niece' }],
    'Nikhil is Latha\'s son and Latha is Mohan\'s wife, so Nikhil is Mohan\'s son; Kiran, Nikhil\'s sister, is Mohan\'s daughter.',
    { nudge: brNudge, strategy: brStrategy, step: 'Latha and Mohan are a couple; Nikhil is their son.', near: 'Kiran is Nikhil\'s sister, in the same generation.' }),
  written(BR, 'INTERMEDIATE', 'Tara is a girl. Tara\'s mother is Vijay\'s sister. How is Tara related to Vijay?', 'Niece',
    [{ text: 'Cousin', code: GEN }, { text: 'Sister', code: GEN, why: 'This puts Tara in her mother\'s generation.' }, { text: 'Nephew', code: GENDER, why: 'The statement says Tara is a girl.' }],
    'Vijay is the brother of Tara\'s mother, so Vijay is Tara\'s uncle and Tara is his niece.',
    { nudge: brNudge, strategy: brStrategy, step: 'Tara\'s mother and Vijay are siblings.', near: 'Vijay is one generation above Tara, on her mother\'s side.' }),
  written(BR, 'FOUNDATION', 'Anil is Sunita\'s husband. Kamala is Anil\'s mother. How is Kamala related to Sunita?', 'Mother-in-law',
    [{ text: 'Sister-in-law', code: GEN }, { text: 'Father-in-law', code: GENDER }, { text: 'Mother' }],
    'Kamala is the mother of Sunita\'s husband, which makes her Sunita\'s mother-in-law.',
    { nudge: brNudge, strategy: brStrategy, step: 'Kamala is one generation above Anil.', near: 'She is related to Sunita through Sunita\'s husband.' }),
  written(BR, 'INTERMEDIATE', 'Introducing a woman, Arun says, "Her mother is the only daughter of my mother." How is the woman related to Arun?', 'Niece',
    [{ text: 'Sister', code: GEN }, { text: 'Nephew', code: GENDER }, { text: 'Daughter', code: ONLY, why: 'Only if Arun were his mother\'s daughter; the only daughter of his mother is his sister.' }],
    'The only daughter of Arun\'s mother is Arun\'s sister. The woman is his sister\'s daughter: his niece.',
    { nudge: brNudge, strategy: brStrategy, step: 'Who is the only daughter of Arun\'s mother?', near: 'That is Arun\'s sister, and the woman is her daughter.' }),
  written(BR, 'INTERMEDIATE', 'Karthik is the son of Lakshmi. Lakshmi is the sister of Manoj. Manoj is the father of Neha. How is Karthik related to Neha?', 'Cousin',
    [{ text: 'Brother' }, { text: 'Nephew', code: GEN }, { text: 'Uncle', code: GEN }],
    'Lakshmi and Manoj are siblings; Karthik is Lakshmi\'s son and Neha is Manoj\'s daughter, so they are cousins.',
    { nudge: brNudge, strategy: brStrategy, step: 'Lakshmi and Manoj are in one generation; Karthik and Neha are their children.', near: 'Children of siblings are related to each other how?' }),
  written(BR, 'FOUNDATION', 'Gopal is the father of Hari. Hari is the father of Isha. Isha is the sister of Jai. How is Gopal related to Jai?', 'Grandfather',
    [{ text: 'Father', code: GEN }, { text: 'Great-grandfather', code: GEN, why: 'This adds a generation: Gopal is only two generations above Jai.' }, { text: 'Grandmother', code: GENDER }],
    'Jai is Isha\'s sibling, so Jai is also Hari\'s child; Gopal is Hari\'s father and therefore Jai\'s grandfather.',
    { nudge: brNudge, strategy: brStrategy, step: 'Isha and Jai are siblings, both children of Hari.', near: 'Gopal is one generation above Hari.' }),
  written(BR, 'ADVANCED', 'Ravi is a boy. Ravi\'s father is Suresh\'s son. Suresh has only one child. How is Ravi related to Suresh?', 'Grandson',
    [{ text: 'Son', code: GEN }, { text: 'Nephew', code: ONLY }, { text: 'Brother' }],
    'Suresh\'s only child is his son, who is Ravi\'s father. So Ravi is Suresh\'s son\'s son: his grandson.',
    { nudge: brNudge, strategy: brStrategy, step: 'Suresh\'s only child is a son — Ravi\'s father.', near: 'Ravi is one generation below his father.' }),
  written(BR, 'INTERMEDIATE', 'Uday is Varun\'s brother. Wasim is Varun\'s father. Zoya is Wasim\'s sister. How is Zoya related to Uday?', 'Aunt',
    [{ text: 'Sister', code: GEN }, { text: 'Uncle', code: GENDER }, { text: 'Mother' }],
    'Uday and Varun are brothers, so Wasim is Uday\'s father too; Zoya is his father\'s sister: his aunt.',
    { nudge: brNudge, strategy: brStrategy, step: 'Wasim is the father of both Uday and Varun.', near: 'Zoya is Wasim\'s sister, one generation above Uday.' }),
  written(BR, 'ADVANCED', 'Pointing to a photograph, Meena says, "This is the only daughter of my father\'s father." How is the person in the photograph related to Meena?', 'Aunt',
    [{ text: 'Sister', code: GEN }, { text: 'Grandmother', code: GEN, why: 'The daughter of Meena\'s grandfather is one generation above Meena, not two.' }, { text: 'Mother' }],
    'The daughter of Meena\'s father\'s father is her father\'s sister: Meena\'s aunt.',
    { nudge: brNudge, strategy: brStrategy, step: 'Meena\'s father\'s father is her grandfather; his children are her father\'s generation.', near: 'His only daughter is Meena\'s father\'s sister.' }),
];

// ---------------------------------------------------------------------------
// Direction sense (computed)
// ---------------------------------------------------------------------------
const DS = 'apt-l-direction-sense';
const COMPASS = ['north', 'east', 'south', 'west'] as const;
type Heading = (typeof COMPASS)[number];
const turn = (facing: Heading, side: 'left' | 'right'): Heading => COMPASS[(COMPASS.indexOf(facing) + (side === 'right' ? 1 : 3)) % 4]!;
const flip = (side: 'left' | 'right'): 'left' | 'right' => (side === 'left' ? 'right' : 'left');
const cap = (word: string): string => `${word[0]!.toUpperCase()}${word.slice(1)}`;
const diagonal = (a: Heading, b: Heading): string => {
  const ns = [a, b].find((d) => d === 'north' || d === 'south')!;
  const ew = [a, b].find((d) => d === 'east' || d === 'west')!;
  return `${cap(ns)}-${ew}`;
};

const directions: Maker[] = [
  ...([[3, 'north', 4, 'east', 'Ravi'], [6, 'north', 8, 'east', 'Salma'], [5, 'south', 12, 'west', 'Tenzin']] as const).map(([a, d1, b, d2, name]) => (i: number): ItemSpec => ({
    key: itemKey(DS, i), difficulty: 'FOUNDATION',
    prompt: `${name} walks ${a} km ${d1}, then turns and walks ${b} km ${d2}. How far is ${name} from the starting point in a straight line?`,
    answer: `${num(Math.hypot(a, b))} km`,
    wrong: [
      { text: `${num(a + b)} km`, code: 'APT_L_DIR_PATH_AS_DISTANCE' },
      { text: `${num(Math.abs(b - a))} km` },
      { text: `${num(a * b)} km` },
    ],
    explanation: `The two legs are at right angles, so the distance is √(${a}² + ${b}²) = √${a * a + b * b} = ${num(Math.hypot(a, b))} km.`,
    hints: [
      'Sketch the walk: the two legs make a right angle.',
      'The straight-line distance is the hypotenuse of a right-angled triangle.',
      `${a}² + ${b}² = ${a * a + b * b}.`,
      `Take the square root of ${a * a + b * b}.`,
    ],
  })),
  (i) => ({
    key: itemKey(DS, i), difficulty: 'INTERMEDIATE',
    prompt: 'Farah walks 10 km north, then 6 km east, then 2 km south. How far is she from the starting point in a straight line?',
    answer: '10 km',
    wrong: [{ text: '18 km', code: 'APT_L_DIR_PATH_AS_DISTANCE' }, { text: '8 km' }, { text: '14 km' }],
    explanation: 'Net movement: 10 − 2 = 8 km north and 6 km east. √(8² + 6²) = √100 = 10 km.',
    hints: [
      'Combine the north and south legs first.',
      'Find the net north–south and east–west movement, then use the right-angled triangle.',
      'Net north is 10 − 2 = 8 km; net east is 6 km.',
      'Take √(8² + 6²).',
    ],
  }),
  ...([['north', ['right', 'right', 'left']], ['east', ['left', 'left', 'left']], ['south', ['right', 'left', 'right']], ['west', ['left', 'right', 'right']]] as const)
    .map(([start, turns]) => (i: number): ItemSpec => {
      const end = turns.reduce<Heading>((facing, side) => turn(facing, side), start);
      const flipped = turns.reduce<Heading>((facing, side) => turn(facing, flip(side)), start);
      const others = COMPASS.filter((d) => d !== end && d !== flipped);
      return {
        key: itemKey(DS, i), difficulty: 'INTERMEDIATE',
        prompt: `Facing ${start}, a person turns ${turns.join(', then ')}. Which direction is the person facing now?`,
        answer: cap(end),
        wrong: [{ text: cap(flipped), code: 'APT_L_DIR_TURN_REFERENCE' }, { text: cap(others[0]!) }, { text: cap(others[1]!) }],
        explanation: `Each right turn moves one step clockwise (north → east → south → west) and each left turn one step anticlockwise: ${start} → ${turns.reduce<Heading[]>((path, side) => [...path, turn(path[path.length - 1]!, side)], [start]).slice(1).join(' → ')}.`,
        hints: [
          'Left and right are from the person\'s own point of view.',
          'A right turn is a quarter turn clockwise; a left turn is a quarter turn anticlockwise.',
          `After the first two turns (${turns[0]}, then ${turns[1]}) the person faces ${turn(turn(start, turns[0]), turns[1])}.`,
          `Now apply the last turn (${turns[2]}) to ${turn(turn(start, turns[0]), turns[1])}.`,
        ],
      };
    }),
  ...([['east', 'left', 'Deepa'], ['north', 'right', 'Imran'], ['west', 'left', 'Joseph'], ['south', 'right', 'Harpreet']] as const).map(([first, side, name]) => (i: number): ItemSpec => {
    const second = turn(first, side);
    const wrongSecond = turn(first, flip(side));
    return {
      key: itemKey(DS, i), difficulty: 'FOUNDATION',
      prompt: `${name} walks 5 km ${first}, turns ${side} and walks 5 km. In which direction is ${name} now from the starting point?`,
      answer: diagonal(first, second),
      wrong: [
        { text: diagonal(first, wrongSecond), code: 'APT_L_DIR_TURN_REFERENCE' },
        { text: cap(second) },
        { text: cap(first) },
      ],
      explanation: `Facing ${first}, a ${side} turn faces ${second}. The two equal legs put ${name} ${diagonal(first, second).toLowerCase()} of the start.`,
      hints: [
        'Left and right are from the walker\'s own point of view.',
        'Work out which way the walker faces after the turn, then combine the two legs.',
        `Facing ${first}, a ${side} turn means facing ${second}.`,
        `The walker has gone ${first} and then ${second} by equal amounts.`,
      ],
    };
  }),
];

// ---------------------------------------------------------------------------
// Syllogisms
// ---------------------------------------------------------------------------
const SY = 'apt-l-syllogisms';
const syNudge = 'Use only what the statements say, even if it seems untrue in real life.';
const syStrategy = 'Draw circles for each group as the statements describe, and keep a conclusion only if it holds in every possible drawing.';
const CONV = 'APT_L_SYL_CONVERSE';
const SOMENOT = 'APT_L_SYL_SOME_NOT_ASSUMED';
const UNLINKED = 'APT_L_SYL_UNLINKED_TERMS';
const OUTSIDE = 'APT_L_SYL_OUTSIDE_KNOWLEDGE';
const syllogisms: Maker[] = [
  written(SY, 'FOUNDATION', 'Statements: All roses are flowers. All flowers are plants. Which conclusion definitely follows?', 'All roses are plants',
    [{ text: 'All plants are roses', code: CONV }, { text: 'Some plants are not flowers', code: SOMENOT, why: 'The statements never say that any plant is outside the flowers.' }, { text: 'No rose is a plant' }],
    'The roses circle lies inside the flowers circle, which lies inside the plants circle, so every rose is a plant.',
    { nudge: syNudge, strategy: syStrategy, step: 'Roses sit inside flowers, and flowers sit inside plants.', near: 'Where does that put the roses relative to the plants?' }),
  written(SY, 'INTERMEDIATE', 'Statements: All cats are animals. Some animals are pets. Which conclusion definitely follows?', 'Some animals are cats',
    [{ text: 'Some cats are pets', code: UNLINKED }, { text: 'All animals are cats', code: CONV }, { text: 'No cat is a pet' }],
    'Since every cat is an animal, some animals are cats. Whether cats are pets is not settled: the pets may be other animals.',
    { nudge: syNudge, strategy: syStrategy, step: 'Cats are inside animals; pets overlap animals somewhere.', near: 'Can you draw the pets so they miss the cats entirely? If so, "some cats are pets" does not definitely follow.' }),
  written(SY, 'FOUNDATION', 'Statement: Some teachers are writers. Which conclusion definitely follows?', 'Some writers are teachers',
    [{ text: 'Some teachers are not writers', code: SOMENOT }, { text: 'All writers are teachers', code: CONV }, { text: 'No teacher is a writer' }],
    '"Some teachers are writers" means at least one person is both, so at least one writer is a teacher.',
    { nudge: syNudge, strategy: syStrategy, step: 'At least one person is both a teacher and a writer.', near: 'Read that same person from the writers\' side.' }),
  written(SY, 'INTERMEDIATE', 'Statements: No fish is a mammal. All whales are mammals. Which conclusion definitely follows?', 'No whale is a fish',
    [{ text: 'Some fish are whales', code: UNLINKED }, { text: 'All mammals are whales', code: CONV }, { text: 'Some mammals are not whales', code: SOMENOT }],
    'Whales sit inside mammals, and mammals share nothing with fish, so no whale is a fish.',
    { nudge: syNudge, strategy: syStrategy, step: 'The fish circle and the mammals circle do not touch.', near: 'The whales circle is inside the mammals circle.' }),
  written(SY, 'INTERMEDIATE', 'Statements: All engineers are graduates. Some graduates are artists. Which conclusion definitely follows?', 'Some graduates are engineers',
    [{ text: 'Some engineers are artists', code: UNLINKED }, { text: 'All graduates are engineers', code: CONV }, { text: 'Some artists are not graduates' }],
    'Every engineer is a graduate, so some graduates are engineers. The artists who are graduates need not be engineers.',
    { nudge: syNudge, strategy: syStrategy, step: 'Engineers are inside graduates; artists overlap graduates somewhere.', near: 'Could the artists overlap only the non-engineer graduates?' }),
  written(SY, 'FOUNDATION', 'Statements: All pens are blue. All blue things are bright. Which conclusion definitely follows?', 'All pens are bright',
    [{ text: 'All bright things are pens', code: CONV }, { text: 'Some blue things are not pens', code: SOMENOT }, { text: 'No pen is bright' }],
    'Pens are inside blue things, which are inside bright things, so every pen is bright.',
    { nudge: syNudge, strategy: syStrategy, step: 'Pens sit inside blue things; blue things sit inside bright things.', near: 'Where are the pens relative to bright things?' }),
  written(SY, 'ADVANCED', 'Statements: Some doctors are singers. Some singers are dancers. Which conclusion definitely follows?', 'None of the other three conclusions follows',
    [{ text: 'Some doctors are dancers', code: UNLINKED }, { text: 'Some singers are not doctors', code: SOMENOT }, { text: 'All dancers are singers', code: CONV }],
    'The doctors and the dancers may overlap different singers, every singer may be a doctor, and dancers may exist who are not singers — so none of the three follows.',
    { nudge: syNudge, strategy: syStrategy, step: 'Doctors overlap singers, and dancers overlap singers — possibly in different places.', near: 'For each conclusion, try to draw a picture in which it is false while both statements hold.' }),
  written(SY, 'ADVANCED', 'Statements: No stone is a tree. Some trees are tall. Which conclusion definitely follows?', 'Some tall things are not stones',
    [{ text: 'No stone is tall', code: UNLINKED }, { text: 'All tall things are trees', code: CONV }, { text: 'Some stones are tall' }],
    'The tall trees are trees, and no tree is a stone, so those tall things are not stones. Nothing is said about stones being tall or not.',
    { nudge: syNudge, strategy: syStrategy, step: 'Some tall things are trees, and trees never overlap stones.', near: 'What can you say about those particular tall things?' }),
  written(SY, 'FOUNDATION', 'Statement: All squares are rectangles. Which conclusion definitely follows?', 'Some rectangles are squares',
    [{ text: 'All rectangles are squares', code: CONV }, { text: 'Some rectangles are not squares', code: SOMENOT }, { text: 'No square is a rectangle' }],
    'Every square is a rectangle, so at least some rectangles are squares. The statement alone does not say that any rectangle is not a square.',
    { nudge: syNudge, strategy: syStrategy, step: 'The squares circle sits inside the rectangles circle.', near: 'Read it from the rectangles\' side — carefully, using only the statement.' },
    'Uses the convention that "all A are B" implies "some B are A". The distractor "some rectangles are not squares" is true in geometry but does not follow from the statement alone — check the item makes that clear enough.'),
  written(SY, 'INTERMEDIATE', 'Statements: All managers are employees. No employee is a contractor. Which conclusion definitely follows?', 'No manager is a contractor',
    [{ text: 'Some contractors are managers', code: UNLINKED }, { text: 'All employees are managers', code: CONV }, { text: 'Some employees are not managers', code: SOMENOT }],
    'Managers are inside employees and employees share nothing with contractors, so no manager is a contractor.',
    { nudge: syNudge, strategy: syStrategy, step: 'Managers sit inside employees; employees and contractors do not overlap.', near: 'Can a manager be a contractor?' }),
  written(SY, 'INTERMEDIATE', 'Statements: Some books are novels. All novels are stories. Which conclusion definitely follows?', 'Some books are stories',
    [{ text: 'All stories are novels', code: CONV }, { text: 'All books are stories' }, { text: 'Some books are not novels', code: SOMENOT }],
    'The books that are novels are stories, so some books are stories.',
    { nudge: syNudge, strategy: syStrategy, step: 'Some books are novels, and novels sit inside stories.', near: 'What are those particular books?' }),
  written(SY, 'ADVANCED', 'Statements: All birds can fly. Penguins are birds. Which conclusion definitely follows from the statements?', 'According to the statements, penguins can fly',
    [{ text: 'Penguins cannot fly, so the statements are false', code: OUTSIDE }, { text: 'All things that fly are birds', code: CONV }, { text: 'Some birds are not penguins', code: SOMENOT }],
    'In a syllogism the statements are taken as true. Penguins are birds and all birds can fly, so by the statements penguins can fly.',
    { nudge: syNudge, strategy: syStrategy, step: 'Penguins sit inside birds; birds sit inside things that can fly.', near: 'Follow the statements, not what you know about real penguins.' }),
];

// ---------------------------------------------------------------------------
// Ordering and ranking
// ---------------------------------------------------------------------------
const OR = 'apt-l-ordering-ranking';
const RANK = 'APT_L_RANK_OFF_BY_ONE';
const FLIP = 'APT_L_ORDER_DIRECTION_FLIP';
const ordering: Maker[] = [
  ...([[7, 12, 'Asha'], [10, 15, 'Bhavna'], [5, 9, 'Chetan'], [14, 6, 'Dinesh']] as const).map(([left, right, name]) => (i: number): ItemSpec => ({
    key: itemKey(OR, i), difficulty: 'FOUNDATION',
    prompt: `In a row of people, ${name} is ${ordinal(left)} from the left and ${ordinal(right)} from the right. How many people are in the row?`,
    answer: num(left + right - 1),
    wrong: [{ text: num(left + right), code: RANK }, { text: num(left + right - 2) }, { text: num(Math.abs(left - right)) }],
    explanation: `Counting from both ends counts ${name} twice: ${left} + ${right} − 1 = ${left + right - 1}.`,
    hints: [
      'The person being described is counted from both ends.',
      'Add the two positions and correct for anyone counted twice.',
      `There are ${left - 1} people to ${name}'s left and ${right - 1} to the right.`,
      `Add those two numbers and then add ${name}.`,
    ],
  })),
  ...([[40, 11, 'Esha'], [35, 8, 'Farhan'], [50, 20, 'Gauri'], [28, 10, 'Hemant']] as const).map(([total, top, name]) => (i: number): ItemSpec => ({
    key: itemKey(OR, i), difficulty: 'FOUNDATION',
    prompt: `In a class of ${total} students, ${name} is ${ordinal(top)} from the top. What is ${name}'s position from the bottom?`,
    answer: ordinal(total - top + 1),
    wrong: [{ text: ordinal(total - top), code: RANK }, { text: ordinal(total - top + 2), code: RANK }, { text: ordinal(top) }],
    explanation: `${top - 1} students are above ${name}, so ${total} − ${top - 1} = ${total - top + 1} counts ${name} and everyone below: ${ordinal(total - top + 1)} from the bottom.`,
    hints: [
      'Count how many students are below, then include the student.',
      'Position from bottom = total − position from top + 1.',
      `${total} − ${top} = ${total - top} students are below ${name}.`,
      `Add 1 for ${name}.`,
    ],
  })),
  written(OR, 'INTERMEDIATE', 'Five friends sit in a row facing north. Pooja is at the left end. Tarun is at the right end. Sanjay sits between Pooja and Qadir. Ramesh sits immediately to the right of Qadir. Who sits in the middle?', 'Qadir',
    [{ text: 'Ramesh', code: FLIP, why: 'This puts Ramesh to the left of Qadir.' }, { text: 'Sanjay' }, { text: 'Tarun' }],
    'From the left: Pooja, Sanjay, Qadir, Ramesh, Tarun. Qadir is third, in the middle.',
    { nudge: 'Draw five seats and fill the ends first.', strategy: 'Place the fixed clues, then the "between" and "immediately right of" clues.', step: 'Pooja is seat 1 and Tarun seat 5.', near: 'Sanjay is between Pooja and Qadir, and Ramesh is just to Qadir\'s right; fill seats 2 to 4.' }),
  written(OR, 'INTERMEDIATE', 'Five books — blue, red, green, yellow and black — stand in a row. The blue book is second from the left. The red book is immediately to the right of the blue book. The green book is at the right end. The yellow book is to the left of the blue book. Which book is fourth from the left?', 'The black book',
    [{ text: 'The red book', code: RANK, why: 'The red book is third from the left, one place before the answer.' }, { text: 'The green book' }, { text: 'The yellow book', code: FLIP }],
    'From the left: yellow, blue, red, then the only book not yet placed (black), then green. The fourth is black.',
    { nudge: 'Draw five places and fill what is fixed.', strategy: 'Place the blue book, then the books defined relative to it, then the end.', step: 'Blue is second, so yellow (left of blue) is first and red is third.', near: 'Green is fifth; which book is left for the fourth place?' }),
  written(OR, 'ADVANCED', 'Six people A, B, C, D, E and F stand in a queue facing a counter. A is first. D is immediately behind A. F is last. C is immediately ahead of F. B is ahead of E. Who is fourth in the queue?', 'E',
    [{ text: 'B', code: RANK }, { text: 'C', code: RANK, why: 'C is fifth, one place behind the answer.' }, { text: 'D' }],
    'Order: A, D, then B and E (B ahead of E), then C, F. So B is third and E is fourth.',
    { nudge: 'Write six numbered places.', strategy: 'Fill the fixed places, then the pairs, then the remaining two using the last clue.', step: 'A is 1, D is 2, F is 6 and C is 5.', near: 'B and E take places 3 and 4, with B ahead of E.' }),
  written(OR, 'INTERMEDIATE', 'Four runners finish a race. Kiran finishes after Mohan and before Lata. Nisha finishes before Mohan. Who finishes last?', 'Lata',
    [{ text: 'Nisha', code: FLIP, why: 'This reverses "before" and "after".' }, { text: 'Kiran', code: RANK }, { text: 'Mohan' }],
    'Nisha is before Mohan, Mohan before Kiran, Kiran before Lata: Nisha, Mohan, Kiran, Lata. Lata is last.',
    { nudge: '"Before" means finishing earlier.', strategy: 'Chain the clues into one order.', step: 'Mohan, then Kiran, then Lata.', near: 'Nisha comes before Mohan; who is at the end of the chain?' }),
];

// ---------------------------------------------------------------------------
// Analogies and classification
// ---------------------------------------------------------------------------
const AN = 'apt-l-analogy-classification';
const SURF = 'APT_L_ANALOGY_SURFACE_FEATURE';
const anNudge = 'Say the relationship in the first pair as a short sentence.';
const anStrategy = 'Test each option in the same sentence with the third word; keep the one that fits exactly.';
const clNudge = 'Look for one category that all but one of the items share.';
const clStrategy = 'Name the category precisely; a shared first letter, colour or shape is rarely it.';
const analogies: Maker[] = [
  written(AN, 'FOUNDATION', 'Doctor : Hospital :: Teacher : ?', 'School', [{ text: 'Student', code: SURF }, { text: 'Chalk' }, { text: 'Lesson' }],
    'A doctor works in a hospital; a teacher works in a school.',
    { nudge: anNudge, strategy: anStrategy, step: '"A doctor works in a hospital."', near: '"A teacher works in a ___": which option is a place of work?' }),
  written(AN, 'FOUNDATION', 'Puppy : Dog :: Calf : ?', 'Cow', [{ text: 'Kitten', code: SURF, why: 'A kitten is another young animal, but the pair is young animal to adult.' }, { text: 'Milk', code: SURF }, { text: 'Horse' }],
    'A puppy is a young dog; a calf is a young cow.',
    { nudge: anNudge, strategy: anStrategy, step: '"A puppy grows into a dog."', near: '"A calf grows into a ___."' }),
  written(AN, 'INTERMEDIATE', 'Author : Book :: Composer : ?', 'Symphony', [{ text: 'Orchestra', code: SURF }, { text: 'Conductor' }, { text: 'Audience' }],
    'An author creates a book; a composer creates a symphony.',
    { nudge: anNudge, strategy: anStrategy, step: '"An author writes a book."', near: '"A composer writes a ___": which option is something created?' }),
  written(AN, 'INTERMEDIATE', 'Thermometer : Temperature :: Barometer : ?', 'Pressure', [{ text: 'Weather', code: SURF }, { text: 'Mercury' }, { text: 'Humidity' }],
    'A thermometer measures temperature; a barometer measures (atmospheric) pressure.',
    { nudge: anNudge, strategy: anStrategy, step: '"A thermometer measures temperature."', near: '"A barometer measures ___."' }),
  written(AN, 'FOUNDATION', 'Pen : Write :: Knife : ?', 'Cut', [{ text: 'Sharp', code: SURF, why: 'Sharp describes the knife; the pair is a tool and what it is used to do.' }, { text: 'Kitchen', code: SURF }, { text: 'Fork' }],
    'A pen is used to write; a knife is used to cut.',
    { nudge: anNudge, strategy: anStrategy, step: '"A pen is used to write."', near: '"A knife is used to ___": which option is an action?' }),
  written(AN, 'INTERMEDIATE', 'Seed : Tree :: Egg : ?', 'Bird', [{ text: 'Nest', code: SURF }, { text: 'Shell' }, { text: 'Feather' }],
    'A seed grows into a tree; an egg hatches and grows into a bird.',
    { nudge: anNudge, strategy: anStrategy, step: '"A seed grows into a tree."', near: '"An egg grows into a ___."' }),
  written(AN, 'FOUNDATION', 'Which is the odd one out? Apple, Mango, Carrot, Banana', 'Carrot', [{ text: 'Banana', code: SURF, why: 'Its shape and colour stand out, but it is a fruit like the others.' }, { text: 'Mango' }, { text: 'Apple' }],
    'Apple, mango and banana are fruits; carrot is a vegetable.',
    { nudge: clNudge, strategy: clStrategy, step: 'Three of these are eaten as fruit.', near: 'Which one is a root vegetable?' }),
  written(AN, 'INTERMEDIATE', 'Which is the odd one out? 3, 5, 7, 9, 11', '9', [{ text: '11', code: SURF, why: '11 is the only two-digit number, but that is not the shared category.' }, { text: '3' }, { text: '7' }],
    '3, 5, 7 and 11 are prime; 9 = 3 × 3 is not.',
    { nudge: clNudge, strategy: clStrategy, step: 'All five numbers are odd, so that is not the category.', near: 'Which one has a factor other than 1 and itself?' }),
  written(AN, 'FOUNDATION', 'Which is the odd one out? Mercury, Venus, Moon, Mars', 'Moon', [{ text: 'Mercury', code: SURF, why: 'Mercury is also the name of a metal, but here all three others are planets.' }, { text: 'Venus' }, { text: 'Mars' }],
    'Mercury, Venus and Mars are planets; the Moon is a natural satellite.',
    { nudge: clNudge, strategy: clStrategy, step: 'Three of these orbit the Sun directly.', near: 'Which one orbits the Earth?' }),
  written(AN, 'INTERMEDIATE', 'Which is the odd one out? 121, 144, 169, 200', '200', [{ text: '121', code: SURF, why: '121 reads the same backwards, but it is a perfect square like 144 and 169.' }, { text: '144' }, { text: '169' }],
    '121 = 11², 144 = 12² and 169 = 13² are perfect squares; 200 is not.',
    { nudge: clNudge, strategy: clStrategy, step: '121, 144 and 169 are 11 × 11, 12 × 12 and 13 × 13.', near: 'Is 200 the square of a whole number?' }),
  written(AN, 'INTERMEDIATE', 'Which is the odd one out? Violin, Guitar, Flute, Sitar', 'Flute', [{ text: 'Sitar', code: SURF, why: 'The sitar has Indian origins, but it is a string instrument like the violin and guitar.' }, { text: 'Violin' }, { text: 'Guitar' }],
    'Violin, guitar and sitar are string instruments; the flute is a wind instrument.',
    { nudge: clNudge, strategy: clStrategy, step: 'Three of these make sound with strings.', near: 'Which one is played by blowing?' }),
  written(AN, 'INTERMEDIATE', 'Which is the odd one out? January, March, June, July', 'June', [{ text: 'July', code: SURF, why: 'July starts with J, but so do January and June; the category is the number of days.' }, { text: 'March' }, { text: 'January' }],
    'January, March and July have 31 days; June has 30.',
    { nudge: clNudge, strategy: clStrategy, step: 'Think about the number of days in each month.', near: 'Which month has 30 days?' }),
];

export const LOGICAL_ITEMS: readonly AptitudeItem[] = [
  ...skillItems(SE, series),
  ...skillItems(CD, coding),
  ...skillItems(BR, relations),
  ...skillItems(DS, directions),
  ...skillItems(SY, syllogisms),
  ...skillItems(OR, ordering),
  ...skillItems(AN, analogies),
];
