/**
 * Maths checked by code (ENG-22): every arithmetic statement a hint makes — `12 × 4 = 48`,
 * `(120 - 20) / 4 = 25` — is evaluated here and compared with what the hint says. Pure.
 *
 * Why this exists: a model that writes a confident wrong sum in a worked step teaches the wrong thing
 * with ONE's name on it, and a reviewer cannot read every hint. A statement is only checked when it is
 * pure arithmetic on numbers (no variables, units or words inside the expression); everything else is
 * left alone. The stated result may be rounded to its own number of decimals.
 *
 * No `eval`: a small recursive-descent parser over + − × ÷ ^ and brackets.
 */

const NUMBER = String.raw`(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?`;
const OPERATOR = String.raw`[-+−×x*/÷^·]`;
const OPEN = String.raw`(?:\(\s*)*`;
const CLOSE = String.raw`(?:\s*\))*`;
/** An expression with at least one operator, `=`, then a number. Not preceded or followed by a letter, digit or dot. */
const STATEMENT = new RegExp(
  String.raw`(?<![\p{L}\p{N}.])(${OPEN}${NUMBER}${CLOSE}(?:\s*${OPERATOR}\s*${OPEN}${NUMBER}${CLOSE})+)\s*=\s*(-?${NUMBER})(?![\p{L}\p{N}]|\.\d)`,
  'gu',
);

export interface ArithmeticFinding {
  readonly statement: string;
  readonly stated: number;
  readonly actual: number | null;
}

type Token = { readonly kind: 'number'; readonly value: number } | { readonly kind: 'op'; readonly value: string } | { readonly kind: 'paren'; readonly value: '(' | ')' };

function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:,\d+)*(?:\.\d+)?)|([-+−×x*/÷^·])|([()]))/gyu;
  let index = 0;
  while (index < expression.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(expression);
    if (!match) {
      if (/^\s*$/u.test(expression.slice(index))) break;
      return null;
    }
    index = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: 'number', value: Number(match[1].replace(/,/g, '')) });
    else if (match[2] !== undefined) {
      const op = match[2];
      tokens.push({ kind: 'op', value: op === '−' ? '-' : op === '×' || op === 'x' || op === '·' ? '*' : op === '÷' ? '/' : op });
    } else tokens.push({ kind: 'paren', value: match[3] as '(' | ')' });
  }
  return tokens;
}

/** Evaluates + − × ÷ ^ with brackets; null when the expression does not parse or divides by zero. */
export function evaluateArithmetic(expression: string): number | null {
  const tokens = tokenize(expression);
  if (!tokens || tokens.length === 0) return null;
  let position = 0;
  const peek = (): Token | undefined => tokens[position];

  const primary = (): number | null => {
    const token = peek();
    if (!token) return null;
    if (token.kind === 'number') { position += 1; return token.value; }
    if (token.kind === 'op' && token.value === '-') { position += 1; const inner = primary(); return inner === null ? null : -inner; }
    if (token.kind === 'paren' && token.value === '(') {
      position += 1;
      const inner = sum();
      const close = peek();
      if (inner === null || !close || close.kind !== 'paren' || close.value !== ')') return null;
      position += 1;
      return inner;
    }
    return null;
  };
  const power = (): number | null => {
    const base = primary();
    if (base === null) return null;
    const token = peek();
    if (token?.kind === 'op' && token.value === '^') {
      position += 1;
      const exponent = power();
      return exponent === null ? null : base ** exponent;
    }
    return base;
  };
  const product = (): number | null => {
    let left = power();
    while (left !== null) {
      const token = peek();
      if (token?.kind !== 'op' || (token.value !== '*' && token.value !== '/')) break;
      position += 1;
      const right = power();
      if (right === null) return null;
      if (token.value === '/') {
        if (right === 0) return null;
        left /= right;
      } else left *= right;
    }
    return left;
  };
  const sum = (): number | null => {
    let left = product();
    while (left !== null) {
      const token = peek();
      if (token?.kind !== 'op' || (token.value !== '+' && token.value !== '-')) break;
      position += 1;
      const right = product();
      if (right === null) return null;
      left = token.value === '+' ? left + right : left - right;
    }
    return left;
  };

  const value = sum();
  if (value === null || position !== tokens.length || !Number.isFinite(value)) return null;
  return value;
}

function decimals(text: string): number {
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** Every arithmetic statement in the text whose stated result is wrong (beyond its own rounding). */
export function arithmeticFindings(text: string): readonly ArithmeticFinding[] {
  const findings: ArithmeticFinding[] = [];
  for (const match of text.matchAll(STATEMENT)) {
    const expression = match[1]!;
    const statedText = match[2]!.replace(/,/g, '');
    const stated = Number(statedText);
    const actual = evaluateArithmetic(expression);
    if (actual === null) { findings.push({ statement: match[0].trim(), stated, actual: null }); continue; }
    const tolerance = 0.5 * 10 ** -decimals(statedText) + 1e-9 * Math.max(1, Math.abs(actual));
    if (Math.abs(actual - stated) > tolerance) findings.push({ statement: match[0].trim(), stated, actual });
  }
  return findings;
}
