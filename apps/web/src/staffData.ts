import { BarChart3, BellRing, BriefcaseBusiness, CalendarDays, ClipboardCheck, FileText, Megaphone, MessageSquare, PieChart, ShieldAlert, Target, Users, type LucideIcon } from 'lucide-react';

export type StaffKpi = {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: 'green' | 'blue' | 'teal' | 'amber' | 'red' | 'purple';
  readonly icon: LucideIcon;
};

export type AttentionStudent = {
  readonly name: string;
  readonly department: string;
  readonly batch: string;
  readonly readiness: number;
  readonly gap: string;
  readonly lastActivity: string;
  readonly intervention: string;
};

export const placementIdentity = {
  portal: 'Institution',
  role: 'Placement Officer',
  organization: 'ABC Engineering College',
  previewUser: 'Anita Sharma',
  initials: 'AS',
} as const;

export const staffKpis: readonly StaffKpi[] = [
  { label: 'Total Students', value: '4,286', detail: '+5.2% vs last month', tone: 'green', icon: Users },
  { label: 'Placement Eligible', value: '1,084', detail: '25.3% of total', tone: 'blue', icon: Target },
  { label: 'Placement Ready', value: '712', detail: '66% of eligible', tone: 'teal', icon: ClipboardCheck },
  { label: 'Need Intervention', value: '269', detail: '24.8% of eligible', tone: 'amber', icon: BellRing },
  { label: 'High Risk', value: '103', detail: '9.5% of eligible', tone: 'red', icon: ShieldAlert },
  { label: 'Offers Received', value: '198', detail: '+18.1% vs last month', tone: 'purple', icon: BriefcaseBusiness },
];

export const readinessTrend = [52, 61, 55, 60, 69, 59, 62, 70, 73, 76, 74, 78, 80, 89] as const;

export const readinessDistribution = [
  { label: 'Ready', range: '70-100', value: 712, percent: 25.3, color: '#079669' },
  { label: 'Moderate', range: '40-69', value: 804, percent: 28.6, color: '#f0a202' },
  { label: 'Low', range: '20-39', value: 374, percent: 13.3, color: '#f97316' },
  { label: 'At Risk', range: '0-19', value: 103, percent: 9.5, color: '#e63946' },
] as const;

export const placementPipeline = [
  { label: 'Applications', value: 3842 },
  { label: 'Shortlisted', value: 612 },
  { label: 'Interviews', value: 198 },
  { label: 'Offers', value: 198 },
  { label: 'Placed', value: 164 },
] as const;

export const skillGaps = [
  { label: 'Communication', value: 62 },
  { label: 'Cloud Computing', value: 48 },
  { label: 'Python', value: 41 },
  { label: 'SQL', value: 37 },
  { label: 'Aptitude', value: 34 },
] as const;

export const attentionStudents: readonly AttentionStudent[] = [
  { name: 'Rahul Kumar', department: 'CSE', batch: '2027', readiness: 48, gap: 'Communication', lastActivity: '2 days ago', intervention: 'Resume Review' },
  { name: 'Priya Singh', department: 'CSE', batch: '2027', readiness: 51, gap: 'Aptitude', lastActivity: '1 day ago', intervention: 'Aptitude Bootcamp' },
  { name: 'Arun Das', department: 'ECE', batch: '2027', readiness: 53, gap: 'Resume', lastActivity: '3 days ago', intervention: 'Resume Review' },
  { name: 'Neha Patel', department: 'CSE', batch: '2027', readiness: 54, gap: 'Technical Skills', lastActivity: '2 days ago', intervention: 'SIEM Assessment' },
  { name: 'Vikram Joshi', department: 'ME', batch: '2027', readiness: 57, gap: 'Interview Skills', lastActivity: '2 days ago', intervention: 'Mock Interview' },
];

export const upcomingInterviews = [
  { employer: 'TCS', when: '20 Aug, 11:00 AM', students: 12 },
  { employer: 'Infosys', when: '21 Aug, 10:00 AM', students: 18 },
  { employer: 'Accenture', when: '22 Aug, 02:00 PM', students: 15 },
] as const;

export const announcements = [
  'TCS campus drive registration open',
  'Aptitude bootcamp starting 19 Aug',
  'Resume building workshop - 18 Aug',
] as const;

export const actionCards = [
  { label: 'Assessments', detail: 'Create, schedule and manage assessments', icon: ClipboardCheck },
  { label: 'Interventions', detail: 'Assign and track student interventions', icon: Target },
  { label: 'Opportunities', detail: 'Post and manage opportunities', icon: BriefcaseBusiness },
  { label: 'Reports', detail: 'View placement and readiness reports', icon: FileText },
  { label: 'Communications', detail: 'Send messages and notifications', icon: MessageSquare },
  { label: 'Events', detail: 'Manage placement events', icon: CalendarDays },
] as const;

export const departmentReadiness = [
  { department: 'CSE', students: 1245, readiness: 72, ready: '412 (33%)', intervention: '168 (13%)' },
  { department: 'ECE', students: 987, readiness: 68, ready: '276 (28%)', intervention: '146 (15%)' },
  { department: 'ME', students: 856, readiness: 63, ready: '184 (21%)', intervention: '162 (19%)' },
  { department: 'IT', students: 645, readiness: 71, ready: '248 (38%)', intervention: '86 (13%)' },
  { department: 'Civil', students: 553, readiness: 58, ready: '144 (26%)', intervention: '132 (24%)' },
] as const;

export const placementTrend = [
  { month: "Mar'25", offers: 32, placed: 27 },
  { month: "Apr'25", offers: 45, placed: 38 },
  { month: "May'25", offers: 52, placed: 44 },
  { month: "Jun'25", offers: 61, placed: 51 },
  { month: "Jul'25", offers: 68, placed: 57 },
  { month: "Aug'25", offers: 54, placed: 47 },
] as const;

export const topRecruiters = [
  { name: 'TCS', offers: 45, placed: 32 },
  { name: 'Infosys', offers: 38, placed: 28 },
  { name: 'Accenture', offers: 28, placed: 20 },
  { name: 'Cognizant', offers: 24, placed: 18 },
  { name: 'Wipro', offers: 20, placed: 15 },
] as const;

export const quickActions = [
  { label: 'Add New Opportunity', icon: BriefcaseBusiness },
  { label: 'Schedule Assessment', icon: ClipboardCheck },
  { label: 'Create Intervention', icon: Target },
  { label: 'Send Announcement', icon: Megaphone },
  { label: 'Generate Readiness Report', icon: BarChart3 },
] as const;

export const staffReports = [
  { label: 'Placement readiness summary', icon: PieChart },
  { label: 'Skill-gap report', icon: BarChart3 },
  { label: 'Department comparison', icon: FileText },
] as const;
