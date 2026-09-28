/**
 * Quantitative aptitude items (ENG-10): 13 skills, 12 items each.
 *
 * Why this exists: each skill has three item templates — a method written once, with its hint
 * ladder — and four rows of numbers. The answer, every distractor and the worked hint step are
 * computed from the numbers, so no answer is typed by hand; each distractor is the result of a
 * named misconception applied to the same numbers. Word problems use round, illustrative numbers
 * and describe no real person, shop or place. Original wording throughout.
 */
import type { AptitudeItem } from '../aptitude-bank.js';
import { authoringFor } from './skills.js';
import { buildItem, count, fraction, gcd, itemKey, lcm, num, percent, rawFraction, rupees, type ItemSpec } from './author.js';

type Maker = (index: number) => ItemSpec;

function skillItems(skill: string, makers: readonly Maker[]): AptitudeItem[] {
  const authoring = authoringFor(skill);
  return makers.map((make, index) => buildItem(authoring, make(index + 1)));
}

// ---------------------------------------------------------------------------
// Number properties
// ---------------------------------------------------------------------------
const NP = 'apt-q-number-properties';
const numberProperties: Maker[] = [
  ...[[12, 18], [8, 12], [15, 20], [14, 21]].map(([a, b]) => (i: number): ItemSpec => ({
    key: itemKey(NP, i), difficulty: 'FOUNDATION',
    prompt: `What is the least common multiple (LCM) of ${a} and ${b}?`,
    answer: num(lcm(a!, b!)),
    wrong: [
      { text: num(gcd(a!, b!)), code: 'APT_Q_HCF_LCM_SWAP' },
      { text: num(a! * b!), code: 'APT_Q_LCM_AS_PRODUCT' },
      { text: num(2 * lcm(a!, b!)) },
    ],
    explanation: `The LCM is the smallest number both ${a} and ${b} divide into. ${a} and ${b} share the factor ${gcd(a!, b!)}, so the LCM is ${a} × ${b} ÷ ${gcd(a!, b!)} = ${lcm(a!, b!)}.`,
    hints: [
      'You need a number that both numbers divide into — the smallest one.',
      'Write each number as a product of primes, or list the multiples of the larger number until the smaller one divides it.',
      `The multiples of ${Math.max(a!, b!)} are ${[1, 2, 3, 4].map((k) => k * Math.max(a!, b!)).join(', ')}, …`,
      `Check which of the multiples of ${Math.max(a!, b!)} is the first that ${Math.min(a!, b!)} divides exactly.`,
    ],
  })),
  ...[[36, 48], [24, 60], [45, 75], [18, 42]].map(([a, b]) => (i: number): ItemSpec => {
    const h = gcd(a!, b!);
    const smaller = [2, 3, 5].map((p) => h / p).find((c) => Number.isInteger(c) && c > 1 && a! % c === 0 && b! % c === 0)!;
    return {
      key: itemKey(NP, i), difficulty: 'FOUNDATION',
      prompt: `What is the highest common factor (HCF) of ${a} and ${b}?`,
      answer: num(h),
      wrong: [
        { text: num(lcm(a!, b!)), code: 'APT_Q_HCF_LCM_SWAP' },
        { text: num(smaller), code: 'APT_Q_HCF_ANY_COMMON_FACTOR' },
        { text: num(h * 2) },
      ],
      explanation: `The HCF is the largest number that divides both. ${a} = ${h} × ${a! / h} and ${b} = ${h} × ${b! / h}, and ${a! / h} and ${b! / h} share no factor, so the HCF is ${h}.`,
      hints: [
        'You need the largest number that divides both numbers exactly.',
        'Write both numbers as products of primes and multiply the primes they share.',
        `${smaller} divides both ${a} and ${b}. Is there a larger number that also does?`,
        `Divide both numbers by ${smaller}: you get ${a! / smaller} and ${b! / smaller}. If these still share a factor, multiply it into ${smaller}.`,
      ],
    };
  }),
  ...[[4, 6, 10], [6, 8, 12], [9, 12, 15], [5, 6, 8]].map(([a, b, c]) => (i: number): ItemSpec => {
    const l = lcm(lcm(a!, b!), c!);
    const h = gcd(gcd(a!, b!), c!);
    return {
      key: itemKey(NP, i), difficulty: 'INTERMEDIATE',
      prompt: `Three lights flash every ${a}, ${b} and ${c} seconds. They have just flashed together. After how many seconds will they next flash together?`,
      answer: count(l, 'second'),
      wrong: [
        { text: count(h, 'second'), code: 'APT_Q_HCF_LCM_SWAP' },
        { text: count(a! * b! * c!, 'second'), code: 'APT_Q_LCM_AS_PRODUCT' },
        { text: count(a! + b! + c!, 'second') },
      ],
      explanation: `They flash together at a time that is a multiple of ${a}, ${b} and ${c}. The first such time is the LCM: ${l} seconds.`,
      hints: [
        'Each light flashes at multiples of its own interval. When are all three at a multiple at once?',
        'Find the least common multiple of the three intervals.',
        `The LCM of ${a} and ${b} is ${lcm(a!, b!)}. Now include ${c}.`,
        `Find the smallest multiple of ${lcm(a!, b!)} that ${c} also divides.`,
      ],
    };
  }),
];

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------
const AR = 'apt-q-arithmetic-operations';
const arithmetic: Maker[] = [
  ...[[6, 4, 5], [8, 3, 7], [12, 2, 9], [5, 6, 4]].map(([a, b, c]) => (i: number): ItemSpec => ({
    key: itemKey(AR, i), difficulty: 'FOUNDATION',
    prompt: `Evaluate: ${a} + ${b} × ${c}`,
    answer: num(a! + b! * c!),
    wrong: [
      { text: num((a! + b!) * c!), code: 'APT_Q_LEFT_TO_RIGHT_ORDER' },
      { text: num(a! * b! + c!) },
      { text: num(a! + b! + c!) },
    ],
    explanation: `Multiplication comes before addition: ${b} × ${c} = ${b! * c!}, then ${a} + ${b! * c!} = ${a! + b! * c!}.`,
    hints: [
      'Not every operation is done in the order it is written.',
      'Do multiplication and division before addition and subtraction.',
      `First work out ${b} × ${c} = ${b! * c!}.`,
      `Now add ${a} to ${b! * c!}.`,
    ],
  })),
  ...[[1, 2, 1, 3], [2, 3, 1, 4], [1, 4, 3, 8], [3, 5, 1, 10]].map(([p, q, r, s]) => (i: number): ItemSpec => {
    const top = p! * s! + r! * q!;
    const bottom = q! * s!;
    return {
      key: itemKey(AR, i), difficulty: i <= 6 ? 'FOUNDATION' : 'INTERMEDIATE',
      prompt: `What is ${p}/${q} + ${r}/${s}, in its simplest form?`,
      answer: fraction(top, bottom),
      wrong: [
        { text: rawFraction(p! + r!, q! + s!), code: 'APT_Q_FRACTION_ADD_ACROSS' },
        { text: rawFraction(p! + r!, q! * s!) },
        { text: fraction(p! * r!, q! * s!) },
      ],
      explanation: `Use a common denominator: ${p}/${q} = ${p! * s!}/${bottom} and ${r}/${s} = ${r! * q!}/${bottom}. Their sum is ${top}/${bottom} = ${fraction(top, bottom)}.`,
      hints: [
        'Fractions can only be added directly when they have the same denominator.',
        'Rewrite both fractions over a common denominator, then add the numerators.',
        `Over ${bottom}: ${p}/${q} = ${p! * s!}/${bottom} and ${r}/${s} = ${r! * q!}/${bottom}.`,
        `Add ${p! * s!} and ${r! * q!} over ${bottom}, then divide top and bottom by any common factor.`,
      ],
    };
  }),
  ...[
    ['0.4', '0.06', '0.024', '0.24', '0.0024', '2.4'],
    ['0.3', '0.05', '0.015', '0.15', '0.0015', '1.5'],
    ['1.2', '0.03', '0.036', '0.36', '0.0036', '3.6'],
    ['0.25', '0.4', '0.1', '1', '0.01', '10'],
  ].map(([x, y, answer, up, down, far]) => (i: number): ItemSpec => ({
    key: itemKey(AR, i), difficulty: 'INTERMEDIATE',
    prompt: `What is ${x} × ${y}?`,
    answer: answer!,
    wrong: [
      { text: up!, code: 'APT_Q_DECIMAL_PLACE_SHIFT', why: 'The digits are right but the product has one decimal place too few.' },
      { text: down!, code: 'APT_Q_DECIMAL_PLACE_SHIFT', why: 'The digits are right but the product has one decimal place too many.' },
      { text: far! },
    ],
    explanation: `Multiply as whole numbers, then place the decimal point: ${x} has ${x!.split('.')[1]!.length} decimal place(s) and ${y} has ${y!.split('.')[1]!.length}, so the product has ${x!.split('.')[1]!.length + y!.split('.')[1]!.length} before trailing zeros are dropped: ${answer}.`,
    hints: [
      'Ignore the decimal points for a moment and multiply the digits.',
      'The number of decimal places in the product is the total number in the two factors.',
      `${x} has ${x!.split('.')[1]!.length} decimal place(s) and ${y} has ${y!.split('.')[1]!.length}.`,
      `Multiply the digits, count ${x!.split('.')[1]!.length + y!.split('.')[1]!.length} places from the right, and drop any trailing zeros.`,
    ],
    check: `Answer computed by hand: ${x} × ${y} = ${answer}.`,
  })),
];

// ---------------------------------------------------------------------------
// Percentages
// ---------------------------------------------------------------------------
const PC = 'apt-q-percentages';
const percentages: Maker[] = [
  ...[10, 20, 30, 50].map((p) => (i: number): ItemSpec => ({
    key: itemKey(PC, i), difficulty: 'INTERMEDIATE',
    prompt: `The price of an item rises by ${p}% and then falls by ${p}%. What is the overall change in its price?`,
    answer: `A decrease of ${percent((p * p) / 100)}`,
    wrong: [
      { text: 'No change', code: 'APT_Q_PCT_SUCCESSIVE_ADDED' },
      { text: `An increase of ${percent((p * p) / 100)}` },
      { text: `A decrease of ${percent(p)}` },
    ],
    explanation: `A rise of ${p}% multiplies the price by ${1 + p / 100}; a fall of ${p}% multiplies it by ${1 - p / 100}. Together: ${num((1 + p / 100) * (1 - p / 100), 4)}, a decrease of ${percent((p * p) / 100)}.`,
    hints: [
      'The fall is a percentage of the new, higher price — not of the original.',
      'Turn each change into a multiplier and multiply them.',
      `Start with 100. After a ${p}% rise it is ${100 + p}.`,
      `Now take ${p}% off ${100 + p} and compare the result with 100.`,
    ],
  })),
  ...[[25, 15000], [20, 6000], [10, 5500], [50, 4500]].map(([p, now]) => (i: number): ItemSpec => {
    const before = now! / (1 + p! / 100);
    return {
      key: itemKey(PC, i), difficulty: 'INTERMEDIATE',
      prompt: `After a ${p}% increase, a monthly stipend is ${rupees(now!)}. What was it before the increase?`,
      answer: rupees(before),
      wrong: [
        { text: rupees(now! * (1 - p! / 100)), code: 'APT_Q_PCT_WRONG_BASE', why: `This takes ${p}% of the new amount, but the increase was ${p}% of the old amount.` },
        { text: rupees(now! * (1 + p! / 100)) },
        { text: rupees(before * (1 - p! / 100)) },
      ],
      explanation: `The new amount is ${100 + p!}% of the old one, so the old amount is ${rupees(now!)} ÷ ${1 + p! / 100} = ${rupees(before)}.`,
      hints: [
        'The increase was a percentage of the old amount, which you do not know yet.',
        `The new amount is (100 + ${p})% of the old amount; divide to undo it.`,
        `${rupees(now!)} is ${100 + p!}% of the old amount.`,
        `Divide ${rupees(now!)} by ${1 + p! / 100}, then check by adding ${p}% back.`,
      ],
    };
  }),
  ...[25, 50, 20, 60].map((x) => (i: number): ItemSpec => ({
    key: itemKey(PC, i), difficulty: 'ADVANCED',
    prompt: `A's salary is ${x}% more than B's. By what percentage is B's salary less than A's?`,
    answer: percent((100 * x) / (100 + x)),
    wrong: [
      { text: percent(x), code: 'APT_Q_PCT_WRONG_BASE', why: `This measures the difference against B's salary; "less than A's" measures it against A's.` },
      { text: percent(x / 2) },
      { text: percent(2 * x) },
    ],
    explanation: `Let B = 100, so A = ${100 + x}. The difference is ${x}, and against A that is ${x}/${100 + x} = ${percent((100 * x) / (100 + x))}.`,
    hints: [
      '"Less than A\'s" means the comparison is made against A.',
      'Pick a convenient value for B, work out A, then divide the difference by A.',
      `If B earns 100, A earns ${100 + x}; the difference is ${x}.`,
      `Express ${x} as a percentage of ${100 + x}.`,
    ],
  })),
];

// ---------------------------------------------------------------------------
// Ratio and proportion
// ---------------------------------------------------------------------------
const RP = 'apt-q-ratio-proportion';
const ratio: Maker[] = [
  ...[[3, 4, 24], [2, 3, 20], [5, 3, 40], [4, 5, 32]].map(([a, b, boys]) => (i: number): ItemSpec => ({
    key: itemKey(RP, i), difficulty: 'FOUNDATION',
    prompt: `In a class, the ratio of boys to girls is ${a}:${b}. There are ${boys} boys. How many students are in the class?`,
    answer: num((boys! * (a! + b!)) / a!),
    wrong: [
      { text: num((boys! * b!) / a!), code: 'APT_Q_RATIO_PART_AS_WHOLE' },
      { text: num(boys! + a! + b!) },
      { text: num(2 * boys!) },
    ],
    explanation: `${a} parts are ${boys} boys, so one part is ${boys! / a!}. The class has ${a} + ${b} = ${a! + b!} parts: ${a! + b!} × ${boys! / a!} = ${(boys! * (a! + b!)) / a!}.`,
    hints: [
      'The ratio splits the class into equal parts.',
      'Find the size of one part from the boys, then count all the parts.',
      `${boys} boys make ${a} parts, so one part is ${boys! / a!} students.`,
      `The whole class is ${a} + ${b} parts; multiply by ${boys! / a!}.`,
    ],
  })),
  ...[[6, 12, 8], [4, 18, 6], [10, 6, 15], [3, 12, 4]].map(([w, d, w2]) => (i: number): ItemSpec => ({
    key: itemKey(RP, i), difficulty: 'INTERMEDIATE',
    prompt: `${w} workers can paint a building in ${d} days. Working at the same rate, how many days would ${w2} workers take?`,
    answer: count((w! * d!) / w2!, 'day'),
    wrong: [
      { text: count((w2! * d!) / w!, 'day'), code: 'APT_Q_RATIO_INVERSE_AS_DIRECT' },
      { text: count(d! - (w2! - w!), 'day') },
      { text: count(d! * Math.abs(w2! - w!), 'day') },
    ],
    explanation: `The job takes ${w} × ${d} = ${w! * d!} worker-days. ${w2} workers need ${w! * d!} ÷ ${w2} = ${(w! * d!) / w2!} days.`,
    hints: [
      'More workers finish sooner: this is inverse proportion.',
      'Find the total work in worker-days, then share it among the new number of workers.',
      `The job is ${w} × ${d} = ${w! * d!} worker-days.`,
      `Divide ${w! * d!} worker-days by ${w2} workers.`,
    ],
  })),
  ...[[3, 4, 15], [2, 5, 8], [4, 5, 12], [5, 10, 15]].map(([a, b, c]) => (i: number): ItemSpec => ({
    key: itemKey(RP, i), difficulty: 'FOUNDATION',
    prompt: `If ${a} : ${b} = ${c} : x, what is x?`,
    answer: num((b! * c!) / a!),
    wrong: [
      { text: num(c! + (b! - a!)), code: 'APT_Q_RATIO_ADDITIVE_REASONING' },
      { text: num((a! * c!) / b!) },
      { text: num(b! * c!) },
    ],
    explanation: `${c} is ${a} multiplied by ${c! / a!}, so x is ${b} multiplied by ${c! / a!}: x = ${(b! * c!) / a!}.`,
    hints: [
      'Equal ratios scale both terms by the same factor.',
      'Find what the first term was multiplied by, and multiply the second term by the same.',
      `${a} × ${c! / a!} = ${c}.`,
      `Multiply ${b} by ${c! / a!}.`,
    ],
  })),
];

// ---------------------------------------------------------------------------
// Averages
// ---------------------------------------------------------------------------
const AV = 'apt-q-averages';
const averages: Maker[] = [
  ...[[5, 7, 9, 13, 21], [10, 20, 30, 60], [2, 3, 7, 8, 10], [15, 25, 35, 45, 80]].map((list) => (i: number): ItemSpec => {
    const sum = list.reduce((acc, value) => acc + value, 0);
    const sorted = [...list].sort((x, y) => x - y);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
    return {
      key: itemKey(AV, i), difficulty: 'FOUNDATION',
      prompt: `What is the mean of ${list.join(', ')}?`,
      answer: num(sum / list.length),
      wrong: [
        { text: num(sum / (list.length - 1)), code: 'APT_Q_AVG_WRONG_COUNT' },
        { text: num(median) },
        { text: num(sum) },
      ],
      explanation: `The total is ${sum} and there are ${list.length} values, so the mean is ${sum} ÷ ${list.length} = ${num(sum / list.length)}.`,
      hints: [
        'The mean shares the total equally among the values.',
        'Add the values, then divide by how many there are.',
        `The total is ${sum}.`,
        `Count the values and divide ${sum} by that count.`,
      ],
    };
  }),
  ...[[20, 60, 30, 70], [10, 50, 40, 80], [30, 40, 10, 80], [25, 72, 75, 64]].map(([n1, m1, n2, m2]) => (i: number): ItemSpec => {
    const combined = (n1! * m1! + n2! * m2!) / (n1! + n2!);
    return {
      key: itemKey(AV, i), difficulty: 'INTERMEDIATE',
      prompt: `Section A has ${n1} students with an average score of ${m1}. Section B has ${n2} students with an average score of ${m2}. What is the average score of all ${n1! + n2!} students?`,
      answer: num(combined),
      wrong: [
        { text: num((m1! + m2!) / 2), code: 'APT_Q_AVG_UNWEIGHTED' },
        { text: num((n2! * m1! + n1! * m2!) / (n1! + n2!)) },
        { text: num(Math.max(m1!, m2!)) },
      ],
      explanation: `Totals: ${n1} × ${m1} = ${n1! * m1!} and ${n2} × ${m2} = ${n2! * m2!}. Combined: ${n1! * m1! + n2! * m2!} ÷ ${n1! + n2!} = ${num(combined)}.`,
      hints: [
        'The larger section should count for more.',
        'Turn each average back into a total, add the totals, and divide by the number of students.',
        `Section A's total is ${n1! * m1!}; section B's is ${n2! * m2!}.`,
        `Divide ${n1! * m1! + n2! * m2!} by ${n1! + n2!}.`,
      ],
    };
  }),
  ...[[5, 20, 40], [6, 10, 30], [4, 25, 40], [7, 12, 42]].map(([n, m, x]) => (i: number): ItemSpec => ({
    key: itemKey(AV, i), difficulty: 'INTERMEDIATE',
    prompt: `The average of ${n} numbers is ${m}. One of them, ${x}, is removed. What is the average of the remaining numbers?`,
    answer: num((n! * m! - x!) / (n! - 1)),
    wrong: [
      { text: num((n! * m! - x!) / n!), code: 'APT_Q_AVG_WRONG_COUNT' },
      { text: num(m!) },
      { text: num(m! + x! / n!) },
    ],
    explanation: `The total was ${n} × ${m} = ${n! * m!}. Removing ${x} leaves ${n! * m! - x!} across ${n! - 1} numbers: ${num((n! * m! - x!) / (n! - 1))}.`,
    hints: [
      'Work with the total, not the average.',
      'Find the original total, take away the removed number, and divide by the new count.',
      `The original total is ${n! * m!}; without ${x} it is ${n! * m! - x!}.`,
      `There are now ${n! - 1} numbers; divide ${n! * m! - x!} by that.`,
    ],
  })),
];

// ---------------------------------------------------------------------------
// Profit, loss and discount
// ---------------------------------------------------------------------------
const PL = 'apt-q-profit-loss-discount';
const profitLoss: Maker[] = [
  ...[[400, 500], [250, 300], [120, 150], [150, 180]].map(([cp, sp]) => (i: number): ItemSpec => ({
    key: itemKey(PL, i), difficulty: 'FOUNDATION',
    prompt: `A book costs a shopkeeper ${rupees(cp!)} and is sold for ${rupees(sp!)}. What is the profit percentage?`,
    answer: percent((100 * (sp! - cp!)) / cp!),
    wrong: [
      { text: percent((100 * (sp! - cp!)) / sp!), code: 'APT_Q_PL_PROFIT_ON_SP' },
      { text: percent(sp! - cp!) },
      { text: percent((100 * sp!) / cp!) },
    ],
    explanation: `Profit is ${rupees(sp! - cp!)}; as a percentage of the cost price it is ${sp! - cp!}/${cp} × 100 = ${percent((100 * (sp! - cp!)) / cp!)}.`,
    hints: [
      'Profit percentage is measured against what the item cost.',
      'Find the profit in rupees, then divide by the cost price and multiply by 100.',
      `The profit is ${rupees(sp!)} − ${rupees(cp!)} = ${rupees(sp! - cp!)}.`,
      `Express ${sp! - cp!} as a percentage of ${cp}.`,
    ],
  })),
  ...[[1000, 10, 20], [2000, 20, 25], [500, 10, 10], [4000, 25, 20]].map(([m, d1, d2]) => (i: number): ItemSpec => {
    const price = m! * (1 - d1! / 100) * (1 - d2! / 100);
    return {
      key: itemKey(PL, i), difficulty: 'INTERMEDIATE',
      prompt: `A jacket is marked at ${rupees(m!)}. It is sold after a discount of ${d1}% followed by a further discount of ${d2}%. What is the selling price?`,
      answer: rupees(price),
      wrong: [
        { text: rupees(m! * (1 - (d1! + d2!) / 100)), code: 'APT_Q_PL_PERCENTS_ADDED' },
        { text: rupees(m! * (1 - Math.max(d1!, d2!) / 100)) },
        { text: rupees(m! - price) },
      ],
      explanation: `After ${d1}% off: ${rupees(m! * (1 - d1! / 100))}. Then ${d2}% off that: ${rupees(price)}.`,
      hints: [
        'The second discount is taken off the already reduced price.',
        'Apply the discounts one after the other as multipliers.',
        `After the first discount the price is ${rupees(m! * (1 - d1! / 100))}.`,
        `Take ${d2}% off ${rupees(m! * (1 - d1! / 100))}.`,
      ],
    };
  }),
  ...[[20, 10], [50, 20], [25, 20], [10, 20]].map(([up, off]) => (i: number): ItemSpec => {
    const factor = (1 + up! / 100) * (1 - off! / 100);
    const change = Math.round((factor - 1) * 10000) / 100;
    const describe = (value: number): string => (value === 0 ? 'Neither profit nor loss' : value > 0 ? `A profit of ${percent(value)}` : `A loss of ${percent(-value)}`);
    const added = up! - off!;
    return {
      key: itemKey(PL, i), difficulty: 'ADVANCED',
      prompt: `A trader marks goods ${up}% above the cost price and then gives a ${off}% discount on the marked price. What is the result on the cost price?`,
      answer: describe(change),
      wrong: [
        { text: describe(added === 0 ? 5 : added), code: 'APT_Q_PL_PERCENTS_ADDED', why: `This subtracts ${off} from ${up}, but the discount is ${off}% of the higher marked price.` },
        { text: describe(-change === 0 ? -5 : -change) },
        { text: describe(change === up! ? up! + 5 : up!) },
      ],
      explanation: `Take the cost as 100. Marked price: ${100 + up!}. After ${off}% off: ${num((100 + up!) * (1 - off! / 100))}. ${describe(change)}.`,
      hints: [
        'The discount is a percentage of the marked price, not of the cost.',
        'Assume a cost of 100 and follow the price through both steps.',
        `With a cost of 100, the marked price is ${100 + up!}.`,
        `Take ${off}% off ${100 + up!} and compare with 100.`,
      ],
    };
  }),
];

// ---------------------------------------------------------------------------
// Interest
// ---------------------------------------------------------------------------
const IN = 'apt-q-interest';
const interest: Maker[] = [
  ...[[5000, 8, 3], [2000, 5, 4], [8000, 6, 2], [1500, 10, 3]].map(([p, r, t]) => (i: number): ItemSpec => {
    const si = (p! * r! * t!) / 100;
    return {
      key: itemKey(IN, i), difficulty: 'FOUNDATION',
      prompt: `What is the simple interest on ${rupees(p!)} at ${r}% per annum for ${t} years?`,
      answer: rupees(si),
      wrong: [
        { text: rupees(p! + si), code: 'APT_Q_INTEREST_VS_AMOUNT' },
        { text: rupees((p! * r!) / 100) },
        { text: rupees(si / 10) },
      ],
      explanation: `Simple interest = principal × rate × time ÷ 100 = ${p} × ${r} × ${t} ÷ 100 = ${rupees(si)}.`,
      hints: [
        'Simple interest is the same every year and is earned on the principal only.',
        'Use principal × rate × time ÷ 100.',
        `One year's interest is ${rupees((p! * r!) / 100)}.`,
        `Multiply one year's interest by ${t}.`,
      ],
    };
  }),
  ...[[6000, 10, 9], [12000, 5, 6], [4000, 12, 3], [9000, 8, 4]].map(([p, r, months]) => (i: number): ItemSpec => {
    const si = (p! * r! * months!) / 1200;
    return {
      key: itemKey(IN, i), difficulty: 'INTERMEDIATE',
      prompt: `What is the simple interest on ${rupees(p!)} at ${r}% per annum for ${months} months?`,
      answer: rupees(si),
      wrong: [
        { text: rupees((p! * r! * months!) / 100), code: 'APT_Q_SI_TIME_UNITS' },
        { text: rupees(p! + si), code: 'APT_Q_INTEREST_VS_AMOUNT' },
        { text: rupees((p! * r!) / 100) },
      ],
      explanation: `The rate is per year, so ${months} months is ${months}/12 of a year: ${p} × ${r} × ${months}/12 ÷ 100 = ${rupees(si)}.`,
      hints: [
        'The rate is per annum; check the unit of the time.',
        'Convert the months into a fraction of a year before using the formula.',
        `${months} months is ${fraction(months!, 12)} of a year; one year's interest is ${rupees((p! * r!) / 100)}.`,
        `Take ${fraction(months!, 12)} of ${rupees((p! * r!) / 100)}.`,
      ],
    };
  }),
  ...[[10000, 10], [5000, 20], [8000, 5], [20000, 10]].map(([p, r]) => (i: number): ItemSpec => {
    const ci = p! * ((1 + r! / 100) ** 2 - 1);
    return {
      key: itemKey(IN, i), difficulty: 'INTERMEDIATE',
      prompt: `What is the compound interest on ${rupees(p!)} at ${r}% per annum for 2 years, compounded annually?`,
      answer: rupees(ci),
      wrong: [
        { text: rupees((2 * p! * r!) / 100), code: 'APT_Q_CI_AS_SI' },
        { text: rupees(p! + ci), code: 'APT_Q_INTEREST_VS_AMOUNT' },
        { text: rupees((p! * r!) / 100) },
      ],
      explanation: `Year 1: ${rupees((p! * r!) / 100)} interest, giving ${rupees(p! * (1 + r! / 100))}. Year 2: ${r}% of that is ${rupees(p! * (1 + r! / 100) * r! / 100)}. Total interest: ${rupees(ci)}.`,
      hints: [
        'In the second year, interest is also earned on the first year\'s interest.',
        'Work year by year, or use principal × (1 + rate/100)² and subtract the principal.',
        `After one year the amount is ${rupees(p! * (1 + r! / 100))}.`,
        `Add ${r}% of ${rupees(p! * (1 + r! / 100))}, then subtract the original ${rupees(p!)}.`,
      ],
    };
  }),
];

// ---------------------------------------------------------------------------
// Time and work
// ---------------------------------------------------------------------------
const TW = 'apt-q-time-work';
const timeWork: Maker[] = [
  ...[[12, 6], [10, 15], [20, 30], [12, 24]].map(([a, b]) => (i: number): ItemSpec => ({
    key: itemKey(TW, i), difficulty: 'FOUNDATION',
    prompt: `Asha can finish a task in ${a} days and Bina can finish it in ${b} days. How many days will they take working together?`,
    answer: count((a! * b!) / (a! + b!), 'day'),
    wrong: [
      { text: count(a! + b!, 'day'), code: 'APT_Q_TW_COMBINES_TIMES' },
      { text: count((a! + b!) / 2, 'day'), code: 'APT_Q_TW_AVERAGES_TIMES' },
      { text: count(Math.abs(a! - b!) || a! / 3, 'day') },
    ],
    explanation: `Per day they do 1/${a} + 1/${b} = ${fraction(a! + b!, a! * b!)} of the task, so together they take ${num((a! * b!) / (a! + b!))} days.`,
    hints: [
      'Working together must be quicker than either one alone.',
      'Add the fractions of the task each does in one day.',
      `In one day Asha does 1/${a} and Bina does 1/${b} of the task.`,
      `Add 1/${a} and 1/${b}, then turn the sum upside down to get the days.`,
    ],
  })),
  ...[[4, 6], [6, 10], [10, 15], [8, 12]].map(([t, a]) => (i: number): ItemSpec => ({
    key: itemKey(TW, i), difficulty: 'INTERMEDIATE',
    prompt: `Two machines together print a batch in ${t} hours. The first machine alone takes ${a} hours. How long would the second machine take alone?`,
    answer: count((a! * t!) / (a! - t!), 'hour'),
    wrong: [
      { text: count(a! - t!, 'hour'), code: 'APT_Q_TW_COMBINES_TIMES' },
      { text: count(2 * t!, 'hour') },
      { text: count(a! + t!, 'hour') },
    ],
    explanation: `Together they do 1/${t} per hour and the first does 1/${a}, so the second does 1/${t} − 1/${a} = ${fraction(a! - t!, a! * t!)} per hour: ${num((a! * t!) / (a! - t!))} hours alone.`,
    hints: [
      'Subtract rates, not times.',
      'The second machine\'s hourly rate is the joint rate minus the first machine\'s rate.',
      `The joint rate is 1/${t} of the batch per hour; the first machine's is 1/${a}.`,
      `Work out 1/${t} − 1/${a} and turn it upside down.`,
    ],
  })),
  ...[[4, 6], [6, 10], [8, 12], [10, 15]].map(([fill, empty]) => (i: number): ItemSpec => ({
    key: itemKey(TW, i), difficulty: 'ADVANCED',
    prompt: `Pipe A fills a tank in ${fill} hours. Pipe B empties the full tank in ${empty} hours. If both are opened when the tank is empty, how long will it take to fill?`,
    answer: count((fill! * empty!) / (empty! - fill!), 'hour'),
    wrong: [
      { text: count((fill! * empty!) / (fill! + empty!), 'hour'), code: 'APT_Q_TW_OUTFLOW_AS_INFLOW' },
      { text: count(empty! - fill!, 'hour'), code: 'APT_Q_TW_COMBINES_TIMES' },
      { text: count(fill! + empty!, 'hour') },
    ],
    explanation: `Per hour the tank gains 1/${fill} − 1/${empty} = ${fraction(empty! - fill!, fill! * empty!)}, so it fills in ${num((fill! * empty!) / (empty! - fill!))} hours.`,
    hints: [
      'Pipe B works against pipe A.',
      'Subtract the emptying rate from the filling rate.',
      `Per hour A adds 1/${fill} of the tank and B removes 1/${empty}.`,
      `Work out 1/${fill} − 1/${empty} and turn it upside down.`,
    ],
  })),
];

// ---------------------------------------------------------------------------
// Time, speed and distance
// ---------------------------------------------------------------------------
const TS = 'apt-q-time-speed-distance';
const timeSpeed: Maker[] = [
  ...[[40, 60], [30, 60], [20, 30], [60, 90]].map(([v1, v2]) => (i: number): ItemSpec => ({
    key: itemKey(TS, i), difficulty: 'INTERMEDIATE',
    prompt: `A cyclist rides from one village to another at ${v1} km/h and returns along the same road at ${v2} km/h. What is the average speed for the whole journey?`,
    answer: `${num((2 * v1! * v2!) / (v1! + v2!))} km/h`,
    wrong: [
      { text: `${num((v1! + v2!) / 2)} km/h`, code: 'APT_Q_TSD_AVERAGE_OF_SPEEDS' },
      { text: `${num(v1! + v2!)} km/h` },
      { text: `${num((v1! * v2!) / (v1! + v2!))} km/h` },
    ],
    explanation: `Average speed is total distance over total time. For a distance d each way: 2d ÷ (d/${v1} + d/${v2}) = ${num((2 * v1! * v2!) / (v1! + v2!))} km/h.`,
    hints: [
      'More time is spent at the slower speed, so the answer is not the midpoint.',
      'Average speed = total distance ÷ total time. Choose a convenient distance.',
      `Say the road is ${lcm(v1!, v2!)} km: out takes ${lcm(v1!, v2!) / v1!} h, back takes ${lcm(v1!, v2!) / v2!} h.`,
      `Divide ${2 * lcm(v1!, v2!)} km by ${lcm(v1!, v2!) / v1! + lcm(v1!, v2!) / v2!} h.`,
    ],
  })),
  ...[72, 54, 90, 36].map((kmh) => (i: number): ItemSpec => ({
    key: itemKey(TS, i), difficulty: 'FOUNDATION',
    prompt: `Express ${kmh} km/h in metres per second.`,
    answer: `${num(kmh / 3.6)} m/s`,
    wrong: [
      { text: `${num(kmh * 3.6)} m/s`, code: 'APT_Q_TSD_UNIT_CONVERSION' },
      { text: `${num(kmh / 10)} m/s` },
      { text: `${num(kmh / 2)} m/s` },
    ],
    explanation: `1 km/h = 1000 m ÷ 3600 s = 5/18 m/s, so ${kmh} km/h = ${kmh} × 5/18 = ${num(kmh / 3.6)} m/s.`,
    hints: [
      'A metre per second is faster than a kilometre per hour, so the number should get smaller.',
      'Multiply km/h by 1000/3600, which is 5/18.',
      `${kmh} ÷ 18 = ${num(kmh / 18)}.`,
      `Multiply ${num(kmh / 18)} by 5.`,
    ],
  })),
  ...[[72, 200, 300], [54, 120, 330], [36, 150, 250], [90, 200, 300]].map(([kmh, train, platform]) => (i: number): ItemSpec => {
    const mps = kmh! / 3.6;
    return {
      key: itemKey(TS, i), difficulty: 'ADVANCED',
      prompt: `A train ${train} m long runs at ${kmh} km/h. How long does it take to pass completely through a platform ${platform} m long?`,
      answer: count((train! + platform!) / mps, 'second'),
      wrong: [
        { text: count(train! / mps, 'second'), code: 'APT_Q_TSD_IGNORES_LENGTH', why: 'This covers only the train\'s own length.' },
        { text: count(platform! / mps, 'second'), code: 'APT_Q_TSD_IGNORES_LENGTH', why: 'This covers only the platform\'s length.' },
        { text: count((platform! - train!) / mps, 'second') },
      ],
      explanation: `To clear the platform the train covers its own length plus the platform: ${train! + platform!} m. At ${kmh} km/h = ${num(mps)} m/s that takes ${num((train! + platform!) / mps)} seconds.`,
      hints: [
        'The train has passed completely only when its last carriage leaves the platform.',
        'Distance = train length + platform length; convert the speed to m/s.',
        `The distance is ${train! + platform!} m and the speed is ${num(mps)} m/s.`,
        `Divide ${train! + platform!} by ${num(mps)}.`,
      ],
    };
  }),
];

// ---------------------------------------------------------------------------
// Mixtures and alligation
// ---------------------------------------------------------------------------
const MX = 'apt-q-mixtures-alligation';
const mixtures: Maker[] = [
  ...[[10, 20, 30, 40], [5, 40, 15, 20], [30, 10, 10, 50], [40, 25, 10, 50]].map(([q1, c1, q2, c2]) => (i: number): ItemSpec => ({
    key: itemKey(MX, i), difficulty: 'FOUNDATION',
    prompt: `${q1} litres of a ${c1}% salt solution are mixed with ${q2} litres of a ${c2}% salt solution. What is the salt concentration of the mixture?`,
    answer: percent((q1! * c1! + q2! * c2!) / (q1! + q2!)),
    wrong: [
      { text: percent((c1! + c2!) / 2), code: 'APT_Q_MIX_SIMPLE_AVERAGE' },
      { text: percent((q2! * c1! + q1! * c2!) / (q1! + q2!)) },
      { text: percent(c1! + c2!) },
    ],
    explanation: `Salt: ${q1! * c1! / 100} + ${q2! * c2! / 100} = ${(q1! * c1! + q2! * c2!) / 100} litres in ${q1! + q2!} litres, which is ${percent((q1! * c1! + q2! * c2!) / (q1! + q2!))}.`,
    hints: [
      'The larger quantity pulls the concentration towards its own strength.',
      'Work out the salt in each part, add, and divide by the total volume.',
      `The first part has ${q1! * c1! / 100} litres of salt; the second has ${q2! * c2! / 100}.`,
      `Divide ${(q1! * c1! + q2! * c2!) / 100} litres of salt by ${q1! + q2!} litres and express as a percentage.`,
    ],
  })),
  ...[[20, 35, 25], [30, 50, 45], [40, 60, 48], [12, 20, 15]].map(([cheap, dear, target]) => (i: number): ItemSpec => {
    const a = dear! - target!;
    const b = target! - cheap!;
    const g = gcd(a, b);
    const g2 = gcd(b, dear! - cheap!);
    return {
      key: itemKey(MX, i), difficulty: 'INTERMEDIATE',
      prompt: `In what ratio must rice costing ₹${cheap} per kg be mixed with rice costing ₹${dear} per kg to get a mixture worth ₹${target} per kg?`,
      answer: `${a / g} : ${b / g}`,
      wrong: [
        { text: `${b / g} : ${a / g}`, code: 'APT_Q_MIX_RATIO_REVERSED' },
        { text: '1 : 1' },
        { text: `${b / g2} : ${(dear! - cheap!) / g2}` },
      ],
      explanation: `Alligation: cheaper : dearer = (${dear} − ${target}) : (${target} − ${cheap}) = ${a} : ${b} = ${a / g} : ${b / g}. Check: ${a / g} kg at ₹${cheap} and ${b / g} kg at ₹${dear} average ₹${target}.`,
      hints: [
        'The mixture price is nearer the price of the rice used more.',
        'Each variety\'s share is the distance from the target to the other variety\'s price.',
        `The distances are ${dear} − ${target} = ${a} and ${target} − ${cheap} = ${b}.`,
        `The cheaper rice takes the ${a}; the dearer takes the ${b}. Simplify the ratio.`,
      ],
    };
  }),
  ...[[40, 4], [50, 5], [100, 10], [80, 20]].map(([v, x]) => (i: number): ItemSpec => ({
    key: itemKey(MX, i), difficulty: 'ADVANCED',
    prompt: `A container holds ${v} litres of milk. ${x} litres are taken out and replaced with water. This is done once more. How much milk is now in the container?`,
    answer: `${num(v! * (1 - x! / v!) ** 2)} litres`,
    wrong: [
      { text: `${num(v! - 2 * x!)} litres`, code: 'APT_Q_MIX_REPLACEMENT_LINEAR' },
      { text: `${num(v! - x!)} litres` },
      { text: `${num(v! - (x! * x!) / v!)} litres` },
    ],
    explanation: `Each replacement keeps ${v! - x!}/${v} of the milk: ${v} × (${v! - x!}/${v})² = ${num(v! * (1 - x! / v!) ** 2)} litres.`,
    hints: [
      'The second time, what is taken out is a mixture, not pure milk.',
      'Each replacement keeps the same fraction of the milk that was there.',
      `After the first replacement there are ${v! - x!} litres of milk, and the container is ${fraction(v! - x!, v!)} milk.`,
      `The second removal takes ${x} litres of which ${fraction(v! - x!, v!)} is milk; subtract that from ${v! - x!}.`,
    ],
  })),
];

// ---------------------------------------------------------------------------
// Linear equations
// ---------------------------------------------------------------------------
const LE = 'apt-q-linear-equations';
const linear: Maker[] = [
  ...[[3, 6, 21], [2, 7, 19], [4, 8, 36], [5, 3, 38]].map(([a, b, c]) => (i: number): ItemSpec => ({
    key: itemKey(LE, i), difficulty: 'FOUNDATION',
    prompt: `Solve for x: ${a}x + ${b} = ${c}`,
    answer: `x = ${num((c! - b!) / a!)}`,
    wrong: [
      { text: `x = ${num((c! + b!) / a!)}`, code: 'APT_Q_ALG_SIGN_ON_TRANSPOSE' },
      { text: `x = ${num(c! - b!)}`, code: 'APT_Q_ALG_INCOMPLETE_INVERSE' },
      { text: `x = ${num(c! / a! - b!)}`, code: 'APT_Q_ALG_DIVIDE_ONE_TERM' },
    ],
    explanation: `Subtract ${b} from both sides: ${a}x = ${c! - b!}. Divide by ${a}: x = ${num((c! - b!) / a!)}.`,
    hints: [
      'Undo the operations on x in reverse order.',
      `First remove the + ${b}, then the × ${a}.`,
      `Subtracting ${b} from both sides gives ${a}x = ${c! - b!}.`,
      `Divide ${c! - b!} by ${a}.`,
    ],
  })),
  ...[[30, 6], [50, 14], [40, 10], [64, 20]].map(([s, d]) => (i: number): ItemSpec => ({
    key: itemKey(LE, i), difficulty: 'FOUNDATION',
    prompt: `The sum of two numbers is ${s} and their difference is ${d}. What is the larger number?`,
    answer: num((s! + d!) / 2),
    wrong: [
      { text: num((s! - d!) / 2), code: 'APT_Q_ALG_WRONG_QUANTITY' },
      { text: num(s! + d!), code: 'APT_Q_ALG_INCOMPLETE_INVERSE' },
      { text: num(s! - d!) },
    ],
    explanation: `Larger + smaller = ${s} and larger − smaller = ${d}. Adding: 2 × larger = ${s! + d!}, so the larger is ${num((s! + d!) / 2)}.`,
    hints: [
      'Write the two facts as two equations.',
      'Adding the equations removes the smaller number.',
      `Adding gives 2 × larger = ${s} + ${d} = ${s! + d!}.`,
      `Halve ${s! + d!}.`,
    ],
  })),
  ...[[4, 5, 3], [5, 6, 3], [3, 15, 2], [4, 6, 3]].map(([k, n, m]) => (i: number): ItemSpec => {
    const son = (n! * (m! - 1)) / (k! - m!);
    return {
      key: itemKey(LE, i), difficulty: 'ADVANCED',
      prompt: `A mother is ${k} times as old as her son. In ${n} years she will be ${m} times as old as him. How old is the son now?`,
      answer: `${num(son)} years`,
      wrong: [
        { text: `${num(son + n!)} years`, code: 'APT_Q_ALG_WRONG_QUANTITY', why: 'This is the son\'s age in the future, not now.' },
        { text: `${num(k! * son)} years`, code: 'APT_Q_ALG_WRONG_QUANTITY', why: 'This is the mother\'s age, not the son\'s.' },
        { text: `${num(son === n! ? n! + 1 : n!)} years` },
      ],
      explanation: `Let the son be s. Then ${k}s + ${n} = ${m}(s + ${n}), so ${k}s − ${m}s = ${m! * n!} − ${n}, giving ${k! - m!}s = ${n! * (m! - 1)} and s = ${num(son)}.`,
      hints: [
        'Both ages grow by the same number of years.',
        'Let the son\'s age now be s, write both ages in the future, and use the "times as old" fact.',
        `Now: son s, mother ${k}s. In ${n} years: son s + ${n}, mother ${k}s + ${n}.`,
        `Solve ${k}s + ${n} = ${m}(s + ${n}) for s.`,
      ],
    };
  }),
];

// ---------------------------------------------------------------------------
// Data interpretation
// ---------------------------------------------------------------------------
const DI = 'apt-q-data-interpretation';
const TABLES: readonly { readonly label: string; readonly values: readonly [number, number, number, number]; readonly pctFrom: 0 | 1 | 2 }[] = [
  { label: 'bicycles sold by a shop', values: [100, 140, 190, 230], pctFrom: 1 },
  { label: 'visitors to a museum (hundreds)', values: [500, 600, 780, 1000], pctFrom: 0 },
  { label: 'trees planted by a club', values: [80, 120, 170, 200], pctFrom: 2 },
  { label: 'books lent by a library (hundreds)', values: [250, 300, 330, 390], pctFrom: 0 },
];
const YEARS = [2021, 2022, 2023, 2024] as const;

function tablePrompt(label: string, values: readonly number[], question: string): string {
  return `The table shows ${label} each year (illustrative figures).\n\n${YEARS.map((year, index) => `${year}: ${values[index]}`).join('\n')}\n\n${question}`;
}

const dataInterpretation: Maker[] = TABLES.flatMap((table) => {
  const v = table.values;
  const changes = [1, 2, 3].map((index) => ({ year: YEARS[index]!, abs: v[index]! - v[index - 1]!, rel: (v[index]! - v[index - 1]!) / v[index - 1]! }));
  const absYear = [...changes].sort((a, b) => b.abs - a.abs)[0]!.year;
  const relYear = [...changes].sort((a, b) => b.rel - a.rel)[0]!.year;
  const from = table.pctFrom;
  const change = v[from + 1]! - v[from]!;
  const yearOptions = (answer: number, other: number): ItemSpec['wrong'] => {
    const rest = [2022, 2023, 2024].filter((year) => year !== answer && year !== other);
    const wrong: { text: string; code?: string; why?: string }[] = [
      { text: String(other), code: 'APT_Q_DI_ABSOLUTE_VS_RELATIVE' },
      ...rest.map((year) => (year === 2024 ? { text: String(year), code: 'APT_Q_DI_LEVEL_VS_CHANGE' } : { text: String(year) })),
      { text: 'Cannot be determined from the table' },
    ];
    return wrong.slice(0, 3) as unknown as ItemSpec['wrong'];
  };
  const makers: Maker[] = [
    (i) => ({
      key: itemKey(DI, i), difficulty: 'FOUNDATION',
      prompt: tablePrompt(table.label, v, `What was the percentage increase from ${YEARS[from]} to ${YEARS[from + 1]}?`),
      answer: percent((100 * change) / v[from]!),
      wrong: [
        { text: percent((100 * change) / v[from + 1]!), code: 'APT_Q_DI_CHANGE_ON_LATER_VALUE' },
        { text: percent(change), code: 'APT_Q_DI_ABSOLUTE_VS_RELATIVE', why: `This reads the increase of ${change} units as ${change} percent.` },
        { text: percent((100 * v[from + 1]!) / v[from]!) },
      ],
      explanation: `The increase is ${v[from + 1]} − ${v[from]} = ${change}. Against the ${YEARS[from]} value: ${change}/${v[from]} = ${percent((100 * change) / v[from]!)}.`,
      hints: [
        'A percentage increase is measured against the starting year.',
        'Divide the change by the earlier value and multiply by 100.',
        `The change is ${change}; the earlier value is ${v[from]}.`,
        `Express ${change} as a percentage of ${v[from]}.`,
      ],
    }),
    (i) => ({
      key: itemKey(DI, i), difficulty: 'INTERMEDIATE',
      prompt: tablePrompt(table.label, v, 'In which year was the increase over the previous year the largest in absolute terms?'),
      answer: String(absYear),
      wrong: yearOptions(absYear, relYear),
      explanation: `Increases: ${changes.map((entry) => `${entry.year}: ${entry.abs}`).join(', ')}. The largest is in ${absYear}.`,
      hints: [
        '"Absolute" means the change in units, not in percent.',
        'Subtract each year\'s value from the next and compare the differences.',
        `The increases are ${changes.map((entry) => entry.abs).join(', ')} for ${changes.map((entry) => entry.year).join(', ')}.`,
        'Pick the year with the biggest of those differences.',
      ],
    }),
    (i) => ({
      key: itemKey(DI, i), difficulty: 'ADVANCED',
      prompt: tablePrompt(table.label, v, 'In which year was the percentage increase over the previous year the largest?'),
      answer: String(relYear),
      wrong: yearOptions(relYear, absYear),
      explanation: `Percentage increases: ${changes.map((entry) => `${entry.year}: ${percent(100 * entry.rel)}`).join(', ')}. The largest is in ${relYear}.`,
      hints: [
        'The biggest jump in units is not always the biggest in percent.',
        'Divide each increase by the previous year\'s value.',
        `The increases are ${changes.map((entry) => entry.abs).join(', ')} on bases of ${[v[0], v[1], v[2]].join(', ')}.`,
        `Compare ${changes.map((entry, index) => `${entry.abs}/${v[index]}`).join(', ')}.`,
      ],
    }),
  ];
  return makers;
});

// ---------------------------------------------------------------------------
// Counting and probability
// ---------------------------------------------------------------------------
const CP = 'apt-q-counting-probability';
const choose = (n: number, r: number): number => {
  let result = 1;
  for (let k = 1; k <= r; k += 1) result = (result * (n - r + k)) / k;
  return result;
};
const arrange = (n: number, r: number): number => {
  let result = 1;
  for (let k = 0; k < r; k += 1) result *= n - k;
  return result;
};
const DICE_SUM_WAYS = (s: number): number => 6 - Math.abs(s - 7);

const counting: Maker[] = [
  ...[[5, 2], [6, 3], [7, 2], [8, 3]].map(([n, r]) => (i: number): ItemSpec => ({
    key: itemKey(CP, i), difficulty: 'INTERMEDIATE',
    prompt: `In how many ways can a committee of ${r} be chosen from ${n} people?`,
    answer: num(choose(n!, r!)),
    wrong: [
      { text: num(arrange(n!, r!)), code: 'APT_Q_PROB_ORDER_COUNTED' },
      { text: num(n! + r!) },
      { text: num(n! ** r!) },
    ],
    explanation: `The order of choosing does not matter: C(${n}, ${r}) = ${arrange(n!, r!)} ÷ ${arrange(r!, r!)} = ${choose(n!, r!)}.`,
    hints: [
      'A committee is the same whatever order its members were picked in.',
      'Count ordered picks, then divide by the number of orders of the chosen members.',
      `Ordered picks: ${Array.from({ length: r! }, (_, k) => n! - k).join(' × ')} = ${arrange(n!, r!)}.`,
      `Each committee of ${r} appears ${arrange(r!, r!)} times among those; divide.`,
    ],
  })),
  ...[
    { event: 'a fair coin shows heads and a fair die shows 6', p: [1, 2], q: [1, 6], extra: '1/8' },
    { event: 'two fair dice both show 6', p: [1, 6], q: [1, 6], extra: '1/12' },
    { event: 'a fair die shows an even number and a fair coin shows tails', p: [1, 2], q: [1, 2], extra: '1/3' },
    { event: 'a fair coin shows heads on each of two tosses and a fair die then shows an odd number', p: [1, 4], q: [1, 2], extra: '1/6' },
  ].map(({ event, p, q, extra }) => (i: number): ItemSpec => ({
    key: itemKey(CP, i), difficulty: 'FOUNDATION',
    prompt: `What is the probability that ${event}?`,
    answer: fraction(p[0]! * q[0]!, p[1]! * q[1]!),
    wrong: [
      { text: fraction(p[0]! * q[1]! + q[0]! * p[1]!, p[1]! * q[1]!), code: 'APT_Q_PROB_ADDS_INDEPENDENT' },
      { text: p[0]! / p[1]! <= q[0]! / q[1]! ? fraction(p[0]!, p[1]!) : fraction(q[0]!, q[1]!) },
      { text: extra },
    ],
    explanation: `The events are independent, so multiply: ${fraction(p[0]!, p[1]!)} × ${fraction(q[0]!, q[1]!)} = ${fraction(p[0]! * q[0]!, p[1]! * q[1]!)}.`,
    hints: [
      'Both things must happen, and neither affects the other.',
      'For independent events that must both happen, multiply the probabilities.',
      `The probabilities are ${fraction(p[0]!, p[1]!)} and ${fraction(q[0]!, q[1]!)}.`,
      `Multiply ${fraction(p[0]!, p[1]!)} by ${fraction(q[0]!, q[1]!)}.`,
    ],
  })),
  ...[7, 8, 5, 10].map((s) => (i: number): ItemSpec => ({
    key: itemKey(CP, i), difficulty: 'INTERMEDIATE',
    prompt: `Two fair dice are thrown. What is the probability that the total is ${s}?`,
    answer: fraction(DICE_SUM_WAYS(s), 36),
    wrong: [
      { text: '1/11', code: 'APT_Q_PROB_UNEQUAL_OUTCOMES' },
      { text: fraction(s, 36) },
      { text: DICE_SUM_WAYS(s) === 6 ? '1/12' : '1/6' },
    ],
    explanation: `There are 36 equally likely pairs. ${DICE_SUM_WAYS(s)} of them total ${s}, so the probability is ${DICE_SUM_WAYS(s)}/36 = ${fraction(DICE_SUM_WAYS(s), 36)}.`,
    hints: [
      'The totals 2 to 12 are not equally likely.',
      'Count the ordered pairs (first die, second die) that give the total, out of 36.',
      `Start listing: (${Math.max(1, s - 6)}, ${s - Math.max(1, s - 6)}), (${Math.max(1, s - 6) + 1}, ${s - Math.max(1, s - 6) - 1}), …`,
      `There are ${DICE_SUM_WAYS(s)} such pairs; write them over 36 and simplify.`,
    ],
  })),
];

export const QUANTITATIVE_ITEMS: readonly AptitudeItem[] = [
  ...skillItems(NP, numberProperties),
  ...skillItems(AR, arithmetic),
  ...skillItems(PC, percentages),
  ...skillItems(RP, ratio),
  ...skillItems(AV, averages),
  ...skillItems(PL, profitLoss),
  ...skillItems(IN, interest),
  ...skillItems(TW, timeWork),
  ...skillItems(TS, timeSpeed),
  ...skillItems(MX, mixtures),
  ...skillItems(LE, linear),
  ...skillItems(DI, dataInterpretation),
  ...skillItems(CP, counting),
];
