import { pilotCanon, pilotCompanies, pilotPersona, type PilotCompany } from './pilotData.js';

/**
 * Institution and employer pilot datasets.
 *
 * Coherence across portals is the point: the student the client just saw as Arjun
 * appears in the placement officer's roster with the same readiness figure, and in
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
  averageReadiness: 64,
  atRisk: 57,
} as const;

export const pilotReadinessBands = [
  { label: 'Ready for next step', value: 118, color: '#0d6b4f' },
  { label: 'Progressing', value: 171, color: '#1f55e5' },
  { label: 'Developing', value: 84, color: '#b45309' },
  { label: 'Needs intervention', value: 39, color: '#a81f4d' },
] as const;

export interface PilotRosterStudent {
  readonly name: string;
  readonly initials: string;
  readonly registration: string;
  readonly department: string;
  readonly batch: string;
  readonly readiness: number;
  readonly band: 'Ready' | 'Progressing' | 'Developing' | 'At risk';
  readonly status: string;
}

export const pilotRoster: readonly PilotRosterStudent[] = [
  // The same Arjun the client just met, with the same readiness number.
  { name: pilotPersona.name, initials: pilotPersona.initials, registration: 'VIT2027-0412', department: 'CSE', batch: '2027', readiness: pilotCanon.readiness, band: 'Progressing', status: `Shortlisted · Zenvia Labs` },
  { name: 'Priya Sharma', initials: 'PS', registration: 'VIT2027-0388', department: 'CSE', batch: '2027', readiness: 81, band: 'Ready', status: 'Offer · Kortex Systems' },
  { name: 'Karthik Menon', initials: 'KM', registration: 'VIT2027-0521', department: 'ECE', batch: '2027', readiness: 58, band: 'Developing', status: 'Applied · 3 roles' },
  { name: 'Sneha Iyer', initials: 'SI', registration: 'VIT2027-0176', department: 'IT', batch: '2027', readiness: 74, band: 'Progressing', status: 'Interview · BlueRiver' },
  { name: 'Aditya Rao', initials: 'ADR', registration: 'VIT2027-0644', department: 'MECH', batch: '2027', readiness: 39, band: 'At risk', status: 'No applications yet' },
  { name: 'Fatima Khan', initials: 'FK', registration: 'VIT2027-0233', department: 'CSE', batch: '2027', readiness: 86, band: 'Ready', status: 'Offer accepted · Veridian' },
  { name: 'Rohit Verma', initials: 'RV', registration: 'VIT2027-0590', department: 'EEE', batch: '2027', readiness: 47, band: 'At risk', status: 'Intervention assigned' },
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

export const pilotDepartmentReadiness = [
  { label: 'CSE', value: 71 }, { label: 'IT', value: 68 }, { label: 'ECE', value: 61 },
  { label: 'EEE', value: 55 }, { label: 'MECH', value: 49 },
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
  { name: pilotPersona.name, initials: pilotPersona.initials, college: 'VIT Chennai', roleApplied: 'Graduate Software Engineer', stage: 'Shortlisted', appliedWhen: 'Applied 6d ago', highlight: 'Strong aptitude and Python scores' },
  { name: 'Priya Sharma', initials: 'PS', college: 'VIT Chennai', roleApplied: 'Graduate Software Engineer', stage: 'Interview', appliedWhen: 'Applied 2w ago', highlight: 'Hackathon finalist' },
  { name: 'Devika Pillai', initials: 'DP', college: 'NIT Trichy', roleApplied: 'Software Engineer', stage: 'Screening', appliedWhen: 'Applied 4d ago' },
  { name: 'Arnav Gupta', initials: 'AG', college: 'SRM Chennai', roleApplied: 'SDE Intern', stage: 'Assessment', appliedWhen: 'Applied 1w ago' },
  { name: 'Sana Sheikh', initials: 'SS', college: 'Anna University', roleApplied: 'Graduate Software Engineer', stage: 'Offer', appliedWhen: 'Applied 3w ago', highlight: 'Offer sent · awaiting response' },
  { name: 'Vikram Nair', initials: 'VN', college: 'VIT Chennai', roleApplied: 'QA Engineer', stage: 'Applied', appliedWhen: 'Applied 2d ago' },
];

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
  { institution: 'VIT Chennai', date: 'MAY 22', role: 'GET + SE', registered: 154 },
  { institution: 'NIT Trichy', date: 'MAY 29', role: 'SE', registered: 96 },
  { institution: 'Anna University', date: 'JUN 03', role: 'SDE Intern', registered: 72 },
] as const;
