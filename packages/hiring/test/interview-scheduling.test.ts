/**
 * Interview scheduling essentials (EMP-09): reschedule and cancel reason codes, joining-link rules,
 * scorecard template input and ratings that must follow the template, and the calendar invite.
 *
 * The .ics fixtures are the logical (unfolded) lines a calendar reads. The tests check that the
 * built file unfolds to exactly those lines and that the physical file keeps the RFC 5545 rules
 * Google Calendar, Outlook and Apple Calendar rely on: CRLF line ends, lines of at most 75 octets
 * folded without splitting a character, escaped text, UTC times, one event with a stable UID.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  InterviewInputError,
  assertRatingsFollowTemplate,
  interviewCancelReasonCodes,
  interviewRescheduleReasonCodes,
  isAcceptableJoiningLink,
  parseCriterionRatings,
  parseScorecardTemplateInput,
} from '../src/interview-scheduling.js';
import { buildInterviewCalendar, describeInterviewForCalendar, interviewCalendarFilename, interviewCalendarUid } from '../src/interview-calendar.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n');

/** RFC 5545 §3.1: a CRLF followed by one space or tab continues the previous line. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter((line, index, lines) => !(index === lines.length - 1 && line === ''));
}

function expectWellFormed(ics: string): void {
  expect(ics.endsWith('\r\n')).toBe(true);
  expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  // Folding never splits a multi-byte character: every physical line is valid UTF-8 on its own.
  for (const line of ics.split('\r\n')) expect(Buffer.from(Buffer.from(line, 'utf8').toString('utf8'), 'utf8').equals(Buffer.from(line, 'utf8'))).toBe(true);
  const logical = unfold(ics);
  expect(logical[0]).toBe('BEGIN:VCALENDAR');
  expect(logical.at(-1)).toBe('END:VCALENDAR');
  expect(logical.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
  expect(logical.filter((line) => line === 'END:VEVENT')).toHaveLength(1);
  for (const property of ['UID', 'DTSTAMP', 'DTSTART', 'SEQUENCE', 'SUMMARY', 'STATUS']) {
    expect(logical.filter((line) => line.startsWith(property + ':'))).toHaveLength(1);
  }
  for (const line of logical.filter((value) => /^(DTSTAMP|DTSTART|DTEND):/.test(value))) expect(line).toMatch(/:\d{8}T\d{6}Z$/);
}

const acme = { employerName: 'Acme Robotics, Pune', title: 'Robotics engineer', roundNumber: 1, mode: 'VIDEO' } as const;

describe('reason codes', () => {
  it('are fixed lists in the §5.7 reason-code shape', () => {
    expect(interviewRescheduleReasonCodes).toEqual(['CANDIDATE_REQUESTED', 'INTERVIEWER_UNAVAILABLE', 'SCHEDULING_CONFLICT', 'LOGISTICS_CHANGED', 'TECHNICAL_ISSUE']);
    expect(interviewCancelReasonCodes).toEqual(['CANDIDATE_REQUESTED', 'CANDIDATE_WITHDREW', 'INTERVIEWER_UNAVAILABLE', 'POSITION_FILLED', 'PROCESS_CHANGED', 'SCHEDULED_IN_ERROR']);
    for (const code of [...interviewRescheduleReasonCodes, ...interviewCancelReasonCodes]) expect(code).toMatch(/^[A-Z0-9_:-]{3,64}$/);
  });
});

describe('joining links', () => {
  it.each([
    ['https://meet.example.test/room-1', true],
    ['HTTPS://Meet.Example.test/x?y=1', true],
    ['http://meet.example.test/room-1', false],
    ['https://user:secret@meet.example.test/room', false],
    ['https://', false],
    ['https://meet example.test', false],
    ['javascript:alert(1)', false],
    ['https://' + 'a'.repeat(510), false],
  ])('%s → %s', (link, ok) => {
    expect(isAcceptableJoiningLink(link)).toBe(ok);
  });
});

describe('scorecard template input', () => {
  it('reads a name, guidance and ordered criteria', () => {
    expect(parseScorecardTemplateInput({
      name: '  Technical round ', guidance: 'Score what you saw, not what you assume.',
      criteria: [{ label: 'Problem solving', guidance: 'Breaks the problem down before coding.' }, { label: 'Communication' }],
    })).toEqual({
      name: 'Technical round', guidance: 'Score what you saw, not what you assume.',
      criteria: [{ label: 'Problem solving', guidance: 'Breaks the problem down before coding.' }, { label: 'Communication', guidance: null }],
    });
  });

  it.each([
    [{ name: 'X', criteria: [{ label: 'A' }], extra: true }, 'INVALID_SCORECARD_TEMPLATE'],
    [{ criteria: [{ label: 'A' }] }, 'INVALID_SCORECARD_TEMPLATE'],
    [{ name: '=cmd()', criteria: [{ label: 'A' }] }, 'INVALID_SCORECARD_TEMPLATE'],
    [{ name: 'X', criteria: [] }, 'INVALID_SCORECARD_CRITERIA'],
    [{ name: 'X', criteria: Array.from({ length: 13 }, (_, i) => ({ label: 'C' + i })) }, 'INVALID_SCORECARD_CRITERIA'],
    [{ name: 'X', criteria: [{ label: 'Clarity' }, { label: 'clarity' }] }, 'DUPLICATE_SCORECARD_CRITERION'],
    [{ name: 'X', criteria: [{ label: 'A', weight: 3 }] }, 'INVALID_SCORECARD_CRITERIA'],
    [{ name: 'X', criteria: [{ label: '+SUM(A1)' }] }, 'INVALID_SCORECARD_CRITERIA'],
    [{ name: 'X', criteria: 'A' }, 'INVALID_SCORECARD_CRITERIA'],
  ])('refuses %j with %s', (body, code) => {
    expect(() => parseScorecardTemplateInput(body)).toThrow(expect.objectContaining({ code }));
  });
});

describe('criterion ratings', () => {
  const [first, second] = ['9b2d8e1a-3c4f-4a5b-8c6d-7e8f9a0b1c2d', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'];

  it('are absent, or a list of criterion, rating 1–5 and an optional note', () => {
    expect(parseCriterionRatings(undefined)).toBeUndefined();
    expect(parseCriterionRatings([{ criterionId: first, rating: 4, note: 'Clear reasoning.' }, { criterionId: second, rating: 2 }]))
      .toEqual([{ criterionId: first, rating: 4, note: 'Clear reasoning.' }, { criterionId: second, rating: 2, note: null }]);
  });

  it.each([
    [[{ criterionId: first, rating: 0 }]], [[{ criterionId: first, rating: 6 }]], [[{ criterionId: first, rating: 3.5 }]],
    [[{ criterionId: 'not-a-uuid', rating: 3 }]], [[{ criterionId: first, rating: 3, weight: 2 }]], [[{ criterionId: first, rating: 3, note: '=HYPERLINK()' }]],
    ['all good'], [[]],
  ])('refuses %j', (value) => {
    expect(() => parseCriterionRatings(value)).toThrow(InterviewInputError);
  });

  it('must rate every criterion of the template exactly once', () => {
    expect(() => assertRatingsFollowTemplate([{ criterionId: first, rating: 3, note: null }, { criterionId: second, rating: 4, note: null }], [first, second])).not.toThrow();
    for (const ratings of [
      [{ criterionId: first, rating: 3, note: null }],
      [{ criterionId: first, rating: 3, note: null }, { criterionId: first, rating: 4, note: null }],
      [{ criterionId: first, rating: 3, note: null }, { criterionId: second, rating: 4, note: null }, { criterionId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', rating: 1, note: null }],
    ]) {
      expect(() => assertRatingsFollowTemplate(ratings, [first, second])).toThrow(expect.objectContaining({ code: 'SCORECARD_CRITERIA_MISMATCH' }));
    }
  });
});

describe('calendar invite (.ics)', () => {
  it('derives a stable UID that does not reveal the interview id, and a plain filename', () => {
    const id = '3f1c2a9e-5b7d-4c1e-9a2b-6d8e0f1a2b3c';
    expect(interviewCalendarUid(id)).toBe(interviewCalendarUid(id));
    expect(interviewCalendarUid(id)).toMatch(/^[0-9a-f]{32}@one\.ai8ht\.pro$/);
    expect(interviewCalendarUid(id)).not.toContain(id.slice(0, 8));
    expect(interviewCalendarUid(id)).not.toBe(interviewCalendarUid('4f1c2a9e-5b7d-4c1e-9a2b-6d8e0f1a2b3c'));
    expect(interviewCalendarFilename('Robotics engineer / R&D', 2)).toBe('interview-robotics-engineer-r-d-round-2.ics');
  });

  it('builds the downloaded invite for a rescheduled interview exactly as the fixture', () => {
    const text = describeInterviewForCalendar({
      ...acme, stageLabel: 'Technical round', state: 'RESCHEDULED', includeAccess: true,
      joiningLink: 'https://meet.example.test/room-1?pwd=a,b', locationDetail: null,
      preparationNote: 'Bring a short walkthrough of one project you built; keep it to 10 minutes.',
    });
    const ics = buildInterviewCalendar({
      uid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90@one.ai8ht.pro', sequence: 1, stamp: new Date('2099-02-20T06:15:00Z'),
      start: new Date('2099-03-02T04:30:00Z'), end: new Date('2099-03-02T05:30:00Z'), cancelled: false, ...text,
    });
    expectWellFormed(ics);
    expect(unfold(ics)).toEqual(fixture('interview-rescheduled.ics.txt'));
  });

  it('builds the emailed invite for a cancellation without the link, location or preparation note', () => {
    const text = describeInterviewForCalendar({
      ...acme, stageLabel: null, state: 'CANCELLED', includeAccess: false,
      joiningLink: 'https://meet.example.test/room-1', locationDetail: 'Gate 3', preparationNote: 'Bring your notes.',
    });
    const ics = buildInterviewCalendar({
      uid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90@one.ai8ht.pro', sequence: 2, stamp: new Date('2099-02-21T09:00:00Z'),
      start: new Date('2099-03-02T04:30:00Z'), end: new Date('2099-03-02T05:30:00Z'), cancelled: true, ...text,
    });
    expectWellFormed(ics);
    expect(unfold(ics)).toEqual(fixture('interview-cancelled-emailed.ics.txt'));
    expect(ics).not.toMatch(/meet\.example\.test|Gate 3|Bring your notes/);
  });

  it('gives an interview with no end an hour, and folds long non-ASCII text without splitting characters', () => {
    const text = describeInterviewForCalendar({
      employerName: 'सिंथेटिक रोबोटिक्स प्राइवेट लिमिटेड', title: 'रोबोटिक्स इंजीनियर — '.repeat(6), roundNumber: 3, mode: 'ONSITE',
      stageLabel: null, state: 'SCHEDULED', includeAccess: true, joiningLink: null, locationDetail: 'Building 2; Floor 3, Room "A"\\B', preparationNote: null,
    });
    const ics = buildInterviewCalendar({ uid: 'x@one.ai8ht.pro', sequence: 0, stamp: new Date('2099-01-01T00:00:00Z'), start: new Date('2099-01-02T10:00:00Z'), end: null, cancelled: false, ...text });
    expectWellFormed(ics);
    const logical = unfold(ics);
    expect(logical).toContain('DTEND:20990102T110000Z');
    expect(logical).toContain('LOCATION:Building 2\\; Floor 3\\, Room "A"\\\\B');
    expect(logical.some((line) => line.startsWith('URL:'))).toBe(false);
    expect(logical.find((line) => line.startsWith('SUMMARY:'))).toContain('सिंथेटिक रोबोटिक्स');
  });

  it('refuses a line break smuggled into a property and never emits a bare LF', () => {
    const text = describeInterviewForCalendar({ ...acme, stageLabel: 'Round\r\nX-INJECTED:1', state: 'SCHEDULED', includeAccess: false, joiningLink: null, locationDetail: null, preparationNote: null });
    const ics = buildInterviewCalendar({ uid: 'x@one.ai8ht.pro', sequence: 0, stamp: new Date('2099-01-01T00:00:00Z'), start: new Date('2099-01-02T10:00:00Z'), end: null, cancelled: false, ...text });
    expectWellFormed(ics);
    expect(unfold(ics).some((line) => line.startsWith('X-INJECTED'))).toBe(false);
  });
});
