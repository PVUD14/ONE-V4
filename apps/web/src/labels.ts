/**
 * ONE · Display labels for codes
 *
 * The API speaks in codes (PLACEMENT_ADMIN, TRANSFERRED, DEPARTMENT). People should
 * never read those. Every place that shows a role, status or kind to a user runs it
 * through here, so the same code reads the same way on every screen.
 */

const roleNames: Readonly<Record<string, string>> = {
  STUDENT: 'Student',
  GRADUATE: 'Graduate',
  INSTITUTION_OWNER: 'Institution Owner',
  INSTITUTION_ADMIN: 'Institution Admin',
  INSTITUTION_ANALYST: 'Institution Analyst',
  PLACEMENT_ADMIN: 'Placement Officer',
  PLACEMENT_OFFICER: 'Placement Officer',
  DEPARTMENT_HEAD: 'Department Head',
  FACULTY_LECTURER: 'Lecturer',
  CAREER_COUNSELOR: 'Career Counsellor',
  EMPLOYER_OWNER: 'Employer Owner',
  EMPLOYER_ADMIN: 'Employer Admin',
  RECRUITER: 'Recruiter',
  HIRING_MANAGER: 'Hiring Manager',
  INTERVIEWER: 'Interviewer',
  OPERATIONS_ADMIN: 'Operations Admin',
  PLATFORM_SUPER_ADMIN: 'Platform Super Admin',
  SECURITY_ADMIN: 'Security Admin',
  SUPPORT_AGENT: 'Support Agent',
  GROWTH_EXECUTIVE: 'Growth Executive',
  GROWTH_MANAGER: 'Regional Manager',
  GROWTH_ADMIN: 'Growth Admin',
};

/** Words that keep their capitals when a code is humanised. */
const acronyms = new Set(['AI', 'API', 'CGPA', 'CSV', 'GD', 'HR', 'ID', 'MRO', 'NA', 'ONE', 'PDF', 'URL']);

const NA = 'NA';

/** A role code as a job title: "PLACEMENT_ADMIN" → "Placement Officer". */
export function roleLabel(code: string | null | undefined): string {
  if (!code) return NA;
  return roleNames[code] ?? titleCase(code);
}

/**
 * Any other code — a status, a kind, a stage — as plain words in sentence case,
 * matching how the rest of ONE writes them: "TRANSFERRED" → "Transferred",
 * "UNDER_REVIEW" → "Under review", "DEPARTMENT" → "Department".
 */
export function codeLabel(code: string | null | undefined): string {
  if (!code) return NA;
  if (!/^[A-Z0-9_]+$/.test(code)) return code;
  const words = code.split('_').filter(Boolean).map((word) => acronyms.has(word) ? word : word.toLowerCase());
  const [first, ...rest] = words;
  if (!first) return NA;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

function titleCase(code: string): string {
  if (!/^[A-Z0-9_]+$/.test(code)) return code;
  return code.split('_').filter(Boolean)
    .map((word) => acronyms.has(word) ? word : word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ') || NA;
}
