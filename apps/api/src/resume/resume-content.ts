/**
 * The résumé a student generates from their own ONE record (RESUME-GEN): what a draft may contain, how the
 * student's records become résumé lines and labels, and the completeness checks. Pure, so the rules that
 * matter — only the student's own records, "Verified by" only where an institution stood behind the record,
 * never readiness, a band, a score, a stage or an identifier — live in one unit-tested place.
 *
 * Design: docs/architecture/student-resumes-table-design.md.
 */
import { createHash } from 'node:crypto';

export const RESUME_SCHEMA_VERSION = 1;
export const RESUME_TEMPLATES = ['CLASSIC', 'MODERN', 'COMPACT'] as const;
export type ResumeTemplate = typeof RESUME_TEMPLATES[number];

export const RESUME_TEMPLATE_INFO: readonly { readonly key: ResumeTemplate; readonly name: string; readonly description: string }[] = [
  { key: 'CLASSIC', name: 'Classic', description: 'One column, centred name, a thin rule between sections. Reads well everywhere and prints cleanly.' },
  { key: 'MODERN', name: 'Modern', description: 'A coloured header strip with your name and contact line, and accent-coloured section headings.' },
  { key: 'COMPACT', name: 'Compact', description: 'Smaller type and tighter spacing, so a full record still fits on one page.' },
];

export const RESUME_LIMITS = {
  title: 120, fullName: 160, headline: 160, phone: 20, location: 80, links: 5, linkLabel: 60, url: 256,
  summary: 1200, projects: 10, projectTitle: 120, projectDescription: 800,
  declaredSkills: 30, languages: 10, shortItem: 60,
  qualifications: 20, terms: 60, skills: 40, certificates: 20, careerTargets: 3,
  contentBytes: 65536, selectionsBytes: 32768,
} as const;

/** Labels. Fixed strings, so the contract test can see every word ONE itself puts on a résumé. */
export const LABEL_SELF_DECLARED = 'Self-declared';
export const LABEL_PENDING = 'Self-declared · verification pending';
export const verifiedByLabel = (institution: string): string => `Verified by ${institution}`;
export const SKILL_BASIS = {
  ONE_SKILL_CHECK: 'Shown in ONE skill checks',
  INSTITUTION_EXAM: 'Shown in an institution exam',
  ONE_RECORD: 'Shown in graded work on ONE',
} as const;
export type SkillSource = keyof typeof SKILL_BASIS;
export const RESUME_LEGEND = '“Verified by” marks a record the named institution confirmed in ONE. Every other item is self-declared.';

const QUALIFICATION_NAMES: Readonly<Record<string, string>> = {
  BTECH: 'B.Tech', BE: 'B.E.', BSC: 'B.Sc.', BA: 'B.A.', BCOM: 'B.Com.', BBA: 'BBA', BCA: 'BCA', MBBS: 'MBBS', BDS: 'BDS',
  DIPLOMA: 'Diploma', MTECH: 'M.Tech', ME: 'M.E.', MBA: 'MBA', MSC: 'M.Sc.', MA: 'M.A.', MCOM: 'M.Com.', MCA: 'MCA', PHD: 'Ph.D.', OTHER: '',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// Sources: the student's own records, read by resume-sources.ts
// ---------------------------------------------------------------------------

export interface VerificationSource {
  readonly state: string;
  /** The issuing ONE organisation's name; null for prior education declared by name only. */
  readonly issuerName: string | null;
}

export interface TermSource extends VerificationSource {
  readonly id: string;
  readonly label: string;
  readonly resultValue: number | null;
  readonly resultScale: string | null;
  readonly resultLetter: string | null;
}

export interface QualificationSource extends VerificationSource {
  readonly id: string;
  readonly qualificationType: string;
  readonly programmeName: string;
  /** The ONE organisation's name, or the name the student declared. */
  readonly institutionName: string | null;
  readonly startedOn: string | null;
  readonly completedOn: string | null;
  readonly awarded: boolean;
  readonly terms: readonly TermSource[];
}

export interface SkillEvidenceSource {
  readonly topicId: string;
  readonly name: string;
  readonly sources: readonly SkillSource[];
  /** ISO timestamp of the latest qualifying item. */
  readonly latestAt: string;
}

export interface CertificateSource { readonly id: string; readonly title: string; readonly description: string | null }
export interface CareerTargetSource { readonly id: string; readonly roleTitle: string }

export interface ResumeSources {
  readonly email: string;
  readonly fullName: string | null;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly portfolioUrl: string | null;
  readonly qualifications: readonly QualificationSource[];
  readonly skills: readonly SkillEvidenceSource[];
  readonly certificates: readonly CertificateSource[];
  readonly careerTargets: readonly CareerTargetSource[];
}

// ---------------------------------------------------------------------------
// The draft: what the student ticked and typed
// ---------------------------------------------------------------------------

export interface ResumeLink { readonly label: string | null; readonly url: string }
export interface ResumeProject { readonly title: string; readonly description: string | null; readonly url: string | null }

export interface ResumeDraft {
  readonly title: string;
  readonly template: ResumeTemplate;
  readonly header: {
    readonly fullName: string | null;
    readonly headline: string | null;
    readonly phone: string | null;
    readonly location: string | null;
    readonly showEmail: boolean;
    readonly links: readonly ResumeLink[];
  };
  readonly summary: string | null;
  readonly qualificationIds: readonly string[];
  readonly termIds: readonly string[];
  readonly skillTopicIds: readonly string[];
  readonly certificateIds: readonly string[];
  readonly careerTargetIds: readonly string[];
  readonly declaredSkills: readonly string[];
  readonly projects: readonly ResumeProject[];
  readonly languages: readonly string[];
}

export class ResumeInputError extends Error {
  constructor(readonly code: string, readonly field?: string) { super(code); this.name = 'ResumeInputError'; }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const phonePattern = /^\+?[0-9][0-9 ()-]{5,18}[0-9]$/;
const dangerousPrefix = /^[=+@-]/;
// Control characters other than newline and tab never reach a PDF.
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const DRAFT_KEYS = ['title', 'template', 'header', 'summary', 'qualificationIds', 'termIds', 'skillTopicIds', 'certificateIds',
  'careerTargetIds', 'declaredSkills', 'projects', 'languages'];
const HEADER_KEYS = ['fullName', 'headline', 'phone', 'location', 'showEmail', 'links'];

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ResumeInputError('INVALID_RESUME', field);
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new ResumeInputError('UNKNOWN_FIELD', field);
}

/** Optional text: trimmed, null when empty, bounded, never a formula prefix or a control character. */
function text(value: unknown, max: number, field: string, multiline = false): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ResumeInputError('INVALID_TEXT', field);
  const trimmed = (multiline ? value.replace(/\r\n?/g, '\n') : value.replace(/\s+/g, ' ')).trim();
  if (trimmed === '') return null;
  // A paragraph may open with a dash (a list); a single-line field may not open like a spreadsheet formula.
  if (trimmed.length > max || controlCharacters.test(trimmed) || (!multiline && dangerousPrefix.test(trimmed))) throw new ResumeInputError('INVALID_TEXT', field);
  return trimmed;
}

function httpsUrl(value: unknown, field: string): string | null {
  const url = text(value, RESUME_LIMITS.url, field);
  if (url === null) return null;
  if (!/^https:\/\/[^\s]+$/i.test(url)) throw new ResumeInputError('INVALID_URL', field);
  try { if (new URL(url).protocol !== 'https:') throw new Error('protocol'); } catch { throw new ResumeInputError('INVALID_URL', field); }
  return url;
}

function ids(value: unknown, max: number, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new ResumeInputError('INVALID_SELECTION', field);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !uuidPattern.test(entry)) throw new ResumeInputError('INVALID_SELECTION', field);
    seen.add(entry.toLowerCase());
  }
  return [...seen];
}

function shortList(value: unknown, max: number, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new ResumeInputError('INVALID_LIST', field);
  const out: string[] = [];
  for (const entry of value) {
    const item = text(entry, RESUME_LIMITS.shortItem, field);
    if (item !== null && !out.some((existing) => existing.toLowerCase() === item.toLowerCase())) out.push(item);
  }
  return out;
}

/** Validates a draft from the client. Throws ResumeInputError with a field; never echoes the value. */
export function readResumeDraft(body: unknown): ResumeDraft {
  const record = asRecord(body, 'body');
  onlyKeys(record, DRAFT_KEYS, 'body');
  const title = text(record.title, RESUME_LIMITS.title, 'title');
  if (title === null) throw new ResumeInputError('TITLE_REQUIRED', 'title');
  const template = record.template ?? 'CLASSIC';
  if (typeof template !== 'string' || !(RESUME_TEMPLATES as readonly string[]).includes(template)) throw new ResumeInputError('INVALID_TEMPLATE', 'template');

  const header = asRecord(record.header ?? {}, 'header');
  onlyKeys(header, HEADER_KEYS, 'header');
  let phone: string | null = null;
  if (header.phone !== undefined && header.phone !== null && header.phone !== '') {
    if (typeof header.phone !== 'string') throw new ResumeInputError('INVALID_PHONE', 'header.phone');
    const trimmed = header.phone.trim();
    if (!phonePattern.test(trimmed) || (trimmed.match(/[0-9]/g) ?? []).length < 7) throw new ResumeInputError('INVALID_PHONE', 'header.phone');
    phone = trimmed;
  }
  if (header.showEmail !== undefined && typeof header.showEmail !== 'boolean') throw new ResumeInputError('INVALID_RESUME', 'header.showEmail');
  const links: ResumeLink[] = [];
  if (header.links !== undefined && header.links !== null) {
    if (!Array.isArray(header.links) || header.links.length > RESUME_LIMITS.links) throw new ResumeInputError('INVALID_LINKS', 'header.links');
    for (const entry of header.links) {
      const link = asRecord(entry, 'header.links');
      onlyKeys(link, ['label', 'url'], 'header.links');
      const url = httpsUrl(link.url, 'header.links');
      if (url === null) throw new ResumeInputError('INVALID_URL', 'header.links');
      if (!links.some((existing) => existing.url === url)) links.push({ label: text(link.label, RESUME_LIMITS.linkLabel, 'header.links'), url });
    }
  }

  const projects: ResumeProject[] = [];
  if (record.projects !== undefined && record.projects !== null) {
    if (!Array.isArray(record.projects) || record.projects.length > RESUME_LIMITS.projects) throw new ResumeInputError('INVALID_PROJECTS', 'projects');
    for (const entry of record.projects) {
      const project = asRecord(entry, 'projects');
      onlyKeys(project, ['title', 'description', 'url'], 'projects');
      const projectTitle = text(project.title, RESUME_LIMITS.projectTitle, 'projects');
      if (projectTitle === null) throw new ResumeInputError('PROJECT_TITLE_REQUIRED', 'projects');
      projects.push({ title: projectTitle, description: text(project.description, RESUME_LIMITS.projectDescription, 'projects', true), url: httpsUrl(project.url, 'projects') });
    }
  }

  return {
    title,
    template: template as ResumeTemplate,
    header: {
      fullName: text(header.fullName, RESUME_LIMITS.fullName, 'header.fullName'),
      headline: text(header.headline, RESUME_LIMITS.headline, 'header.headline'),
      phone,
      location: text(header.location, RESUME_LIMITS.location, 'header.location'),
      showEmail: header.showEmail !== false,
      links,
    },
    summary: text(record.summary, RESUME_LIMITS.summary, 'summary', true),
    qualificationIds: ids(record.qualificationIds, RESUME_LIMITS.qualifications, 'qualificationIds'),
    termIds: ids(record.termIds, RESUME_LIMITS.terms, 'termIds'),
    skillTopicIds: ids(record.skillTopicIds, RESUME_LIMITS.skills, 'skillTopicIds'),
    certificateIds: ids(record.certificateIds, RESUME_LIMITS.certificates, 'certificateIds'),
    careerTargetIds: ids(record.careerTargetIds, RESUME_LIMITS.careerTargets, 'careerTargetIds'),
    declaredSkills: shortList(record.declaredSkills, RESUME_LIMITS.declaredSkills, 'declaredSkills'),
    projects,
    languages: shortList(record.languages, RESUME_LIMITS.languages, 'languages'),
  };
}

// ---------------------------------------------------------------------------
// Content: the résumé as drawn
// ---------------------------------------------------------------------------

export interface ResumeResultLine { readonly label: string; readonly result: string; readonly verification: string; readonly verified: boolean }

export interface ResumeEducationEntry {
  readonly title: string;
  readonly institution: string | null;
  readonly period: string | null;
  readonly status: string | null;
  readonly verification: string;
  readonly verified: boolean;
  readonly results: readonly ResumeResultLine[];
}

export interface ResumeContentV1 {
  readonly schemaVersion: 1;
  readonly template: ResumeTemplate;
  readonly header: {
    readonly fullName: string | null;
    readonly headline: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly location: string | null;
    readonly links: readonly ResumeLink[];
  };
  readonly summary: string | null;
  readonly objective: readonly string[];
  readonly education: readonly ResumeEducationEntry[];
  readonly skills: { readonly shown: readonly { readonly name: string; readonly basis: string }[]; readonly declared: readonly string[] };
  readonly projects: readonly ResumeProject[];
  readonly certificates: readonly { readonly title: string; readonly description: string | null; readonly verification: string }[];
  readonly languages: readonly string[];
  readonly legend: string;
  /** YYYY-MM-DD. */
  readonly generatedOn: string;
}

/** The label for a record: "Verified by" only when VERIFIED and an issuing ONE organisation stands behind it. */
export function verificationLabel(source: VerificationSource): { readonly verification: string; readonly verified: boolean } {
  if (source.state === 'VERIFIED' && source.issuerName) return { verification: verifiedByLabel(source.issuerName), verified: true };
  if (source.state === 'PENDING_VERIFICATION') return { verification: LABEL_PENDING, verified: false };
  return { verification: LABEL_SELF_DECLARED, verified: false };
}

export function qualificationTitle(type: string, programme: string): string {
  const name = QUALIFICATION_NAMES[type] ?? '';
  return name ? `${name} — ${programme}` : programme;
}

function yearOf(date: string | null): string | null {
  const match = date ? /^(\d{4})-(\d{2})/.exec(date) : null;
  return match ? match[1]! : null;
}

export function periodOf(started: string | null, completed: string | null): string | null {
  const from = yearOf(started);
  const to = yearOf(completed);
  if (from && to) return from === to ? from : `${from} – ${to}`;
  if (from) return `${from} – present`;
  return to;
}

/** The result as the institution issued it, on its own scale. Never converted. */
export function resultText(term: Pick<TermSource, 'resultValue' | 'resultScale' | 'resultLetter'>): string | null {
  const value = term.resultValue;
  switch (term.resultScale) {
    case 'CGPA_10': return value == null ? null : `${value.toFixed(2)} CGPA (of 10)`;
    case 'GPA_4': return value == null ? null : `${value.toFixed(2)} GPA (of 4)`;
    case 'PERCENTAGE': return value == null ? null : `${Number(value.toFixed(2))}%`;
    case 'LETTER': return term.resultLetter ? `Grade ${term.resultLetter}` : null;
    case 'PASS_FAIL': return term.resultLetter ? term.resultLetter : null;
    default: return null;
  }
}

export function monthOf(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function skillBasis(skill: SkillEvidenceSource): string {
  // A skill shown in more than one place names the first, in a fixed order, so the line stays short and stable.
  const order: readonly SkillSource[] = ['INSTITUTION_EXAM', 'ONE_SKILL_CHECK', 'ONE_RECORD'];
  const source = order.find((candidate) => skill.sources.includes(candidate)) ?? 'ONE_RECORD';
  const month = monthOf(skill.latestAt);
  return month ? `${SKILL_BASIS[source]}, ${month}` : SKILL_BASIS[source];
}

/**
 * Builds the résumé from the student's own records and the draft. A selected id that is not among the
 * student's own records is ignored: the sources were read for this student only, so another person's
 * record cannot be reached through an id.
 */
export function buildResumeContent(sources: ResumeSources, draft: ResumeDraft, today: Date): ResumeContentV1 {
  const chosen = (list: readonly string[]) => new Set(list.map((id) => id.toLowerCase()));
  const qualificationIds = chosen(draft.qualificationIds);
  const termIds = chosen(draft.termIds);
  const skillIds = chosen(draft.skillTopicIds);
  const certificateIds = chosen(draft.certificateIds);
  const targetIds = chosen(draft.careerTargetIds);

  const education = sources.qualifications
    .filter((q) => qualificationIds.has(q.id.toLowerCase()) && q.state !== 'REJECTED')
    .map((q): ResumeEducationEntry => ({
      title: qualificationTitle(q.qualificationType, q.programmeName),
      institution: q.institutionName,
      period: periodOf(q.startedOn, q.completedOn),
      status: q.awarded ? 'Awarded' : q.completedOn ? null : 'In progress',
      ...verificationLabel(q),
      results: q.terms
        .filter((t) => termIds.has(t.id.toLowerCase()) && t.state !== 'REJECTED')
        .flatMap((t) => {
          const result = resultText(t);
          return result ? [{ label: t.label, result, ...verificationLabel({ state: t.state, issuerName: q.issuerName }) }] : [];
        }),
    }));

  return {
    schemaVersion: RESUME_SCHEMA_VERSION,
    template: draft.template,
    header: {
      fullName: draft.header.fullName,
      headline: draft.header.headline,
      email: draft.header.showEmail && sources.email ? sources.email : null,
      phone: draft.header.phone,
      location: draft.header.location,
      links: draft.header.links.map((link) => ({ label: link.label, url: link.url })),
    },
    summary: draft.summary,
    objective: sources.careerTargets.filter((t) => targetIds.has(t.id.toLowerCase())).map((t) => t.roleTitle),
    education,
    skills: {
      shown: sources.skills.filter((s) => skillIds.has(s.topicId.toLowerCase())).map((s) => ({ name: s.name, basis: skillBasis(s) })),
      declared: [...draft.declaredSkills],
    },
    projects: draft.projects.map((p) => ({ title: p.title, description: p.description, url: p.url })),
    certificates: sources.certificates.filter((c) => certificateIds.has(c.id.toLowerCase()))
      .map((c) => ({ title: c.title, description: c.description, verification: LABEL_SELF_DECLARED })),
    languages: [...draft.languages],
    legend: RESUME_LEGEND,
    generatedOn: today.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Completeness checks — never a score
// ---------------------------------------------------------------------------

export interface ResumeCheck { readonly key: string; readonly passed: boolean; readonly message: string }

/** Objective checks on the résumé as built. Each is passed or not; there is no total and no number. */
export function resumeChecks(content: ResumeContentV1): ResumeCheck[] {
  const check = (key: string, passed: boolean, message: string): ResumeCheck => ({ key, passed, message });
  return [
    check('NAME', content.header.fullName !== null, 'Your name is at the top.'),
    check('EMAIL', content.header.email !== null, 'A contact email is shown.'),
    check('PHONE', content.header.phone !== null, 'A phone number is shown.'),
    check('SUMMARY', content.summary !== null, 'A short summary says who you are and what you want to do.'),
    check('EDUCATION', content.education.length > 0, 'At least one education entry is included.'),
    check('VERIFIED_EDUCATION', content.education.some((entry) => entry.verified), 'At least one education entry is verified by an institution.'),
    check('SKILLS', content.skills.shown.length + content.skills.declared.length > 0, 'At least one skill is listed.'),
    check('PROJECTS', content.projects.length > 0, 'At least one project is described.'),
  ];
}

/** Every string ONE draws on the résumé, in order. The PDF renderer draws exactly these (and the contract test reads them). */
export function resumeStrings(content: ResumeContentV1): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => { if (value) out.push(value); };
  push(content.header.fullName); push(content.header.headline); push(content.header.email); push(content.header.phone); push(content.header.location);
  content.header.links.forEach((link) => { push(link.label); push(link.url); });
  push(content.summary);
  content.objective.forEach(push);
  content.education.forEach((entry) => {
    push(entry.title); push(entry.institution); push(entry.period); push(entry.status); push(entry.verification);
    entry.results.forEach((line) => { push(line.label); push(line.result); push(line.verification); });
  });
  content.skills.shown.forEach((skill) => { push(skill.name); push(skill.basis); });
  content.skills.declared.forEach(push);
  content.projects.forEach((project) => { push(project.title); push(project.description); push(project.url); });
  content.certificates.forEach((certificate) => { push(certificate.title); push(certificate.description); push(certificate.verification); });
  content.languages.forEach(push);
  push(content.legend);
  return out;
}

/** JSON with object keys sorted at every level, so the hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function contentHash(content: ResumeContentV1): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/** The draft as stored beside a version, so "edit" starts from the student's last choices. */
export function draftToSelections(draft: ResumeDraft): Record<string, unknown> {
  return JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
}
