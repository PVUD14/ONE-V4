/**
 * The pure rules of a college's exit (INST-18): which step an exit may take, the export's parts and
 * audit names, and the words a student is told.
 */
import { describe, expect, it } from 'vitest';
import { highRiskActions, approvalRequestReasons } from './high-risk-actions.js';
import {
  institutionExitExportAuditAction,
  institutionExitExportParts,
  institutionExitExportSections,
  institutionExitNotice,
  institutionOffboardingRetentionDays,
  institutionReturnNotice,
  isInstitutionExitExportSection,
  refuseInstitutionOffboardingStep,
} from './institution-contract.js';

describe('refuseInstitutionOffboardingStep', () => {
  it('ends only from a notice', () => {
    expect(refuseInstitutionOffboardingStep('NOTICE', 'END', false)).toBeNull();
    for (const state of ['ENDED', 'CANCELLED', 'PURGED'] as const) expect(refuseInstitutionOffboardingStep(state, 'END', false)).toBe('OFFBOARDING_NOT_IN_NOTICE');
  });

  it('cancels from a notice, or from the end only while the retention period runs', () => {
    expect(refuseInstitutionOffboardingStep('NOTICE', 'CANCEL', false)).toBeNull();
    expect(refuseInstitutionOffboardingStep('ENDED', 'CANCEL', false)).toBeNull();
    expect(refuseInstitutionOffboardingStep('ENDED', 'CANCEL', true)).toBe('OFFBOARDING_RETENTION_ENDED');
    expect(refuseInstitutionOffboardingStep('CANCELLED', 'CANCEL', false)).toBe('OFFBOARDING_NOT_OPEN');
    expect(refuseInstitutionOffboardingStep('PURGED', 'CANCEL', true)).toBe('OFFBOARDING_NOT_OPEN');
  });

  it('purges only an ended exit whose retention period has passed', () => {
    expect(refuseInstitutionOffboardingStep('ENDED', 'PURGE', true)).toBeNull();
    expect(refuseInstitutionOffboardingStep('ENDED', 'PURGE', false)).toBe('OFFBOARDING_RETENTION_RUNNING');
    for (const state of ['NOTICE', 'CANCELLED', 'PURGED'] as const) expect(refuseInstitutionOffboardingStep(state, 'PURGE', true)).toBe('OFFBOARDING_NOT_ENDED');
  });

  it('keeps decision 10.2 #10: ninety days', () => {
    expect(institutionOffboardingRetentionDays).toBe(90);
  });
});

describe('the exit export', () => {
  it('knows its sections, keeps counselling notes apart, and names each audit action', () => {
    expect(institutionExitExportSections).not.toContain('counselling-notes');
    expect(isInstitutionExitExportSection('counselling-notes')).toBe(true);
    expect(isInstitutionExitExportSection('roster')).toBe(true);
    expect(isInstitutionExitExportSection('learning')).toBe(false);
    expect(institutionExitExportAuditAction('teaching-assignments')).toBe('institution.exit_export.teaching_assignments.exported');
    expect(institutionExitExportAuditAction('counselling-notes')).toBe('institution.exit_export.counselling_notes.exported');
    for (const section of [...institutionExitExportSections, 'counselling-notes' as const]) {
      // INST-08's daily allowance counts `institution.%.exported`; every exit file must count too.
      expect(institutionExitExportAuditAction(section)).toMatch(/^institution\..*\.exported$/);
    }
  });

  it('splits a section into files of at most ten thousand rows, always at least one', () => {
    expect(institutionExitExportParts(0)).toBe(1);
    expect(institutionExitExportParts(10_000)).toBe(1);
    expect(institutionExitExportParts(10_001)).toBe(2);
    expect(institutionExitExportParts(25_000)).toBe(3);
  });
});

describe('what a student is told', () => {
  it('says the college stopped using ONE, what the student keeps, in India time, without identifiers', () => {
    const notice = institutionExitNotice({ institutionName: 'Beta College', endedAt: new Date('2026-10-31T20:00:00Z') });
    expect(notice.title).toBe('Beta College has stopped using ONE');
    expect(notice.body).toContain('1 November 2026');
    expect(notice.body).toMatch(/stay yours/);
    expect(notice.body).not.toMatch(/verify past results|recorded you|[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(notice.title.length).toBeLessThanOrEqual(160);
    expect(notice.body.length).toBeLessThanOrEqual(500);
    expect(institutionExitNotice({ institutionName: '  ', endedAt: new Date() }).title).toBe('Your college has stopped using ONE');
  });

  it('says the link is back when an exit is cancelled', () => {
    expect(institutionReturnNotice({ institutionName: 'Beta College' }).title).toBe('Beta College is using ONE again');
  });
});

describe('the purge is a high-risk action', () => {
  it('needs OPS_ORG_MANAGE and a listed reason, and acts on an exit', () => {
    expect(highRiskActions.INSTITUTION_DATA_PURGE).toMatchObject({ capability: 'OPS_ORG_MANAGE', targetType: 'institution_offboarding' });
    expect(approvalRequestReasons.INSTITUTION_DATA_PURGE).toEqual(['RETENTION_PERIOD_ENDED']);
  });
});
