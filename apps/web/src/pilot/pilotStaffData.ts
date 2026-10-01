import { pilotCompanies, pilotPersona, type PilotCompany } from './pilotData.js';

/**
 * Institution and employer pilot datasets.
 *
 * Coherence across portals is the point: the student the client just saw as Arjun
 * appears in the placement officer's roster in the same readiness band, and in
 * Zenvia Labs' applicant pipeline at the stage the story implies. Numbers roll up:
 * cohort counts include him, company pipelines include him, nothing contradicts the
 * student screens.
 */

// --- Institution: Placement Officer at Arjun's college -----------------------

export const pilotInstitutionPersona = {
  name: 'Prof. Meera Nair',
  initials: 'MN',
  role: 'Placement Officer',
  institution: pilotPersona.institution,
  subtitle: 'Placement Cell',
} as const;

export const pilotCohort = {
  activeStudents: 1284,
  placementEligible: 412,
  placedSoFar: 86,
  offersThisSeason: 103,
  atRisk: 57,
} as const;

/** The real application's four advisory bands; readiness is never shown as a number. */
export type PilotReadinessBand = 'Ready for next step' | 'Progressing' | 'Developing' | 'Not enough evidence';

export const pilotReadinessBands = [
  { label: 'Ready for next step', value: 118, color: '#0d6b4f' },
  { label: 'Progressing', value: 171, color: '#1f55e5' },
  { label: 'Developing', value: 84, color: '#b45309' },
  { label: 'Not enough evidence', value: 39, color: '#64748b' },
] as const;

export interface PilotRosterStudent {
  readonly name: string;
  readonly initials: string;
  readonly registration: string;
  readonly department: string;
  readonly batch: string;
  readonly band: PilotReadinessBand;
  readonly status: string;
}

export const pilotRoster: readonly PilotRosterStudent[] = [
  // The same Arjun the client just met, in the same readiness band.
  { name: pilotPersona.name, initials: pilotPersona.initials, registration: 'LIT2027-0412', department: 'CSE', batch: '2027', band: 'Progressing', status: `Shortlisted · Zenvia Labs` },
  { name: 'Priya Sharma', initials: 'PS', registration: 'LIT2027-0388', department: 'CSE', batch: '2027', band: 'Ready for next step', status: 'Offer · Kortex Systems' },
  { name: 'Karthik Menon', initials: 'KM', registration: 'LIT2027-0521', department: 'ECE', batch: '2027', band: 'Developing', status: 'Applied · 3 roles' },
  { name: 'Sneha Iyer', initials: 'SI', registration: 'LIT2027-0176', department: 'IT', batch: '2027', band: 'Progressing', status: 'Interview · BlueRiver' },
  { name: 'Aditya Rao', initials: 'ADR', registration: 'LIT2027-0644', department: 'MECH', batch: '2027', band: 'Developing', status: 'No applications yet' },
  { name: 'Fatima Khan', initials: 'FK', registration: 'LIT2027-0233', department: 'CSE', batch: '2027', band: 'Ready for next step', status: 'Offer accepted · Veridian' },
  { name: 'Rohit Verma', initials: 'RV', registration: 'LIT2027-0590', department: 'EEE', batch: '2027', band: 'Not enough evidence', status: 'Intervention assigned' },
];

/** Placed alumni from the previous batch, so the batch filter has real data. */
export const pilotRosterAlumni: readonly PilotRosterStudent[] = [
  { name: 'Deepak Raju', initials: 'DR', registration: 'LIT2026-0218', department: 'CSE', batch: '2026', band: 'Ready for next step', status: 'Placed · Kortex Systems' },
  { name: 'Lakshmi Priya', initials: 'LP', registration: 'LIT2026-0341', department: 'IT', batch: '2026', band: 'Ready for next step', status: 'Placed · BlueRiver Analytics' },
  { name: 'Mohammed Irfan', initials: 'MI', registration: 'LIT2026-0455', department: 'ECE', batch: '2026', band: 'Ready for next step', status: 'Placed · Veridian Tech' },
];

export const pilotInterventions = [
  { student: 'Aditya Rao', action: 'Career counselling session', due: 'Due 28 May', tone: 'rose' },
  { student: 'Rohit Verma', action: 'Aptitude improvement plan', due: 'Due 30 May', tone: 'amber' },
  { student: 'Karthik Menon', action: 'Resume review with faculty', due: 'Due 2 Jun', tone: 'blue' },
] as const;

export interface PilotDrive {
  readonly company: PilotCompany;
  readonly role: string;
  readonly date: string;
  readonly mode: string;
  readonly eligible: number;
  readonly registered: number;
  readonly stage: string;
}

export const pilotInstitutionDrives: readonly PilotDrive[] = [
  { company: pilotCompanies[0]!, role: 'Software Engineer + GET', date: 'MAY 22', mode: 'Online', eligible: 186, registered: 154, stage: 'Registrations open' },
  { company: pilotCompanies[1]!, role: 'SDE Intern (2027 batch)', date: 'MAY 24', mode: 'On campus', eligible: 142, registered: 118, stage: 'Aptitude scheduled' },
  { company: pilotCompanies[5]!, role: 'Graduate Trainee', date: 'JUN 05', mode: 'Hyderabad', eligible: 208, registered: 61, stage: 'Announced' },
  { company: pilotCompanies[2]!, role: 'Data Analyst', date: 'JUN 12', mode: 'Online', eligible: 96, registered: 12, stage: 'Announced' },
];

export const pilotPipelineFunnel = [
  { label: 'Registered', value: 345 },
  { label: 'Assessed', value: 268 },
  { label: 'Shortlisted', value: 121 },
  { label: 'Interviewed', value: 74 },
  { label: 'Offers', value: 103 },
] as const;

/** Placement-eligible students per department in each band (sums to the cohort bands). */
export const pilotDepartmentReadiness = [
  { label: 'CSE', ready: 52, progressing: 61, developing: 18, notEnough: 7 },
  { label: 'IT', ready: 31, progressing: 42, developing: 15, notEnough: 6 },
  { label: 'ECE', ready: 20, progressing: 33, developing: 19, notEnough: 8 },
  { label: 'EEE', ready: 9, progressing: 21, developing: 16, notEnough: 9 },
  { label: 'MECH', ready: 6, progressing: 14, developing: 16, notEnough: 9 },
] as const;

export const pilotOffersTrend = [12, 19, 26, 41, 58, 74, 86, 103] as const;

// --- Employer: Talent lead at Zenvia Labs ------------------------------------

export const pilotEmployerPersona = {
  name: 'Rohan Iyer',
  initials: 'RI',
  role: 'Talent Lead',
  company: pilotCompanies[0]!,
  subtitle: 'Zenvia Labs · Talent',
} as const;

export const pilotEmployerStats = {
  openRoles: 6,
  totalApplicants: 438,
  inPipeline: 92,
  offersExtended: 14,
  hires: 5,
} as const;

export interface PilotEmployerRole {
  readonly title: string;
  readonly location: string;
  readonly type: string;
  readonly applicants: number;
  readonly shortlisted: number;
  readonly stage: string;
  readonly posted: string;
  readonly status: 'Live' | 'Closing soon' | 'Draft';
}

export const pilotEmployerRoles: readonly PilotEmployerRole[] = [
  { title: 'Graduate Software Engineer', location: 'Bengaluru', type: 'Full-time', applicants: 186, shortlisted: 24, stage: 'Interviews', posted: 'Posted 3w ago', status: 'Live' },
  { title: 'Software Engineer', location: 'Bengaluru', type: 'Full-time', applicants: 121, shortlisted: 18, stage: 'Screening', posted: 'Posted 2w ago', status: 'Live' },
  { title: 'SDE Intern', location: 'Hyderabad', type: 'Internship', applicants: 88, shortlisted: 15, stage: 'Assessment', posted: 'Posted 1w ago', status: 'Live' },
  { title: 'QA Engineer', location: 'Chennai', type: 'Full-time', applicants: 43, shortlisted: 6, stage: 'Applications', posted: 'Posted 4d ago', status: 'Closing soon' },
  { title: 'Platform Engineer', location: 'Remote', type: 'Full-time', applicants: 0, shortlisted: 0, stage: 'Not published', posted: 'Draft', status: 'Draft' },
];

export interface PilotApplicant {
  readonly name: string;
  readonly initials: string;
  readonly college: string;
  readonly roleApplied: string;
  readonly stage: 'Applied' | 'Screening' | 'Shortlisted' | 'Assessment' | 'Interview' | 'Offer';
  readonly appliedWhen: string;
  readonly highlight?: string;
}

export const pilotApplicants: readonly PilotApplicant[] = [
  // The cross-portal moment: the student from the first demo, on the employer's side.
  { name: pilotPersona.name, initials: pilotPersona.initials, college: 'Lakeview Institute', roleApplied: 'Graduate Software Engineer', stage: 'Shortlisted', appliedWhen: 'Applied 6d ago', highlight: 'Strong aptitude and Python scores' },
  { name: 'Priya Sharma', initials: 'PS', college: 'Lakeview Institute', roleApplied: 'Graduate Software Engineer', stage: 'Interview', appliedWhen: 'Applied 2w ago', highlight: 'Hackathon finalist' },
  { name: 'Devika Pillai', initials: 'DP', college: 'Riverside College of Engineering', roleApplied: 'Software Engineer', stage: 'Screening', appliedWhen: 'Applied 4d ago' },
  { name: 'Arnav Gupta', initials: 'AG', college: 'Coastal Engineering College', roleApplied: 'SDE Intern', stage: 'Assessment', appliedWhen: 'Applied 1w ago' },
  { name: 'Sana Sheikh', initials: 'SS', college: 'Hillcrest University', roleApplied: 'Graduate Software Engineer', stage: 'Offer', appliedWhen: 'Applied 3w ago', highlight: 'Offer sent · awaiting response' },
  { name: 'Vikram Nair', initials: 'VN', college: 'Lakeview Institute', roleApplied: 'QA Engineer', stage: 'Applied', appliedWhen: 'Applied 2d ago' },
];

/**
 * What each applicant chose to share with this employer when applying. Evidence an
 * employer sees is consented per application and names who verified it; the readiness
 * band is never part of it (CLAUDE.md: readiness is never exposed to an employer).
 */
export interface PilotSharedEvidence {
  readonly item: string;
  readonly verifiedBy: string;
}

const DEFAULT_SHARED_EVIDENCE: readonly PilotSharedEvidence[] = [
  { item: 'Degree programme and expected year of completion', verifiedBy: 'College records' },
  { item: 'Resume submitted with this application', verifiedBy: 'Self-declared' },
];

export const pilotApplicantEvidence: Readonly<Record<string, readonly PilotSharedEvidence[]>> = {
  [pilotPersona.name]: [
    { item: 'B.Tech CSE, Lakeview Institute of Technology · Class of 2027 · CGPA 8.2', verifiedBy: 'Verified by Lakeview Institute (academic records)' },
    { item: 'Python — college assessment, Apr 2026', verifiedBy: 'Verified by Lakeview Institute (proctored assessment)' },
    { item: 'Project: Placement Portal Mini-Project (React, Node.js) · hackathon runner-up', verifiedBy: 'Verified by Prof. Suresh Raman (faculty review)' },
    { item: 'Internship: Web Development Intern, Nimbus Digital · May – Jul 2025', verifiedBy: 'Document checked by Lakeview Placement Cell' },
  ],
  'Priya Sharma': [
    { item: 'B.Tech CSE, Lakeview Institute of Technology · Class of 2027', verifiedBy: 'Verified by Lakeview Institute (academic records)' },
    { item: 'Hackathon finalist — State Smart Campus Challenge 2026', verifiedBy: 'Certificate checked by Lakeview Placement Cell' },
    { item: 'Data Structures — college assessment, Mar 2026', verifiedBy: 'Verified by Lakeview Institute (proctored assessment)' },
  ],
};

export function sharedEvidenceFor(name: string): readonly PilotSharedEvidence[] {
  return pilotApplicantEvidence[name] ?? DEFAULT_SHARED_EVIDENCE;
}

export const pilotEmployerInterviews = [
  { candidate: 'Priya Sharma', role: 'Graduate Software Engineer', when: 'Tomorrow, 10:30 AM', round: 'Technical Round 2', mode: 'Video' },
  { candidate: 'Arjun Reddy', role: 'Graduate Software Engineer', when: '26 May, 02:00 PM', round: 'Technical Round 1', mode: 'Video' },
  { candidate: 'Devika Pillai', role: 'Software Engineer', when: '27 May, 11:00 AM', round: 'Screening call', mode: 'Phone' },
] as const;

export const pilotEmployerFunnel = [
  { label: 'Applied', value: 438 },
  { label: 'Screened', value: 214 },
  { label: 'Shortlisted', value: 92 },
  { label: 'Interviewed', value: 47 },
  { label: 'Offers', value: 14 },
] as const;

export const pilotCampusDrives = [
  { institution: 'Lakeview Institute', date: 'MAY 22', role: 'GET + SE', registered: 154 },
  { institution: 'Riverside College of Engineering', date: 'MAY 29', role: 'SE', registered: 96 },
  { institution: 'Hillcrest University', date: 'JUN 03', role: 'SDE Intern', registered: 72 },
] as const;
