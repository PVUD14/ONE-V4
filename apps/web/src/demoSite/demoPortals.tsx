/**
 * The demo site's extra portals - lecturer, operations, growth and graduate - built on
 * the same PilotShell as the student, placement-officer and employer pilots, so every
 * role on demo.oneby8.com shares one look, one "Demo — sample data" marker and one
 * reset-on-reload behaviour (all state is in memory).
 */
import { useCallback, useState } from 'react';
import { Activity, BadgeCheck, BadgeIndianRupee, BookOpen, Building2, ClipboardCheck, FileCheck2, GraduationCap, Home, Library, MailCheck, MapPin, Megaphone, ShieldCheck, Target, Users } from 'lucide-react';
import { PilotShell, type NavEntry, type PilotPortalProps } from '../pilot/PilotApp.js';
import { PilotSessionProvider } from '../pilot/pilotSession.js';
import {
  LecturerAnnouncements, LecturerAssessments, LecturerDashboard, LecturerResources,
  LecturerStudents, LecturerVerification, lecturerPersona,
} from './lecturerPages.js';
import {
  OperationsAudit, OperationsColleges, OperationsContent, OperationsEmployers,
  OperationsInvitations, OperationsOverview, operationsPersona,
} from './operationsPages.js';
import { GrowthCommission, GrowthHome, GrowthLeads, GrowthTargets, GrowthTerritory, GrowthVisits, growthPersona } from './growthPages.js';
import { GraduateHome, GraduateRecords, GraduateVerification, graduatePersona, useGraduateState } from './graduatePages.js';

type Messages = readonly (readonly [string, string])[];

function usePage(): [string, (key: string) => void] {
  const [page, setPage] = useState('dashboard');
  return [page, useCallback((key: string) => setPage(key), [])];
}

const LECTURER_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: Home },
  { key: 'students', label: 'My Students', icon: Users },
  { key: 'assessments', label: 'Assessments', icon: ClipboardCheck },
  { key: 'verification', label: 'Evidence & Verification', icon: FileCheck2 },
  { key: 'resources', label: 'Learning Resources', icon: BookOpen },
  { key: 'announcements', label: 'Announcements', icon: Megaphone },
];

const LECTURER_NOTIFICATIONS: Messages = [
  ['Kavitha Selvam (former student) asked to verify her degree', 'Today'],
  ['SQL Lab Quiz 2 starts 24 May, 09:00 AM', 'Today'],
  ['41 of 62 students finished the Trees & Graphs practice set', 'Yesterday'],
];
const LECTURER_MESSAGES: Messages = [
  ['Prof. Meera Nair', 'Can you nominate three CSE 3A students for the Zenvia drive?'],
  ['Arjun Reddy', 'I have submitted my mini-project for review, sir.'],
];

export function LecturerPilot({ email, onSignOut, signOutLabel }: PilotPortalProps): React.ReactElement {
  const [page, navigate] = usePage();
  return <PilotSessionProvider navigate={navigate} initialNotifications={LECTURER_NOTIFICATIONS}>
    <PilotShell
      identity={{ name: lecturerPersona.name, initials: lecturerPersona.initials, subtitle: lecturerPersona.role }}
      nav={LECTURER_NAV} page={page} onNavigate={navigate} onSignOut={onSignOut} signOutLabel={signOutLabel} email={email}
      notifications={LECTURER_NOTIFICATIONS} messages={LECTURER_MESSAGES}
      searchExtras={[{ label: 'Arjun Reddy', detail: 'Student · CSE 3A', navKey: 'students' }, { label: 'Kavitha Selvam', detail: 'Former student · record request', navKey: 'verification' }]}
      identityRows={[['Role', lecturerPersona.role], ['College', lecturerPersona.college], ['Classes', 'CSE 3A · CSE 3B · CSE 4 projects']]}>
      {page === 'dashboard' ? <LecturerDashboard onNavigate={navigate} /> : null}
      {page === 'students' ? <LecturerStudents /> : null}
      {page === 'assessments' ? <LecturerAssessments /> : null}
      {page === 'verification' ? <LecturerVerification /> : null}
      {page === 'resources' ? <LecturerResources /> : null}
      {page === 'announcements' ? <LecturerAnnouncements /> : null}
    </PilotShell>
  </PilotSessionProvider>;
}

const OPERATIONS_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Overview', icon: Home },
  { key: 'colleges', label: 'Colleges', icon: GraduationCap },
  { key: 'employers', label: 'Employer Verification', icon: ShieldCheck },
  { key: 'invitations', label: 'Staff Invitations', icon: MailCheck },
  { key: 'content', label: 'Question Bank', icon: Library },
  { key: 'audit', label: 'Audit Log', icon: Activity },
];

const OPERATIONS_NOTIFICATIONS: Messages = [
  ['Brightpath Fintech requested employer access', 'Today'],
  ['Lakeview imported 117 students into Batch 2028', 'Today'],
  ['Invitation to Riverside College expired', 'Yesterday'],
];
const OPERATIONS_MESSAGES: Messages = [
  ['Vikram Shetty (Growth)', 'Coastal Engineering College signed - over to you for onboarding.'],
  ['Farah Siddiqui, Hillcrest', 'Roster is in. When can our students start the placement test?'],
];

export function OperationsPilot({ email, onSignOut, signOutLabel }: PilotPortalProps): React.ReactElement {
  const [page, navigate] = usePage();
  return <PilotSessionProvider navigate={navigate} initialNotifications={OPERATIONS_NOTIFICATIONS}>
    <PilotShell
      identity={{ name: operationsPersona.name, initials: operationsPersona.initials, subtitle: operationsPersona.role }}
      nav={OPERATIONS_NAV} page={page} onNavigate={navigate} onSignOut={onSignOut} signOutLabel={signOutLabel} email={email}
      notifications={OPERATIONS_NOTIFICATIONS} messages={OPERATIONS_MESSAGES}
      searchExtras={[{ label: 'Lakeview Institute of Technology', detail: 'College · Live', navKey: 'colleges' }, { label: 'Brightpath Fintech', detail: 'Employer · waiting for verification', navKey: 'employers' }]}
      identityRows={[['Role', 'Platform Operations'], ['Organisation', 'AI8HT'], ['Approvals', 'Second approver for sensitive changes']]}>
      {page === 'dashboard' ? <OperationsOverview onNavigate={navigate} /> : null}
      {page === 'colleges' ? <OperationsColleges /> : null}
      {page === 'employers' ? <OperationsEmployers /> : null}
      {page === 'invitations' ? <OperationsInvitations /> : null}
      {page === 'content' ? <OperationsContent /> : null}
      {page === 'audit' ? <OperationsAudit /> : null}
    </PilotShell>
  </PilotSessionProvider>;
}

const GROWTH_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Home', icon: Home },
  { key: 'leads', label: 'Leads', icon: Users },
  { key: 'visits', label: 'Field Visits', icon: MapPin },
  { key: 'territory', label: 'Territory', icon: Building2 },
  { key: 'targets', label: 'Targets', icon: Target },
  { key: 'commission', label: 'Commission', icon: BadgeIndianRupee },
];

const GROWTH_NOTIFICATIONS: Messages = [
  ['Sunrise Arts & Science College confirmed the 24 May demo', 'Today'],
  ['Operations started onboarding Coastal Engineering College', 'Yesterday'],
];
const GROWTH_MESSAGES: Messages = [
  ['Ananya Kulkarni (Operations)', 'Got Coastal - admin invitation is out.'],
  ['Zone lead', 'Two more colleges to hit the quarter. You are close!'],
];

export function GrowthPilot({ email, onSignOut, signOutLabel }: PilotPortalProps): React.ReactElement {
  const [page, navigate] = usePage();
  return <PilotSessionProvider navigate={navigate} initialNotifications={GROWTH_NOTIFICATIONS}>
    <PilotShell
      identity={{ name: growthPersona.name, initials: growthPersona.initials, subtitle: growthPersona.role }}
      nav={GROWTH_NAV} page={page} onNavigate={navigate} onSignOut={onSignOut} signOutLabel={signOutLabel} email={email}
      notifications={GROWTH_NOTIFICATIONS} messages={GROWTH_MESSAGES}
      searchExtras={[{ label: 'Greenfield Polytechnic College', detail: 'Lead · proposal sent', navKey: 'leads' }]}
      identityRows={[['Role', 'Partnerships Executive'], ['Zone', 'South'], ['Organisation', 'AI8HT']]}>
      {page === 'dashboard' ? <GrowthHome onNavigate={navigate} /> : null}
      {page === 'leads' ? <GrowthLeads /> : null}
      {page === 'visits' ? <GrowthVisits /> : null}
      {page === 'territory' ? <GrowthTerritory /> : null}
      {page === 'targets' ? <GrowthTargets /> : null}
      {page === 'commission' ? <GrowthCommission /> : null}
    </PilotShell>
  </PilotSessionProvider>;
}

const GRADUATE_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Home', icon: Home },
  { key: 'verification', label: 'Verification', icon: ShieldCheck },
  { key: 'records', label: 'My Records', icon: BadgeCheck },
];

const GRADUATE_NOTIFICATIONS: Messages = [
  ['Sunrise Junior College verified your Class XII marks', 'Mar 2026'],
];
const GRADUATE_MESSAGES: Messages = [
  ['ONE', 'Welcome back, Kavitha. Your college is on ONE - you can request verification now.'],
];

export function GraduatePilot({ email, onSignOut, signOutLabel }: PilotPortalProps): React.ReactElement {
  const [page, navigate] = usePage();
  const state = useGraduateState();
  return <PilotSessionProvider navigate={navigate} initialNotifications={GRADUATE_NOTIFICATIONS}>
    <PilotShell
      identity={{ name: graduatePersona.name, initials: graduatePersona.initials, subtitle: graduatePersona.subtitle }}
      nav={GRADUATE_NAV} page={page} onNavigate={navigate} onSignOut={onSignOut} signOutLabel={signOutLabel} email={email}
      notifications={GRADUATE_NOTIFICATIONS} messages={GRADUATE_MESSAGES}
      searchExtras={[]}
      identityRows={[['Degree', 'B.Tech IT · 2018 – 2022'], ['College', 'Lakeview Institute of Technology'], ['Now', 'QA Analyst, Orbitech Solutions']]}>
      {page === 'dashboard' ? <GraduateHome state={state} onNavigate={navigate} /> : null}
      {page === 'verification' ? <GraduateVerification state={state} /> : null}
      {page === 'records' ? <GraduateRecords state={state} /> : null}
    </PilotShell>
  </PilotSessionProvider>;
}
