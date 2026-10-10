/**
 * Nav label -> Momentum icon, for every portal's navigation.
 *
 * The approved labels come from the design inventory's icon-map.json (copied to
 * src/assets/one/icons/icon-map.json); a test proves every one of them resolves here exactly
 * as the map says. The app has some nav labels the map does not cover (the career-counselor,
 * analyst, hiring-manager and interviewer previews, the placement staff shell, the pilot demo);
 * those use the nearest icon from the same set, listed under `extraNavIcons`. Detail pages use
 * their parent's icon, and Dashboard, Home and Overview all use `home`.
 */
import type { IconName } from './iconData.js';

/** Every label in icon-map.json, across all portals (the map never gives one label two icons). */
export const approvedNavIcons: Readonly<Record<string, IconName>> = {
  Home: 'home', Dashboard: 'home', Overview: 'home',
  'My Career': 'career', 'AI Career Coach': 'coach', 'Career Tools': 'tools', Readiness: 'readiness',
  'Career Readiness': 'readiness', Skills: 'skills', Assessments: 'assessments', 'Assessment Detail': 'assessments',
  Learning: 'learning', Practice: 'practice', 'Company Prep': 'company', 'Company Profile': 'company',
  Experience: 'experience', Opportunities: 'opportunities', 'Opportunity Detail': 'opportunities',
  'Opportunities and Offers': 'opportunities', Applications: 'applications', Interviews: 'interviews',
  Calendar: 'calendar', Scholarships: 'scholarships', 'Resume Builder': 'resume', Documents: 'documents',
  Profile: 'profile', Settings: 'settings', 'Help & FAQ': 'help',
  Students: 'students', 'My Students': 'students', 'Student Detail': 'students', 'Student Search': 'student-search',
  Departments: 'departments', 'Department Overview': 'departments', Batches: 'batches',
  'Academic Structure': 'academic-structure', Interventions: 'interventions', Staff: 'staff', 'Faculty and Staff': 'staff',
  Placement: 'placement', Reports: 'reports', 'Reports and Analytics': 'reports',
  'Academic Verification': 'verification', Verification: 'verification', 'Assigned Tasks': 'tasks',
  'Learning Resources': 'resources', Messages: 'messages', 'Placement Pipeline': 'pipeline', Meetings: 'meetings',
  Applicants: 'applicants', 'Candidate Detail': 'applicants', 'Talent Pool': 'talent-pool', Offers: 'offers', Team: 'team',
  Organizations: 'organizations', 'Organization Detail': 'organizations', Users: 'users', 'User Detail': 'users',
  'Trust and Safety': 'trust-safety', 'AI Operations': 'ai-operations', Subscriptions: 'subscriptions', Billing: 'billing',
  Analytics: 'analytics', 'System Health': 'system-health', 'Audit Logs': 'audit-logs', Security: 'security',
  'Feature Flags': 'feature-flags', Support: 'support',
  Leads: 'leads', Field: 'field', Territory: 'territory', Targets: 'targets', Commission: 'commission',
};

/** App nav labels the inventory map does not list: the nearest icon from the same set. */
export const extraNavIcons: Readonly<Record<string, IconName>> = {
  // Operations
  'Content Management': 'documents',
  // Career counselor preview
  'Counselor Sessions': 'meetings', 'Student Cases': 'students', 'Counseling Notes': 'documents',
  'Career Guidance': 'career', Resources: 'resources',
  // Institution analyst preview
  'Analysis Overview': 'analytics', 'Placement Analysis': 'placement', 'Readiness Analysis': 'readiness',
  'Skill Gap Analysis': 'skills', 'Cohort Comparison': 'analytics', 'Data Exports': 'reports',
  Visualizations: 'analytics', 'Saved Views': 'reports',
  // Hiring manager preview (requisitions are the employer's opportunities; candidates its applicants)
  Requisitions: 'opportunities', 'Requisition Detail': 'opportunities', Candidates: 'applicants',
  'Candidate Review': 'applicants', Evaluations: 'assessments', 'Hiring Reports': 'reports',
  // Interviewer preview
  'My Interviews': 'interviews', Schedule: 'calendar', 'Candidate Brief': 'applicants', Scorecards: 'assessments',
  Feedback: 'messages', 'Interview Guidelines': 'documents',
  // Placement staff shell
  Employers: 'company', Communications: 'messages', Events: 'calendar', Dashboards: 'home',
  // Pilot demo and the legacy demo nav
  'My Roadmap': 'career', 'Career Path': 'career', Learn: 'learning', 'Placement Drives': 'placement',
};

/** The icon for a nav label. Unknown labels fall back to `documents`, as Lucide's FileText did. */
export function navIconFor(label: string): IconName {
  return approvedNavIcons[label] ?? extraNavIcons[label] ?? 'documents';
}
