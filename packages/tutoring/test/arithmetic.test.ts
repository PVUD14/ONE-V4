/** Maths checked by code (ENG-22): the arithmetic statements a hint makes, evaluated without eval. */
import { describe, expect, it } from 'vitest';
import { arithmeticFindings, evaluateArithmetic } from '../src/index.js';

describe('evaluateArithmetic', () => {
  it('follows precedence, brackets and powers', () => {
    expect(evaluateArithmetic('2 + 3 × 4')).toBe(14);
    expect(evaluateArithmetic('(2 + 3) * 4')).toBe(20);
    expect(evaluateArithmetic('2 ^ 3 ^ 2')).toBe(512);
    expect(evaluateArithmetic('120 ÷ 4 − 10')).toBe(20);
    expect(evaluateArithmetic('1,20,000 / 4')).toBe(30000);
    expect(evaluateArithmetic('7 x 8')).toBe(56);
  });

  it('answers null for what it cannot evaluate', () => {
    expect(evaluateArithmetic('5 / 0')).toBeNull();
    expect(evaluateArithmetic('(2 + 3')).toBeNull();
    expect(evaluateArithmetic('2 + abc')).toBeNull();
  });
});

describe('arithmeticFindings', () => {
  it('finds a false statement and passes a true or rounded one', () => {
    expect(arithmeticFindings('So 7 × 8 = 54 here.')).toEqual([{ statement: '7 × 8 = 54', stated: 54, actual: 56 }]);
    expect(arithmeticFindings('So 7 × 8 = 56 here, and 10 / 3 = 3.33.')).toEqual([]);
    expect(arithmeticFindings('Then 1,200 + 300 = 1,500.')).toEqual([]);
  });

  it('leaves alone what is not pure arithmetic', () => {
    expect(arithmeticFindings('Let x = 5 and speed = distance / time.')).toEqual([]);
    expect(arithmeticFindings('20% of 50 = 10')).toEqual([]);
    expect(arithmeticFindings('Version 2.0 = latest')).toEqual([]);
  });

  it('checks every link of a chain', () => {
    expect(arithmeticFindings('d = 60 × 2 = 120')).toEqual([]);
    expect(arithmeticFindings('a = 3 + 4 = 8')).toHaveLength(1);
  });
});
