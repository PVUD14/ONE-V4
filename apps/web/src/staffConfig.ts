import { BarChart3, BriefcaseBusiness, Building2, CalendarDays, ClipboardCheck, FileText, Gauge, Home, LayoutDashboard, MessageSquare, Search, Target, Users, type LucideIcon } from 'lucide-react';

export type StaffRouteKey = 'dashboard' | 'students' | 'departments' | 'batches' | 'student-search' | 'readiness' | 'assessments' | 'interventions' | 'opportunities' | 'applications' | 'interviews' | 'offers' | 'employers' | 'communications' | 'events' | 'reports' | 'dashboards';
export type StaffNavGroup = 'Home' | 'Students' | 'Placement' | 'Engagement' | 'Analytics';

export type StaffNavItem = {
  readonly label: string;
  readonly group: StaffNavGroup;
  readonly icon: LucideIcon;
  readonly path: string;
  readonly route: StaffRouteKey;
};

export const staffBasePath = '/institution/placement-officer';

export const staffNavItems: readonly StaffNavItem[] = [
  { label: 'Dashboard', group: 'Home', icon: Home, path: staffBasePath, route: 'dashboard' },
  { label: 'Students', group: 'Students', icon: Users, path: `${staffBasePath}/students`, route: 'students' },
  { label: 'Departments', group: 'Students', icon: Building2, path: `${staffBasePath}/departments`, route: 'departments' },
  { label: 'Batches', group: 'Students', icon: LayoutDashboard, path: `${staffBasePath}/batches`, route: 'batches' },
  { label: 'Student Search', group: 'Students', icon: Search, path: `${staffBasePath}/student-search`, route: 'student-search' },
  { label: 'Readiness', group: 'Placement', icon: Gauge, path: `${staffBasePath}/readiness`, route: 'readiness' },
  { label: 'Assessments', group: 'Placement', icon: ClipboardCheck, path: `${staffBasePath}/assessments`, route: 'assessments' },
  { label: 'Interventions', group: 'Placement', icon: Target, path: `${staffBasePath}/interventions`, route: 'interventions' },
  { label: 'Opportunities', group: 'Placement', icon: BriefcaseBusiness, path: `${staffBasePath}/opportunities`, route: 'opportunities' },
  { label: 'Applications', group: 'Placement', icon: FileText, path: `${staffBasePath}/applications`, route: 'applications' },
  { label: 'Interviews', group: 'Placement', icon: CalendarDays, path: `${staffBasePath}/interviews`, route: 'interviews' },
  { label: 'Offers', group: 'Placement', icon: BriefcaseBusiness, path: `${staffBasePath}/offers`, route: 'offers' },
  { label: 'Employers', group: 'Engagement', icon: Building2, path: `${staffBasePath}/employers`, route: 'employers' },
  { label: 'Communications', group: 'Engagement', icon: MessageSquare, path: `${staffBasePath}/communications`, route: 'communications' },
  { label: 'Events', group: 'Engagement', icon: CalendarDays, path: `${staffBasePath}/events`, route: 'events' },
  { label: 'Reports', group: 'Analytics', icon: BarChart3, path: `${staffBasePath}/reports`, route: 'reports' },
  { label: 'Dashboards', group: 'Analytics', icon: LayoutDashboard, path: `${staffBasePath}/dashboards`, route: 'dashboards' },
];

export const staffNavGroups = ['Home', 'Students', 'Placement', 'Engagement', 'Analytics'] as const;
export const dashboardFilters = ['All departments', 'CSE', 'ECE', 'ME', 'IT', 'Civil'] as const;
export const dateRanges = ['Aug 1 - Aug 16, 2025', 'Last 30 days', 'This quarter'] as const;
export const riskFilters = ['All readiness', 'Needs intervention', 'High risk'] as const;
