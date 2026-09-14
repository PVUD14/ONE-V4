/**
 * iCalendar rendering. The merge queries need a database and are covered by the
 * integration spec; this covers the part that silently breaks in a stranger's calendar
 * client, where nobody would ever see an error message.
 */
import { describe, expect, it } from 'vitest';
import { renderCalendar, type CalendarEntry } from './calendar.controller.js';

const now = new Date('2026-09-13T09:00:00.000Z');

function entry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'INTERVIEW',
    title: 'Interview · SOC Analyst Intern',
    detail: 'Round 1 with Aster Mobility · video call',
    startsAt: '2026-09-20T04:30:00.000Z',
    endsAt: '2026-09-20T05:15:00.000Z',
    location: null,
    joinUrl: 'https://meet.example.test/abc',
    audience: 'STUDENT',
    ...overrides,
  };
}

describe('iCalendar rendering', () => {
  it('produces a calendar a client will accept', () => {
    const output = renderCalendar([entry()], now);
    expect(output.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(output.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(output).toContain('DTSTART:20260920T043000Z');
    expect(output).toContain('DTEND:20260920T051500Z');
    expect(output).toContain('URL:https://meet.example.test/abc');
    // Every line ends CRLF, which is the part naive string building gets wrong.
    expect(output.split('\r\n').every((line, index, all) => index === all.length - 1 || !line.endsWith('\n'))).toBe(true);
  });

  it('gives a deadline no invented duration', () => {
    const output = renderCalendar([entry({ kind: 'ROADMAP', endsAt: null, joinUrl: null, detail: 'Suggested next step' })], now);
    // A due date is a point in time. An hour-long block would silently claim someone's
    // afternoon for something that takes no time at all.
    expect(output).toContain('DTSTART:20260920T043000Z');
    expect(output).toContain('DTEND:20260920T043000Z');
  });

  it('escapes the characters that would otherwise split a property', () => {
    const output = renderCalendar([entry({
      title: 'Exam closes; Networking, Unit 2',
      detail: 'Bring ID\nLaptop only',
      location: null,
      joinUrl: null,
    })], now);
    expect(output).toContain('SUMMARY:Exam closes\\; Networking\\, Unit 2');
    expect(output).toContain('DESCRIPTION:Bring ID\\nLaptop only');
  });

  it('folds a long line so Outlook does not drop the event', () => {
    const long = `Interview · ${'Senior Security Operations Centre Analyst '.repeat(4)}`;
    const output = renderCalendar([entry({ title: long, detail: null, joinUrl: null })], now);
    const summaryLines = output.split('\r\n').filter((line) => line.startsWith('SUMMARY:') || line.startsWith(' '));
    expect(summaryLines.length).toBeGreaterThan(1);
    expect(summaryLines.every((line) => line.length <= 75)).toBe(true);
    // Folding must be reversible: unfolding restores exactly what went in.
    const unfolded = summaryLines.map((line, index) => (index === 0 ? line : line.slice(1))).join('');
    expect(unfolded).toBe(`SUMMARY:${long}`);
  });

  it('keeps each entry uniquely identified so a re-import updates rather than duplicates', () => {
    const output = renderCalendar([
      entry({ id: 'shared-id', kind: 'INTERVIEW' }),
      entry({ id: 'shared-id', kind: 'TASK', title: 'Submit your resume', endsAt: null, joinUrl: null }),
    ], now);
    const uids = output.split('\r\n').filter((line) => line.startsWith('UID:'));
    expect(uids).toEqual(['UID:interview-shared-id@one.ai8ht.pro', 'UID:task-shared-id@one.ai8ht.pro']);
    expect(new Set(uids).size).toBe(2);
  });

  it('renders an empty calendar rather than nothing at all', () => {
    const output = renderCalendar([], now);
    expect(output).toContain('BEGIN:VCALENDAR');
    expect(output).not.toContain('BEGIN:VEVENT');
  });
});
