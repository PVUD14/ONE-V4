/**
 * Unit tests for the résumé content rules (RESUME-GEN): the draft validation, "Verified by" only where an
 * institution stood behind a record, other people's ids ignored, the checks carry no number, and nothing ONE
 * writes on a résumé — or draws in the PDF — mentions readiness, a band, a score, mastery or a stage.
 * Synthetic people and institutions only.
 */
import { describe, expect, it } from 'vitest';
import {
  LABEL_PENDING, LABEL_SELF_DECLARED, RESUME_LEGEND, RESUME_TEMPLATE_INFO, ResumeInputError, buildResumeContent, readResumeDraft,
  resultText, resumeChecks, resumeStrings, type ResumeSources,
} from './resume-content.js';
import { RESUME_HEADINGS, renderResumePdf, scriptRuns } from './resume-pdf.js';

const Q_VERIFIED = '11111111-1111-4111-8111-111111111111';
const Q_SELF = '22222222-2222-4222-8222-222222222222';
const Q_PENDING = '33333333-3333-4333-8333-333333333333';
const Q_NO_ISSUER = '44444444-4444-4444-8444-444444444444';
const T_VERIFIED = '55555555-5555-4555-8555-555555555555';
const T_SELF = '66666666-6666-4666-8666-666666666666';
const SKILL = '77777777-7777-4777-8777-777777777777';
const CERT = '88888888-8888-4888-8888-888888888888';
const TARGET = '99999999-9999-4999-8999-999999999999';
const STRANGER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COLLEGE = 'Synthetic Institute of Technology';

/** Words that must never appear in anything ONE writes on a résumé. */
export const FORBIDDEN = /readiness|\bscore|\bband\b|mastery|\bstage\b|percentile|\brank/i;

const sources: ResumeSources = {
  email: 'student@example.test', fullName: 'Synthetic Student', headline: 'Final-year student', summary: null, portfolioUrl: null,
  qualifications: [
    { id: Q_VERIFIED, qualificationType: 'BTECH', programmeName: 'Computer Science', institutionName: COLLEGE, issuerName: COLLEGE,
      startedOn: '2022-07-01', completedOn: null, awarded: false, state: 'VERIFIED',
      terms: [
        { id: T_VERIFIED, label: 'Semester 1', resultValue: 8.2, resultScale: 'CGPA_10', resultLetter: null, state: 'VERIFIED', issuerName: COLLEGE },
        { id: T_SELF, label: 'Semester 2', resultValue: 81.5, resultScale: 'PERCENTAGE', resultLetter: null, state: 'SELF_REPORTED', issuerName: COLLEGE },
      ] },
    { id: Q_SELF, qualificationType: 'OTHER', programmeName: 'Class XII', institutionName: 'Synthetic Junior College', issuerName: null,
      startedOn: '2020-06-01', completedOn: '2022-04-30', awarded: true, state: 'SELF_REPORTED', terms: [] },
    { id: Q_PENDING, qualificationType: 'DIPLOMA', programmeName: 'Data Analytics', institutionName: COLLEGE, issuerName: COLLEGE,
      startedOn: '2023-01-01', completedOn: null, awarded: false, state: 'PENDING_VERIFICATION', terms: [] },
    // A VERIFIED state without an issuing organisation cannot be shown as verified (0070 forbids it; we do not trust it).
    { id: Q_NO_ISSUER, qualificationType: 'BSC', programmeName: 'Mathematics', institutionName: 'Elsewhere', issuerName: null,
      startedOn: null, completedOn: null, awarded: false, state: 'VERIFIED', terms: [] },
  ],
  skills: [{ topicId: SKILL, name: 'SQL joins', sources: ['ONE_SKILL_CHECK'], latestAt: '2026-09-12T10:00:00Z' }],
  certificates: [{ id: CERT, title: 'Cloud basics', description: 'Online course' }],
  careerTargets: [{ id: TARGET, roleTitle: 'Data Analyst' }],
};

const draftBody = {
  title: 'Campus drives', template: 'CLASSIC',
  header: { fullName: 'Synthetic Student', headline: 'Final-year student', phone: '+91 90000 00000', location: 'Hyderabad', showEmail: true,
    links: [{ label: 'GitHub', url: 'https://github.com/example' }] },
  summary: 'I build small data tools.',
  qualificationIds: [Q_VERIFIED, Q_SELF, Q_PENDING, Q_NO_ISSUER, STRANGER],
  termIds: [T_VERIFIED, T_SELF, STRANGER],
  skillTopicIds: [SKILL, STRANGER], certificateIds: [CERT, STRANGER], careerTargetIds: [TARGET, STRANGER],
  declaredSkills: ['Python', 'python', 'Excel'], projects: [{ title: 'Attendance tracker', description: '- a web app', url: 'https://example.test/p' }],
  languages: ['English', 'తెలుగు'],
};

describe('résumé draft', () => {
  it('accepts a full draft and de-duplicates lists', () => {
    const draft = readResumeDraft(draftBody);
    expect(draft.declaredSkills).toEqual(['Python', 'Excel']);
    expect(draft.header.showEmail).toBe(true);
    expect(draft.projects[0]?.description).toBe('- a web app');
  });

  it.each([
    [{ ...draftBody, title: '' }, 'TITLE_REQUIRED'],
    [{ ...draftBody, template: 'FANCY' }, 'INVALID_TEMPLATE'],
    [{ ...draftBody, readiness: 'HIGH' }, 'UNKNOWN_FIELD'],
    [{ ...draftBody, header: { ...draftBody.header, verified: true } }, 'UNKNOWN_FIELD'],
    [{ ...draftBody, header: { ...draftBody.header, phone: '12' } }, 'INVALID_PHONE'],
    [{ ...draftBody, header: { ...draftBody.header, links: [{ url: 'http://insecure.test' }] } }, 'INVALID_URL'],
    [{ ...draftBody, header: { ...draftBody.header, links: [{ url: 'javascript:alert(1)' }] } }, 'INVALID_URL'],
    [{ ...draftBody, qualificationIds: ['not-a-uuid'] }, 'INVALID_SELECTION'],
    [{ ...draftBody, summary: 'x'.repeat(1201) }, 'INVALID_TEXT'],
    [{ ...draftBody, title: '=HYPERLINK("x")' }, 'INVALID_TEXT'],
    [{ ...draftBody, projects: Array.from({ length: 11 }, () => ({ title: 'p' })) }, 'INVALID_PROJECTS'],
  ])('refuses %#', (body, code) => {
    expect(() => readResumeDraft(body)).toThrowError(ResumeInputError);
    try { readResumeDraft(body); } catch (error) { expect((error as ResumeInputError).code).toBe(code); }
  });
});

describe('résumé content', () => {
  const content = buildResumeContent(sources, readResumeDraft(draftBody), new Date('2026-10-01T09:00:00Z'));

  it('labels "Verified by" only a VERIFIED record with an issuing institution', () => {
    const byTitle = Object.fromEntries(content.education.map((entry) => [entry.title, entry]));
    expect(byTitle['B.Tech — Computer Science']).toMatchObject({ verification: `Verified by ${COLLEGE}`, verified: true, period: '2022 – present', status: 'In progress' });
    expect(byTitle['Class XII']).toMatchObject({ verification: LABEL_SELF_DECLARED, verified: false, status: 'Awarded' });
    expect(byTitle['Diploma — Data Analytics']).toMatchObject({ verification: LABEL_PENDING, verified: false });
    expect(byTitle['B.Sc. — Mathematics']).toMatchObject({ verification: LABEL_SELF_DECLARED, verified: false });
    for (const entry of content.education) {
      if (!entry.verified) expect(entry.verification).not.toMatch(/^Verified/);
    }
  });

  it('shows term results as issued and labels each one', () => {
    const results = content.education[0]?.results ?? [];
    expect(results).toEqual([
      { label: 'Semester 1', result: '8.20 CGPA (of 10)', verification: `Verified by ${COLLEGE}`, verified: true },
      { label: 'Semester 2', result: '81.5%', verification: LABEL_SELF_DECLARED, verified: false },
    ]);
    expect(resultText({ resultValue: null, resultScale: 'PASS_FAIL', resultLetter: 'Pass' })).toBe('Pass');
  });

  it('ignores an id that is not among the student’s own records', () => {
    expect(content.education).toHaveLength(4);
    expect(content.skills.shown).toEqual([{ name: 'SQL joins', basis: 'Shown in ONE skill checks, Sep 2026' }]);
    expect(content.certificates).toEqual([{ title: 'Cloud basics', description: 'Online course', verification: LABEL_SELF_DECLARED }]);
    expect(content.objective).toEqual(['Data Analyst']);
  });

  it('never presents a certificate or a typed item as verified', () => {
    expect(content.certificates.every((certificate) => certificate.verification === LABEL_SELF_DECLARED)).toBe(true);
    const verifiedLines = resumeStrings(content).filter((line) => line.startsWith('Verified by'));
    expect(verifiedLines).toEqual([`Verified by ${COLLEGE}`, `Verified by ${COLLEGE}`]);
  });

  it('hides the email unless the student shows it', () => {
    const hidden = buildResumeContent(sources, readResumeDraft({ ...draftBody, header: { ...draftBody.header, showEmail: false } }), new Date());
    expect(hidden.header.email).toBeNull();
  });

  it('checks completeness without a number', () => {
    const checks = resumeChecks(content);
    expect(checks.every((check) => typeof check.passed === 'boolean' && Object.keys(check).sort().join() === 'key,message,passed')).toBe(true);
    const empty = resumeChecks(buildResumeContent(sources, readResumeDraft({ title: 'Empty', header: { showEmail: false } }), new Date()));
    expect(empty.filter((check) => !check.passed).map((check) => check.key))
      .toEqual(['NAME', 'EMAIL', 'PHONE', 'SUMMARY', 'EDUCATION', 'VERIFIED_EDUCATION', 'SKILLS', 'PROJECTS']);
    expect(JSON.stringify(checks)).not.toMatch(/\d/);
  });

  it('contract: no readiness, band, score, mastery or stage in anything ONE writes', () => {
    expect(Object.keys(content).sort()).toEqual(['certificates', 'education', 'generatedOn', 'header', 'languages', 'legend', 'objective',
      'projects', 'schemaVersion', 'skills', 'summary', 'template']);
    for (const line of resumeStrings(content)) expect(line).not.toMatch(FORBIDDEN);
    for (const fixed of [...Object.values(RESUME_HEADINGS), RESUME_LEGEND, LABEL_PENDING, LABEL_SELF_DECLARED,
      ...RESUME_TEMPLATE_INFO.flatMap((template) => [template.name, template.description]),
      ...resumeChecks(content).map((check) => check.message)]) {
      expect(fixed).not.toMatch(FORBIDDEN);
    }
  });
});

/**
 * The Title/Author/Subject/Creator strings of a PDF. pdfkit writes each as an indirect object holding a
 * literal string, UTF-16BE with a byte-order mark when it is not plain ASCII.
 */
function pdfInfo(pdf: Buffer): Record<string, string> {
  const file = pdf.toString('latin1');
  const out: Record<string, string> = {};
  for (const [, key, ref] of file.matchAll(/\/(Title|Author|Subject|Creator) (\d+) 0 R/g)) {
    const object = new RegExp(`(?:^|\\n)${ref} 0 obj\\n\\(([\\s\\S]*?)\\)\\nendobj`).exec(file);
    if (!key || !object) continue;
    const raw = (object[1] ?? '').replace(/\\([0-7]{1,3}|[\s\S])/g, (_, escaped: string) => {
      if (/^[0-7]+$/.test(escaped)) return String.fromCharCode(parseInt(escaped, 8));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[escaped] ?? escaped;
    });
    const bytes = Buffer.from(raw, 'latin1');
    out[key] = bytes[0] === 0xfe && bytes[1] === 0xff ? Buffer.from(bytes.subarray(2)).swap16().toString('utf16le') : raw;
  }
  return out;
}

describe('résumé PDF', () => {
  it.each(['CLASSIC', 'MODERN', 'COMPACT'])('renders %s, drawing only résumé strings and fixed headings', async (template) => {
    const content = buildResumeContent(sources, readResumeDraft({ ...draftBody, template }), new Date('2026-10-01T09:00:00Z'));
    const drawn: string[] = [];
    const pdf = await renderResumePdf(content, { onText: (text) => drawn.push(text) });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeLessThan(400_000);
    for (const text of drawn) expect(text).not.toMatch(FORBIDDEN);
    const all = drawn.join('\n');
    for (const line of resumeStrings(content).filter((value) => value !== content.legend)) expect(all).toContain(line);
    expect(all).toContain(`Verified by ${COLLEGE}`);
    expect(all).not.toContain(STRANGER);
    // The document information is the one plain-text part of the file.
    const info = pdfInfo(pdf);
    expect(info.Title).toBe('Synthetic Student — Résumé');
    for (const value of Object.values(info)) expect(value).not.toMatch(FORBIDDEN);
  });

  it('draws Telugu in its own runs', () => {
    expect(scriptRuns('రవి Kumar (తెలుగు)')).toEqual([
      { telugu: true, text: 'రవి ' }, { telugu: false, text: 'Kumar (' }, { telugu: true, text: 'తెలుగు)' },
    ]);
  });

  it('renders a long résumé across pages', async () => {
    const long = buildResumeContent(sources, readResumeDraft({
      ...draftBody,
      projects: Array.from({ length: 10 }, (_, index) => ({ title: `Project ${index + 1}`, description: 'A description. '.repeat(50) })),
    }), new Date());
    const pdf = await renderResumePdf(long);
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
