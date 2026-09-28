/**
 * EMP-10 message rules: what a message may contain, when an employer may start a conversation, how a
 * report is read, and which request fields are accepted.
 */
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_MAX_LENGTH,
  MessageInputError,
  assertOnlyFields,
  canEmployerMessage,
  containsLink,
  messageLimits,
  readMessageBody,
  readReportReason,
  readReportStatement,
  reportSeverity,
} from '../src/application-messages.js';

const code = (run: () => unknown): string | null => {
  try { run(); return null; } catch (error) { return error instanceof MessageInputError ? error.code : 'OTHER'; }
};

describe('message body', () => {
  it('accepts text up to 2,000 characters, trimmed, with line breaks kept', () => {
    expect(readMessageBody('  Hello,\r\nCan you join on Friday?  ')).toBe('Hello,\nCan you join on Friday?');
    expect(readMessageBody('a'.repeat(MESSAGE_MAX_LENGTH))).toHaveLength(2000);
    expect(readMessageBody('Tabs\tare fine')).toBe('Tabs\tare fine');
  });

  it('refuses empty, too long, non-text and control or direction-override characters', () => {
    expect(code(() => readMessageBody(''))).toBe('INVALID_BODY');
    expect(code(() => readMessageBody('   \n  '))).toBe('INVALID_BODY');
    expect(code(() => readMessageBody('a'.repeat(MESSAGE_MAX_LENGTH + 1)))).toBe('INVALID_BODY');
    expect(code(() => readMessageBody(42))).toBe('INVALID_BODY');
    expect(code(() => readMessageBody({ text: 'hi' }))).toBe('INVALID_BODY');
    expect(code(() => readMessageBody('bell\u0007'))).toBe('INVALID_BODY');
    // A right-to-left override can make "moc.yap" read as "pay.com".
    expect(code(() => readMessageBody('visit ‮gpj.exe'))).toBe('INVALID_BODY');
  });
});

describe('links are allowed but flagged', () => {
  it('flags web addresses in their common forms', () => {
    for (const text of ['See https://pay.example.test/x', 'http://x.io', 'go to www.example.org', 'pay at pay-now.in today', 'bit.ly/abc', 'forms.gle/xyz']) {
      expect(containsLink(text), text).toBe(true);
    }
  });

  it('does not flag email addresses, decimals, times or ordinary sentences', () => {
    for (const text of ['Write to hr@company.com', 'Your CGPA of 7.5 is fine', 'Join at 10.30 on Friday', 'Thanks. See you then.', 'We use Node.js and React.']) {
      expect(containsLink(text), text).toBe(false);
    }
  });
});

describe('who may start a conversation (decision 10.2 #8)', () => {
  it('allows SHORTLISTED onward while open, not before and not after close', () => {
    for (const state of ['SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER']) expect(canEmployerMessage(state), state).toBe(true);
    for (const state of ['DRAFT', 'APPLIED', 'SCREENING', 'HIRED', 'REJECTED', 'WITHDRAWN']) expect(canEmployerMessage(state), state).toBe(false);
  });
});

describe('reports', () => {
  it('reads a listed reason and an optional bounded statement', () => {
    expect(readReportReason('SCAM_OR_PAYMENT_REQUEST')).toBe('SCAM_OR_PAYMENT_REQUEST');
    expect(code(() => readReportReason('SPAM'))).toBe('INVALID_REASONCODE');
    expect(code(() => readReportReason(undefined))).toBe('INVALID_REASONCODE');
    expect(readReportStatement(undefined)).toBeNull();
    expect(readReportStatement('  ')).toBeNull();
    expect(readReportStatement(' They asked for a fee. ')).toBe('They asked for a fee.');
    expect(code(() => readReportStatement('x'.repeat(1001)))).toBe('INVALID_STATEMENT');
  });

  it('puts a payment demand at the top of the queue', () => {
    expect(reportSeverity('SCAM_OR_PAYMENT_REQUEST')).toBe('HIGH');
    expect(reportSeverity('HARASSMENT')).toBe('MEDIUM');
  });
});

describe('request shape', () => {
  it('refuses unknown fields and non-objects', () => {
    expect(assertOnlyFields({ body: 'hi' }, ['body'])).toEqual({ body: 'hi' });
    expect(code(() => assertOnlyFields({ body: 'hi', attachment: 'x' }, ['body']))).toBe('UNKNOWN_FIELD');
    expect(code(() => assertOnlyFields(['hi'], ['body']))).toBe('INVALID_REQUEST');
    expect(code(() => assertOnlyFields(null, ['body']))).toBe('INVALID_REQUEST');
  });

  it('keeps the abuse brakes a genuine recruiter never meets', () => {
    expect(messageLimits).toEqual({ perThreadSidePerHour: 10, employerUnansweredInARow: 3, employerPerHour: 200, employerNewThreadsPerDay: 50, studentPerHour: 60 });
  });
});
