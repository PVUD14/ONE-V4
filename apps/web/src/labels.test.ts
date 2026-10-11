/**
 * The shared display helpers: codes become words, dates read one way everywhere.
 */
import { describe, expect, it } from 'vitest';
import { codeLabel, roleLabel } from './labels.js';
import { formatDate, formatDateTime, formatMonth, formatTime } from './dates.js';

describe('roleLabel', () => {
  it('names known roles as job titles', () => {
    expect(roleLabel('STUDENT')).toBe('Student');
    expect(roleLabel('PLACEMENT_ADMIN')).toBe('Placement Officer');
    expect(roleLabel('FACULTY_LECTURER')).toBe('Lecturer');
    expect(roleLabel('EMPLOYER_OWNER')).toBe('Employer Owner');
    expect(roleLabel('INSTITUTION_ADMIN')).toBe('Institution Admin');
    expect(roleLabel('DEPARTMENT_HEAD')).toBe('Department Head');
    expect(roleLabel('OPERATIONS_ADMIN')).toBe('Operations Admin');
  });

  it('humanises an unknown role code in title case, and reads "Not recorded" for none', () => {
    expect(roleLabel('CAMPUS_AMBASSADOR')).toBe('Campus Ambassador');
    expect(roleLabel(null)).toBe('Not recorded');
    expect(roleLabel('')).toBe('Not recorded');
  });
});

describe('codeLabel', () => {
  it('turns status and kind codes into plain words', () => {
    expect(codeLabel('TRANSFERRED')).toBe('Transferred');
    expect(codeLabel('ACTIVE')).toBe('Active');
    expect(codeLabel('UNDER_REVIEW')).toBe('Under review');
    expect(codeLabel('DEPARTMENT')).toBe('Department');
    expect(codeLabel('REVIEW_EVIDENCE')).toBe('Review evidence');
  });

  it('keeps acronyms, leaves ordinary text alone, and reads "Not recorded" for none', () => {
    expect(codeLabel('AI_FEATURE_ENABLE')).toBe('AI feature enable');
    expect(codeLabel('NA')).toBe('NA');
    expect(codeLabel('Withdrawn by you')).toBe('Withdrawn by you');
    expect(codeLabel(undefined)).toBe('Not recorded');
  });
});

describe('date display', () => {
  const moment = new Date(2026, 9, 7, 17, 18, 40);

  it('shows dates, date-times, months and times one way', () => {
    expect(formatDate(moment)).toBe('7 Oct 2026');
    expect(formatDateTime(moment)).toBe('7 Oct 2026, 17:18');
    expect(formatMonth(moment)).toBe('Oct 2026');
    expect(formatTime(moment)).toBe('17:18');
  });

  it('reads a bare calendar day or month as that local day, never shifted by a time zone', () => {
    expect(formatDate('2026-09-25')).toBe('25 Sep 2026');
    expect(formatMonth('2026-09')).toBe('Sep 2026');
  });

  it('can read an instant in UTC', () => {
    expect(formatDate('2026-09-30T23:30:00Z', { utc: true })).toBe('30 Sep 2026');
  });

  it('reads "Not recorded", or the fallback asked for, when there is no usable date', () => {
    expect(formatDate(null)).toBe('Not recorded');
    expect(formatDateTime('not a date')).toBe('Not recorded');
    expect(formatDate(undefined, { fallback: 'Never' })).toBe('Never');
  });
});
