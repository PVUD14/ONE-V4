import { BarChart3, BriefcaseBusiness, Building2, CalendarDays, ClipboardCheck, FileText, Flag, Gauge, Home, LayoutDashboard, MessageSquare, PieChart, Search, Settings, ShieldCheck, Target, Users, type LucideIcon } from 'lucide-react';

export type PortalFamily = 'Student' | 'Institution' | 'Employer' | 'Operations';
export type EnforcementStatus = 'Backend enforced' | 'Partially backend enforced' | 'Domain-model only' | 'UI preview only';
export type RolePortalKey =
  | 'student'
  | 'placement-officer'
  | 'faculty'
  | 'career-counselor'
  | 'department-head'
  | 'institution-analyst'
  | 'recruiter'
  | 'hiring-manager'
  | 'interviewer'
  | 'operations-admin';

export interface RoleNavItem {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly path: string;
  readonly icon: LucideIcon;
}

export interface RoleFixture {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly status: string;
  readonly category: string;
  readonly detail: string;
  readonly protectedNote: string;
}

export interface RolePortalConfig {
  readonly key: RolePortalKey;
  readonly family: PortalFamily;
  readonly roleName: string;
  readonly backendRole: string;
  readonly enforcementStatus: EnforcementStatus;
  readonly basePath: string;
  readonly subtitle: string;
  readonly organization: string;
  readonly previewUser: string;
  readonly initials: string;
  readonly accent: 'student' | 'emerald' | 'blue' | 'teal' | 'forest' | 'violet' | 'amber' | 'rose' | 'gold' | 'slate';
  readonly dashboardTitle: string;
  readonly dashboardSummary: string;
  readonly allowedOperations: readonly string[];
  readonly readOnlyData: readonly string[];
  readonly forbiddenOperations: readonly string[];
  readonly nav: readonly RoleNavItem[];
  readonly kpis: readonly { readonly label: string; readonly value: string; readonly detail: string }[];
  readonly records: readonly RoleFixture[];
}

const iconFor = (label: string): LucideIcon => {
  if (/student|candidate|applicant|team|users|faculty/i.test(label)) return Users;
  if (/assessment|scorecard|evaluation|verification/i.test(label)) return ClipboardCheck;
  if (/intervention|guidance|task|flag|safety/i.test(label)) return Target;
  if (/opportun|requisition|offer|billing|employer|organization/i.test(label)) return BriefcaseBusiness;
  if (/interview|calendar|session|meeting|schedule|event/i.test(label)) return CalendarDays;
  if (/report|analysis|analytics|visual|dashboard|health/i.test(label)) return BarChart3;
  if (/message|communication|note|support/i.test(label)) return MessageSquare;
  if (/setting|profile|security|feature/i.test(label)) return Settings;
  return FileText;
};

function nav(basePath: string, groups: readonly [string, readonly string[]][]): readonly RoleNavItem[] {
  return groups.flatMap(([group, labels]) => labels.map((label, index) => ({
    key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dashboard',
    label,
    group,
    path: index === 0 && (label === 'Dashboard' || label === 'Overview') ? basePath : `${basePath}/${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    icon: label === 'Dashboard' || label === 'Overview' ? Home : iconFor(label),
  })));
}

const institutionRecords: readonly RoleFixture[] = [
  { id: 'inst-rahul', title: 'Rahul Kumar', owner: 'CSE 2027', status: 'Needs intervention', category: 'Student support', detail: 'Communication gap with active resume review.', protectedNote: 'Student identity, private evidence and consent decisions remain read-only.' },
  { id: 'inst-siem', title: 'SIEM readiness plan', owner: 'Training Team', status: 'Draft', category: 'Assessment', detail: 'Practical readiness task tied to SOC analyst pathway.', protectedNote: 'Completed scores and calculated readiness cannot be edited.' },
  { id: 'inst-resource', title: 'Incident timeline resource', owner: 'Faculty mentors', status: 'Available', category: 'Resource', detail: 'Learning support for interview storytelling.', protectedNote: 'Private AI conversations are never visible to institution staff.' },
];

const employerRecords: readonly RoleFixture[] = [
  { id: 'emp-soc', title: 'SOC Analyst Intern', owner: 'Aster Mobility', status: 'Open', category: 'Opportunity', detail: 'Entry SOC role with SIEM and communication requirements.', protectedNote: 'Student private documents and institution-only notes remain hidden.' },
  { id: 'emp-rahul', title: 'Rahul Kumar', owner: 'Candidate pipeline', status: 'Shortlist review', category: 'Candidate', detail: 'Consented applicant profile with verified evidence summary.', protectedNote: 'Academic source records remain institution-verified and read-only.' },
  { id: 'emp-panel', title: 'Technical interview panel', owner: 'Hiring team', status: 'Scheduled', category: 'Interview', detail: 'Panel assignment and scorecard preparation.', protectedNote: 'Interviewers cannot issue offers or edit requisitions.' },
];

const opsRecords: readonly RoleFixture[] = [
  { id: 'ops-org', title: 'ABC Engineering College', owner: 'Institution verification', status: 'Under review', category: 'Organization', detail: 'KYC and institutional status queue.', protectedNote: 'Preview actions do not mutate production organizations.' },
  { id: 'ops-case', title: 'Trust review case', owner: 'Platform operations', status: 'Open', category: 'Trust and safety', detail: 'Moderation workflow with reason capture.', protectedNote: 'No secrets, tokens or privileged backend mutations are exposed.' },
  { id: 'ops-health', title: 'API latency watch', owner: 'System health', status: 'Acknowledged', category: 'Health', detail: 'Simulated operational event for preview response.', protectedNote: 'Production health is not fabricated by the frontend.' },
];

export const rolePortals: readonly RolePortalConfig[] = [
  {
    key: 'student', family: 'Student', roleName: 'Student', backendRole: 'STUDENT', enforcementStatus: 'Backend enforced', basePath: '/student', subtitle: 'Student Portal', organization: 'ABC Engineering College', previewUser: 'Rahul Kumar', initials: 'RK', accent: 'student', dashboardTitle: 'Student Dashboard', dashboardSummary: 'Guided career readiness, applications, learning and Student-owned profile workflows.',
    allowedOperations: ['Edit Student-owned profile fields', 'Manage drafts and metadata', 'Save opportunities'], readOnlyData: ['Calculated readiness', 'Verified academic data', 'Employer decisions'], forbiddenOperations: ['Change verification state', 'Edit employer terms'],
    nav: [], kpis: [], records: [],
  },
  {
    key: 'placement-officer', family: 'Institution', roleName: 'Placement Officer', backendRole: 'PLACEMENT_ADMIN / PLACEMENT_OFFICER', enforcementStatus: 'Partially backend enforced', basePath: '/institution/placement-officer', subtitle: 'Institution Portal', organization: 'ABC Engineering College', previewUser: 'Anita Sharma', initials: 'AS', accent: 'emerald', dashboardTitle: 'Placement Dashboard', dashboardSummary: 'Operational placement readiness, interventions, applications and employer engagement.',
    allowedOperations: ['Coordinate interventions', 'Create assessments', 'Recommend opportunities'], readOnlyData: ['Student consent', 'Employer offer terms'], forbiddenOperations: ['Override student identity', 'Issue offers'],
    nav: [], kpis: [], records: [],
  },
  {
    key: 'faculty', family: 'Institution', roleName: 'Lecturer / Faculty', backendRole: 'FACULTY_LECTURER', enforcementStatus: 'Partially backend enforced', basePath: '/institution/faculty', subtitle: 'Faculty Portal', organization: 'ABC Engineering College', previewUser: 'Dr. Meera Iyer', initials: 'MI', accent: 'blue', dashboardTitle: 'Faculty Dashboard', dashboardSummary: 'Assigned students, academic verification, assessments, tasks and interventions.',
    allowedOperations: ['Create draft assessment', 'Assign Student task', 'Add faculty note', 'Request academic evidence', 'Create intervention recommendation', 'Add learning resource', 'Schedule faculty session'], readOnlyData: ['Student-controlled consent', 'Employer decisions', 'Calculated readiness formula'], forbiddenOperations: ['Edit employer offers', 'Change platform roles'],
    nav: nav('/institution/faculty', [['Home', ['Dashboard']], ['Students', ['My Students', 'Student Detail', 'Academic Verification']], ['Teaching', ['Assessments', 'Assessment Detail', 'Assigned Tasks', 'Interventions', 'Learning Resources']], ['Work', ['Reports', 'Calendar', 'Messages', 'Profile', 'Settings']]]),
    kpis: [{ label: 'Students assigned', value: '84', detail: '18 need academic review' }, { label: 'Pending verifications', value: '12', detail: 'Oldest due tomorrow' }, { label: 'Assessments created', value: '7', detail: '2 drafts ready' }, { label: 'At-risk students', value: '16', detail: 'Communication and labs' }],
    records: institutionRecords,
  },
  {
    key: 'career-counselor', family: 'Institution', roleName: 'Career Counselor', backendRole: 'CAREER_COUNSELOR', enforcementStatus: 'Domain-model only', basePath: '/institution/career-counselor', subtitle: 'Counselor Portal', organization: 'ABC Engineering College', previewUser: 'Kavya Menon', initials: 'KM', accent: 'teal', dashboardTitle: 'Career Counselor Dashboard', dashboardSummary: 'Counseling sessions, student cases, interventions, follow-ups and career guidance workload.',
    allowedOperations: ['Schedule counseling session', 'Add private counselor note', 'Create follow-up', 'Recommend career path', 'Assign intervention', 'Attach resource', 'Record outcome'], readOnlyData: ['Institution verification source records', 'Employer decisions'], forbiddenOperations: ['Expose private notes to employers', 'Change student consent'],
    nav: nav('/institution/career-counselor', [['Home', ['Dashboard']], ['Counseling', ['Counselor Sessions', 'Student Cases', 'Counseling Notes', 'Interventions', 'Career Guidance']], ['Resources', ['Assessments', 'Resources', 'Reports', 'Calendar', 'Messages', 'Profile', 'Settings']]]),
    kpis: [{ label: 'Sessions this month', value: '146', detail: '22 this week' }, { label: 'Students counselled', value: '118', detail: '31 follow-ups due' }, { label: 'Active interventions', value: '42', detail: '8 high priority' }, { label: 'Today schedule', value: '9', detail: '6 completed' }],
    records: institutionRecords,
  },
  {
    key: 'department-head', family: 'Institution', roleName: 'Department Head', backendRole: 'DEPARTMENT_HEAD', enforcementStatus: 'Partially backend enforced', basePath: '/institution/department-head', subtitle: 'Department Portal', organization: 'ABC Engineering College - CSE', previewUser: 'Prof. Arvind Rao', initials: 'AR', accent: 'forest', dashboardTitle: 'Department Dashboard', dashboardSummary: 'Department readiness, risks, faculty workload, placement pipeline and meetings.',
    allowedOperations: ['Assign faculty workload', 'Create department intervention', 'Review assessment plan', 'Schedule meeting', 'Create saved dashboard', 'Add department note'], readOnlyData: ['Student identity', 'Employer-owned offer terms'], forbiddenOperations: ['Edit student-owned profile', 'Issue offers'],
    nav: nav('/institution/department-head', [['Home', ['Dashboard']], ['Department', ['Department Overview', 'Students', 'Readiness', 'Assessments', 'Interventions', 'Faculty and Staff']], ['Placement', ['Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Meetings', 'Reports and Analytics', 'Settings']]]),
    kpis: [{ label: 'Department students', value: '1,245', detail: 'CSE active cohort' }, { label: 'Placement-ready', value: '412', detail: '33% of students' }, { label: 'Need intervention', value: '168', detail: '13% of cohort' }, { label: 'Offers received', value: '62', detail: '+14 this month' }],
    records: institutionRecords,
  },
  {
    key: 'institution-analyst', family: 'Institution', roleName: 'Institution Analyst', backendRole: 'INSTITUTION_ANALYST', enforcementStatus: 'Domain-model only', basePath: '/institution/analyst', subtitle: 'Analytics Portal', organization: 'ABC Engineering College', previewUser: 'Nisha Verma', initials: 'NV', accent: 'violet', dashboardTitle: 'Institution Analytics', dashboardSummary: 'Placement analysis, readiness trends, skill gaps, cohorts, saved views and exports.',
    allowedOperations: ['Configure filters', 'Save view', 'Generate preview report', 'Configure chart', 'Create export request presentation', 'Add annotation'], readOnlyData: ['Source records', 'Verification decisions', 'Placement decisions'], forbiddenOperations: ['Edit source student records', 'Change backend authorization'],
    nav: nav('/institution/analyst', [['Home', ['Dashboard']], ['Analysis', ['Analysis Overview', 'Placement Analysis', 'Readiness Analysis', 'Skill Gap Analysis', 'Cohort Comparison']], ['Outputs', ['Reports', 'Data Exports', 'Visualizations', 'Saved Views', 'Settings']]]),
    kpis: [{ label: 'Total students', value: '4,286', detail: 'All active cohorts' }, { label: 'Average readiness', value: '71%', detail: '+6% month over month' }, { label: 'Placement rate', value: '18.4%', detail: 'Current cycle' }, { label: 'Report freshness', value: '2h', detail: 'Preview data snapshot' }],
    records: institutionRecords,
  },
  {
    key: 'recruiter', family: 'Employer', roleName: 'Recruiter', backendRole: 'RECRUITER', enforcementStatus: 'Backend enforced', basePath: '/employer/recruiter', subtitle: 'Employer Portal', organization: 'Aster Mobility', previewUser: 'Rohan Shah', initials: 'RS', accent: 'amber', dashboardTitle: 'Recruiter Dashboard', dashboardSummary: 'Opportunities, applications, shortlists, interviews, offers, talent pool and recruiter activity.',
    allowedOperations: ['Create draft opportunity', 'Publish preview state', 'Shortlist candidate', 'Move recruiter-owned stage', 'Schedule interview request', 'Create assessment request', 'Draft offer', 'Add recruiter note'], readOnlyData: ['Student private evidence', 'Institution-only notes', 'Other employers data'], forbiddenOperations: ['Bypass consent', 'View unrelated student directory'],
    nav: nav('/employer/recruiter', [['Home', ['Dashboard']], ['Hiring', ['Opportunities', 'Opportunity Detail', 'Applicants', 'Candidate Detail', 'Assessments', 'Interviews', 'Talent Pool', 'Offers']], ['Org', ['Reports', 'Team', 'Messages', 'Company Profile', 'Settings']]]),
    kpis: [{ label: 'Active opportunities', value: '9', detail: '3 closing this week' }, { label: 'Applications', value: '312', detail: '46 new' }, { label: 'Shortlisted', value: '38', detail: '12 awaiting manager' }, { label: 'Interviews', value: '21', detail: '7 this week' }],
    records: employerRecords,
  },
  {
    key: 'hiring-manager', family: 'Employer', roleName: 'Hiring Manager', backendRole: 'HIRING_MANAGER', enforcementStatus: 'Domain-model only', basePath: '/employer/hiring-manager', subtitle: 'Hiring Manager Portal', organization: 'Aster Mobility', previewUser: 'Leena Kapoor', initials: 'LK', accent: 'rose', dashboardTitle: 'Hiring Manager Dashboard', dashboardSummary: 'Requisitions, candidate review, interview schedule, evaluations, offers and hiring-team notes.',
    allowedOperations: ['Create requisition draft', 'Approve shortlist', 'Assign interview panel', 'Submit evaluation', 'Request offer draft', 'Add hiring note', 'Change owned candidate stage'], readOnlyData: ['Student private evidence', 'Recruiter-owned admin settings'], forbiddenOperations: ['Issue platform permissions', 'Bypass consent'],
    nav: nav('/employer/hiring-manager', [['Home', ['Dashboard']], ['Hiring', ['Requisitions', 'Requisition Detail', 'Candidates', 'Candidate Review', 'Interviews', 'Evaluations', 'Offers']], ['Team', ['Hiring Reports', 'Team', 'Messages', 'Settings']]]),
    kpis: [{ label: 'Active requisitions', value: '6', detail: '2 urgent' }, { label: 'Pipeline candidates', value: '74', detail: '18 review-ready' }, { label: 'Interviews this week', value: '11', detail: '4 panel gaps' }, { label: 'Offers pending', value: '5', detail: '2 need approval' }],
    records: employerRecords,
  },
  {
    key: 'interviewer', family: 'Employer', roleName: 'Interviewer', backendRole: 'INTERVIEWER', enforcementStatus: 'Domain-model only', basePath: '/employer/interviewer', subtitle: 'Interviewer Portal', organization: 'Aster Mobility', previewUser: 'Dev Nair', initials: 'DN', accent: 'gold', dashboardTitle: 'Interviewer Dashboard', dashboardSummary: 'Assigned interviews, candidate briefs, scorecards, feedback and guidelines.',
    allowedOperations: ['Open candidate brief', 'Complete draft scorecard', 'Save interview notes', 'Submit preview feedback', 'Mark preparation complete'], readOnlyData: ['Offer decisions', 'Unauthorized candidate data'], forbiddenOperations: ['Issue offers', 'Change requisitions'],
    nav: nav('/employer/interviewer', [['Home', ['Dashboard']], ['Interviews', ['My Interviews', 'Schedule', 'Candidate Brief', 'Scorecards', 'Feedback', 'Interview Guidelines']], ['Account', ['Reports', 'Settings']]]),
    kpis: [{ label: 'Today interviews', value: '3', detail: '2 technical rounds' }, { label: 'Upcoming schedule', value: '8', detail: 'Next 10 days' }, { label: 'Pending scorecards', value: '4', detail: '2 due today' }, { label: 'Guidelines read', value: '86%', detail: 'Panel readiness' }],
    records: employerRecords,
  },
  {
    key: 'operations-admin', family: 'Operations', roleName: 'Platform Administrator / Operations Administrator', backendRole: 'OPERATIONS_ADMIN', enforcementStatus: 'Backend enforced', basePath: '/operations/admin', subtitle: 'Operations Portal', organization: 'PlanThePath Platform', previewUser: 'Samir Das', initials: 'SD', accent: 'slate', dashboardTitle: 'Operations Dashboard', dashboardSummary: 'Organizations, users, verification, trust queues, usage, system health, audit and feature flags.',
    allowedOperations: ['Review organization', 'Add operational note', 'Update preview queue status', 'Create support case', 'Configure preview feature flag', 'Acknowledge simulated event', 'Create saved operational view'], readOnlyData: ['Secrets', 'Production billing effects', 'Real privileged mutations'], forbiddenOperations: ['Expose tokens', 'Fake production health', 'Weaken backend authorization'],
    nav: nav('/operations/admin', [['Home', ['Overview']], ['Organizations', ['Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations']], ['Platform', ['Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings']]]),
    kpis: [{ label: 'Total students', value: '42.8k', detail: 'Preview platform total' }, { label: 'Institutions', value: '38', detail: '7 under review' }, { label: 'Employers', value: '124', detail: '18 active campaigns' }, { label: 'Requests today', value: '18.2k', detail: 'Healthy simulated load' }],
    records: opsRecords,
  },
];

export const activeRolePortals = rolePortals.filter((portal) => portal.key !== 'student' && portal.key !== 'placement-officer');

export function rolePortalFromPath(path: string): RolePortalConfig | undefined {
  const normalized = path.replace(/\/$/, '');
  return activeRolePortals.find((portal) => normalized === portal.basePath || normalized.startsWith(`${portal.basePath}/`));
}

export const portalFamilyIcons: Record<PortalFamily, LucideIcon> = {
  Student: Users,
  Institution: Building2,
  Employer: BriefcaseBusiness,
  Operations: ShieldCheck,
};

export const moduleIcons = { Gauge, PieChart, Search, Flag, LayoutDashboard };
