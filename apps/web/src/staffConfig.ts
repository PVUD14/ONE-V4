import { type IconName } from './icons/Icon.js';

export type StaffRouteKey = 'dashboard' | 'students' | 'departments' | 'batches' | 'student-search' | 'readiness' | 'assessments' | 'interventions' | 'opportunities' | 'applications' | 'interviews' | 'offers' | 'employers' | 'communications' | 'events' | 'reports' | 'dashboards';
export type StaffNavGroup = 'Home' | 'Students' | 'Placement' | 'Engagement' | 'Analytics';

export type StaffNavItem = {
  readonly label: string;
  readonly group: StaffNavGroup;
  readonly icon: IconName;
  readonly path: string;
  readonly route: StaffRouteKey;
};

export const staffBasePath = '/institution/placement-officer';

export const staffNavItems: readonly StaffNavItem[] = [
  { label: 'Dashboard', group: 'Home', icon: 'home', path: staffBasePath, route: 'dashboard' },
  { label: 'Students', group: 'Students', icon: 'students', path: `${staffBasePath}/students`, route: 'students' },
  { label: 'Departments', group: 'Students', icon: 'departments', path: `${staffBasePath}/departments`, route: 'departments' },
  { label: 'Batches', group: 'Students', icon: 'batches', path: `${staffBasePath}/batches`, route: 'batches' },
  { label: 'Student Search', group: 'Students', icon: 'student-search', path: `${staffBasePath}/student-search`, route: 'student-search' },
  { label: 'Readiness', group: 'Placement', icon: 'readiness', path: `${staffBasePath}/readiness`, route: 'readiness' },
  { label: 'Assessments', group: 'Placement', icon: 'assessments', path: `${staffBasePath}/assessments`, route: 'assessments' },
  { label: 'Interventions', group: 'Placement', icon: 'interventions', path: `${staffBasePath}/interventions`, route: 'interventions' },
  { label: 'Opportunities', group: 'Placement', icon: 'opportunities', path: `${staffBasePath}/opportunities`, route: 'opportunities' },
  { label: 'Applications', group: 'Placement', icon: 'applications', path: `${staffBasePath}/applications`, route: 'applications' },
  { label: 'Interviews', group: 'Placement', icon: 'interviews', path: `${staffBasePath}/interviews`, route: 'interviews' },
  { label: 'Offers', group: 'Placement', icon: 'offers', path: `${staffBasePath}/offers`, route: 'offers' },
  { label: 'Employers', group: 'Engagement', icon: 'company', path: `${staffBasePath}/employers`, route: 'employers' },
  { label: 'Communications', group: 'Engagement', icon: 'messages', path: `${staffBasePath}/communications`, route: 'communications' },
  { label: 'Events', group: 'Engagement', icon: 'calendar', path: `${staffBasePath}/events`, route: 'events' },
  { label: 'Reports', group: 'Analytics', icon: 'reports', path: `${staffBasePath}/reports`, route: 'reports' },
  { label: 'Dashboards', group: 'Analytics', icon: 'home', path: `${staffBasePath}/dashboards`, route: 'dashboards' },
];

export const staffNavGroups = ['Home', 'Students', 'Placement', 'Engagement', 'Analytics'] as const;
export const dashboardFilters = ['All departments', 'CSE', 'ECE', 'ME', 'IT', 'Civil'] as const;
export const dateRanges = ['Aug 1 - Aug 16, 2025', 'Last 30 days', 'This quarter'] as const;
export const riskFilters = ['All readiness', 'Needs intervention', 'High risk'] as const;
