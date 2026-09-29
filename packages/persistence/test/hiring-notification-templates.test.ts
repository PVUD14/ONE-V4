/**
 * Version 1 of the hiring notification wording (EMP-08): what each notice and its email say, in the
 * student's timezone, and what they must never say. Pure rendering, no database.
 */
import { describe, expect, it } from 'vitest';
import {
  HIRING_NOTIFICATION_EVENT_TYPES,
  formatNoticeTime,
  hiringTemplateKey,
  renderHiringEmail,
  renderHiringNotice,
  type HiringNoticeFacts,
} from '../src/hiring-notifications.js';
import { schemaForEvent } from '@planthepath/events/src/index.js';

const base = { employerName: 'Acme Robotics', opportunityTitle: 'Robotics engineer' } as const;
const at = new Date('2099-03-01T04:30:00.000Z');

describe('hiring notice wording, version 1', () => {
  it.each([
    ['SCREENING', 'Acme Robotics is reviewing your application for Robotics engineer.'],
    ['SHORTLISTED', 'Acme Robotics shortlisted you for Robotics engineer.'],
    ['ASSESSMENT', 'Acme Robotics moved your application for Robotics engineer to the assessment stage.'],
    ['OFFER', 'Acme Robotics moved your application for Robotics engineer to the offer stage.'],
    ['HIRED', 'Acme Robotics has marked you as hired for Robotics engineer. Congratulations.'],
  ] as const)('says what a move to %s means', (stage, body) => {
    expect(renderHiringNotice({ ...base, kind: 'APPLICATION_STAGE_CHANGED', stage })).toEqual({ title: 'Application update: Robotics engineer', body });
  });

  it('writes interview times in the student timezone and falls back to India time for an unknown zone', () => {
    const facts: HiringNoticeFacts = { ...base, kind: 'INTERVIEW_SCHEDULED', interview: { roundNumber: 2, mode: 'ONSITE', scheduledStart: at } };
    const india = renderHiringNotice(facts, 'Asia/Kolkata');
    expect(india.title).toBe('Interview scheduled: Robotics engineer');
    expect(india.body).toBe(`Acme Robotics scheduled round 2 (on site) for Robotics engineer on ${formatNoticeTime(at, 'Asia/Kolkata')}. The location or joining link, and what to prepare, are under Applications.`);
    expect(formatNoticeTime(at, 'Asia/Kolkata')).toMatch(/10:00/);
    expect(formatNoticeTime(at, 'Europe/London')).toMatch(/4:30/);
    expect(formatNoticeTime(at, 'Not/AZone')).toBe(formatNoticeTime(at, 'Asia/Kolkata'));
    expect(formatNoticeTime(at, null)).toBe(formatNoticeTime(at, 'Asia/Kolkata'));
  });

  it('distinguishes a reschedule from a cancellation', () => {
    const interview = { roundNumber: 1, mode: 'VIDEO', scheduledStart: at };
    expect(renderHiringNotice({ ...base, kind: 'INTERVIEW_CHANGED', interview, interviewChange: 'RESCHEDULED' }).title).toBe('Interview rescheduled: Robotics engineer');
    expect(renderHiringNotice({ ...base, kind: 'INTERVIEW_CHANGED', interview, interviewChange: 'CANCELLED' })).toEqual({
      title: 'Interview cancelled: Robotics engineer', body: 'Acme Robotics cancelled round 1 for Robotics engineer. If they reschedule, you will be told here.' });
  });

  it('states an offer deadline when there is one, and not otherwise', () => {
    expect(renderHiringNotice({ ...base, kind: 'OFFER_EXTENDED', offerExpiresAt: at }, 'Asia/Kolkata').body)
      .toBe(`Acme Robotics made you an offer for Robotics engineer. Accept or decline it under Applications by ${formatNoticeTime(at, 'Asia/Kolkata')}.`);
    expect(renderHiringNotice({ ...base, kind: 'OFFER_EXTENDED', offerExpiresAt: null }).body)
      .toBe('Acme Robotics made you an offer for Robotics engineer. Accept or decline it under Applications.');
    expect(renderHiringNotice({ ...base, kind: 'OFFER_EXPIRING', offerExpiresAt: at }).title).toBe('Offer expires soon: Robotics engineer');
    expect(renderHiringNotice({ ...base, kind: 'OFFER_WITHDRAWN' }).body).toBe('Acme Robotics withdrew its offer for Robotics engineer.');
  });

  it('tells the employer about an answer without naming the candidate', () => {
    const accepted = renderHiringNotice({ ...base, kind: 'OFFER_RESPONDED', offerResponse: 'ACCEPTED', referenceCode: 'ROB-7' });
    expect(accepted).toEqual({ title: 'Offer accepted: Robotics engineer', body: 'A candidate accepted your offer for Robotics engineer (ROB-7). Open Offers to see it and record the hire.' });
    expect(renderHiringNotice({ ...base, kind: 'OFFER_RESPONDED', offerResponse: 'DECLINED', referenceCode: null }).body)
      .toBe('A candidate declined your offer for Robotics engineer. Open Offers to see it.');
  });

  it('keeps every notice inside the feed limits, however long the job title', () => {
    const long = { employerName: 'E'.repeat(300), opportunityTitle: 'T'.repeat(300) };
    for (const kind of ['APPLICATION_STAGE_CHANGED', 'APPLICATION_TERMS_CHANGED', 'OFFER_EXTENDED', 'OFFER_RESPONDED'] as const) {
      const notice = renderHiringNotice({ ...long, kind, stage: 'SHORTLISTED', offerResponse: 'ACCEPTED' });
      expect(notice.title.length).toBeLessThanOrEqual(160);
      expect(notice.body.length).toBeLessThanOrEqual(500);
    }
  });

  it('builds the email from the notice, with where to act and how to stop hiring emails', () => {
    const email = renderHiringEmail({ title: 'Offer from Acme Robotics', body: 'Acme Robotics made you an offer.' });
    expect(email.subject).toBe('Offer from Acme Robotics');
    expect(email.textBody.split('\n\n')).toEqual(['Offer from Acme Robotics', 'Acme Robotics made you an offer.',
      'Sign in to ONE to see the details. You can turn hiring emails off in your notification settings; the notice stays in your ONE notifications.']);
  });

  it('never mentions readiness, scores or gaps in any notice', () => {
    const interview = { roundNumber: 1, mode: 'PHONE', scheduledStart: at };
    const kinds: HiringNoticeFacts[] = [
      ...(['SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'] as const).map((stage) => ({ ...base, kind: 'APPLICATION_STAGE_CHANGED' as const, stage })),
      { ...base, kind: 'APPLICATION_TERMS_CHANGED' }, { ...base, kind: 'INTERVIEW_SCHEDULED', interview },
      { ...base, kind: 'INTERVIEW_CHANGED', interview, interviewChange: 'RESCHEDULED' }, { ...base, kind: 'OFFER_EXTENDED', offerExpiresAt: at },
      { ...base, kind: 'OFFER_WITHDRAWN' }, { ...base, kind: 'OFFER_EXPIRING', offerExpiresAt: at }, { ...base, kind: 'OFFER_RESPONDED', offerResponse: 'ACCEPTED' },
    ];
    for (const facts of kinds) {
      const text = JSON.stringify([renderHiringNotice(facts), renderHiringEmail(renderHiringNotice(facts))]);
      expect(text).not.toMatch(/readiness|band|score|mastery|gap|fit/i);
    }
  });

  it('EMP-10: says a message arrived and where, never what it says, and never names the candidate to the employer', () => {
    expect(renderHiringNotice({ ...base, kind: 'EMPLOYER_MESSAGE' })).toEqual({
      title: 'Message from Acme Robotics', body: 'Acme Robotics sent you a message about Robotics engineer. Read and reply under Applications.' });
    expect(renderHiringNotice({ ...base, kind: 'CANDIDATE_MESSAGE', referenceCode: 'ROB-7' })).toEqual({
      title: 'Candidate message: Robotics engineer', body: 'A candidate replied about Robotics engineer (ROB-7). Open Messages to read it.' });
    expect(hiringTemplateKey('EMPLOYER_MESSAGE')).toBe('hiring-employer-message');
    for (const kind of ['EMPLOYER_MESSAGE', 'CANDIDATE_MESSAGE'] as const) {
      const notice = renderHiringNotice({ employerName: 'E'.repeat(300), opportunityTitle: 'T'.repeat(300), kind });
      expect(notice.title.length).toBeLessThanOrEqual(160);
      expect(notice.body.length).toBeLessThanOrEqual(500);
      expect(JSON.stringify(renderHiringNotice({ ...base, kind }))).not.toMatch(/readiness|band|score|mastery|gap|fit/i);
    }
    expect(HIRING_NOTIFICATION_EVENT_TYPES).toContain('application.message.sent');
  });

  it('tells the student what screening test was sent and when it closes, never a score (EMP-12)', () => {
    const notice = renderHiringNotice({ ...base, kind: 'ASSESSMENT_INVITED', assessment: { title: 'Kinematics screen', closesAt: at } }, 'Asia/Kolkata');
    expect(notice).toEqual({
      title: 'Screening test: Robotics engineer',
      body: `Acme Robotics sent you a screening test, Kinematics screen, for Robotics engineer. Read what it covers and take it under Assessments before ${formatNoticeTime(at, 'Asia/Kolkata')}. The timer starts only when you begin.`,
    });
    expect(JSON.stringify(notice)).not.toMatch(/readiness|band|score|mastery|gap|percent/i);
    expect(hiringTemplateKey('ASSESSMENT_INVITED')).toBe('hiring-assessment-invited');
    expect(HIRING_NOTIFICATION_EVENT_TYPES).toContain('employer_assessment.invited');
  });

  it('names a stable template per kind, and consumes only registered events', () => {
    expect(hiringTemplateKey('INTERVIEW_SCHEDULED')).toBe('hiring-interview-scheduled');
    for (const eventType of HIRING_NOTIFICATION_EVENT_TYPES) expect(() => schemaForEvent(eventType, 1)).not.toThrow();
  });
});
