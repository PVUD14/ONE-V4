import {
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  FileText,
  FolderKanban,
  Gauge,
  GraduationCap,
  LayoutDashboard,
  Lock,
  Map,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly icon: LucideIcon;
}

export const studentNav: readonly NavItem[] = [
  { label: 'Dashboard', path: '/student', icon: LayoutDashboard },
  { label: 'Career Path', path: '/student/career-path', icon: Map },
  { label: 'Skills', path: '/student/skills', icon: BarChart3 },
  { label: 'Learning', path: '/student/learning', icon: BookOpen },
  { label: 'Experience', path: '/student/experience', icon: FolderKanban },
  { label: 'Opportunities', path: '/student/opportunities', icon: BriefcaseBusiness },
  { label: 'Applications', path: '/student/applications', icon: GraduationCap },
  { label: 'Readiness', path: '/student/readiness', icon: Gauge },
  { label: 'Profile', path: '/student/profile', icon: UserRound },
  { label: 'Documents', path: '/student/documents', icon: FileText },
  { label: 'Settings', path: '/student/settings', icon: Settings },
];

export const previewProfile = {
  name: 'Rahul Kumar',
  role: 'Student',
  program: 'B.Tech CSE',
  graduationYear: '2027',
  targetRole: 'Cybersecurity Analyst',
  pathwayProgress: 64,
  readiness: 72,
  nextMilestone: 'Complete SIEM investigation assessment',
  note: 'Local UI Preview: demo view models only. Authenticated API integration is pending development Cognito configuration.',
};

export const priorityActions = [
  { title: 'Complete profile evidence', detail: 'Add institution-verified academic record references.', status: 'Pending' },
  { title: 'Finish readiness assessment', detail: 'Communication module is ready to continue.', status: 'Due soon' },
  { title: 'Review matched opportunity', detail: 'SOC Analyst Intern role matches your networking and SIEM signals.', status: 'Review' },
  { title: 'Update skill evidence', detail: 'Link security lab outcomes to incident triage and stakeholder notes.', status: 'Draft' },
];

export const skills = [
  { name: 'Networking fundamentals', level: 82, evidence: 'Assessment verified', source: 'ONE assessed' },
  { name: 'Linux fundamentals', level: 74, evidence: 'Lab evidence pending', source: 'Self-declared' },
  { name: 'SIEM investigation', level: 68, evidence: 'Assessment assigned', source: 'ONE assessed' },
  { name: 'Interview communication', level: 58, evidence: 'Practice needed', source: 'Self-declared' },
  { name: 'Python security automation', level: 63, evidence: 'Course artifact', source: 'Institution verified' },
];

export const opportunities = [
  { role: 'SOC Analyst Intern', employer: 'SecureTech Labs', location: 'Bengaluru hybrid', fit: 86, status: 'Recommended' },
  { role: 'Cybersecurity Intern', employer: 'InfoSec Solutions', location: 'Remote', fit: 78, status: 'Saved' },
  { role: 'Security Operations Trainee', employer: 'Aster Mobility', location: 'Pune onsite', fit: 72, status: 'Review gaps' },
  { role: 'Incident Response Associate', employer: 'MarketWorks Security', location: 'Mumbai hybrid', fit: 68, status: 'Needs evidence' },
];

export const applications = [
  { employer: 'SecureTech Labs', role: 'SOC Analyst Intern', stage: 'Draft', next: 'Confirm resume version', date: 'Aug 18' },
  { employer: 'InfoSec Solutions', role: 'Cybersecurity Intern', stage: 'Applied', next: 'Awaiting recruiter review', date: 'Aug 14' },
  { employer: 'Aster Mobility', role: 'Security Operations Trainee', stage: 'Interview', next: 'Prepare incident triage exercise', date: 'Aug 21' },
  { employer: 'MarketWorks Security', role: 'Incident Response Associate', stage: 'Offer', next: 'Review terms snapshot', date: 'Aug 25' },
];

export const readinessBreakdown = [
  { label: 'Profile completeness', score: 80, blocker: 'Academic verification pending' },
  { label: 'Skills', score: 74, blocker: 'Interview communication needs evidence' },
  { label: 'Experience', score: 66, blocker: 'Add project outcome metrics' },
  { label: 'Evidence', score: 61, blocker: 'Two artifacts need source labels' },
  { label: 'Interview readiness', score: 58, blocker: 'Mock interview not completed' },
];

export const activity = [
  'Resume version marked ready for review',
  'Networking fundamentals skill updated as evidence provided',
  'Opportunity match refreshed for Cybersecurity Analyst path',
  'Readiness model explanation viewed',
];

export const careerStages = [
  { title: 'Explore target', state: 'Complete', detail: 'Cybersecurity Analyst selected as primary target.' },
  { title: 'Build evidence', state: 'Current', detail: 'Attach networking, Linux, and SIEM lab artifacts.' },
  { title: 'Apply with consented profile', state: 'Next', detail: 'Use verified snapshot for recommended roles.' },
  { title: 'Prepare interviews', state: 'Upcoming', detail: 'Practice incident triage and stakeholder communication.' },
];

export const learningItems = [
  { title: 'SIEM investigation lab', progress: 60, linkedSkill: 'SIEM investigation', state: 'Active' },
  { title: 'Linux hardening basics', progress: 35, linkedSkill: 'Linux fundamentals', state: 'Active' },
  { title: 'Interview narrative practice', progress: 0, linkedSkill: 'Interview communication', state: 'Recommended' },
  { title: 'Networking fundamentals', progress: 100, linkedSkill: 'Networking fundamentals', state: 'Completed' },
];

export const projects = [
  { name: 'Security incident readiness dashboard', type: 'Project', evidence: 'Portfolio draft', state: 'Needs verification' },
  { name: 'Suspicious login investigation notebook', type: 'Work simulation', evidence: 'Notebook linked', state: 'Evidence provided' },
  { name: 'Campus internship', type: 'Internship', evidence: 'Supervisor letter pending', state: 'Pending' },
];

export const documents = [
  { name: 'Cybersecurity analyst resume', kind: 'Resume', status: 'Draft', updated: 'Aug 17' },
  { name: 'Security lab portfolio', kind: 'Portfolio', status: 'Evidence provided', updated: 'Aug 15' },
  { name: 'Networking certificate', kind: 'Certificate', status: 'Institution verified', updated: 'Aug 10' },
  { name: 'Academic transcript', kind: 'Supporting document', status: 'Pending verification', updated: 'Aug 09' },
];

export const securitySettings = [
  { label: 'Authentication provider', value: 'Development Cognito pending', icon: Lock },
  { label: 'Session security', value: 'Protected routes remain API-enforced', icon: ShieldCheck },
  { label: 'Private AI preview', value: 'Frontend placeholder only', icon: Sparkles },
];

