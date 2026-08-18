import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import { applications, coachMessages, documents, experiences, learningCatalog, opportunities, skills, studentProfile } from './studentData.js';

export type StudentActivity = { readonly at: string; readonly label: string; readonly detail: string };
export type StudentSkill = (typeof skills)[number] & { readonly id: string; readonly studentOwned: boolean; readonly evidenceNote?: string };
export type StudentExperience = (typeof experiences)[number] & { readonly id: string; readonly studentOwned: boolean; readonly verificationRequested?: boolean };
export type StudentDocument = (typeof documents)[number] & { readonly id: string; readonly studentOwned: boolean; readonly description?: string };
export type StudentApplication = (typeof applications)[number] & { readonly id: string; readonly draftNote?: string; readonly studentDraft: boolean; readonly withdrawn?: boolean };
export type CoachMessage = { readonly speaker: string; readonly message: string };

export interface StudentPreviewState {
  readonly targetCareer: string;
  readonly preferredName: string;
  readonly profileSummary: string;
  readonly skills: readonly StudentSkill[];
  readonly experiences: readonly StudentExperience[];
  readonly documents: readonly StudentDocument[];
  readonly savedOpportunityRoles: readonly string[];
  readonly applications: readonly StudentApplication[];
  readonly learningProgress: Readonly<Record<string, number>>;
  readonly learningPreferences: readonly string[];
  readonly interviewChecklist: Readonly<Record<string, boolean>>;
  readonly interviewNote: string;
  readonly rescheduleRequested: boolean;
  readonly settings: {
    readonly emailSummary: boolean;
    readonly inAppNotifications: boolean;
    readonly assessmentReminders: boolean;
    readonly interviewReminders: boolean;
    readonly opportunityAlerts: boolean;
    readonly profileDiscovery: boolean;
    readonly employerVisibility: boolean;
    readonly reducedMotion: boolean;
    readonly higherContrast: boolean;
    readonly consentResume: boolean;
    readonly consentEvidence: boolean;
  };
  readonly coachMessages: readonly CoachMessage[];
  readonly activity: readonly StudentActivity[];
  readonly dirty: boolean;
  readonly status: string;
}

type Action =
  | { readonly type: 'status'; readonly status: string }
  | { readonly type: 'reset' }
  | { readonly type: 'targetCareer'; readonly value: string }
  | { readonly type: 'profile'; readonly preferredName: string; readonly summary: string }
  | { readonly type: 'addSkill'; readonly name: string; readonly group: string; readonly level: number; readonly evidenceNote?: string }
  | { readonly type: 'updateSkill'; readonly id: string; readonly level: number; readonly evidenceNote?: string }
  | { readonly type: 'removeSkill'; readonly id: string }
  | { readonly type: 'addExperience'; readonly name: string; readonly typeName: string; readonly competency: string; readonly evidence: string }
  | { readonly type: 'updateExperience'; readonly id: string; readonly name: string; readonly competency: string; readonly evidence: string }
  | { readonly type: 'deleteExperience'; readonly id: string }
  | { readonly type: 'requestVerification'; readonly id: string }
  | { readonly type: 'toggleSavedOpportunity'; readonly role: string }
  | { readonly type: 'createApplicationDraft'; readonly role: string; readonly employer: string }
  | { readonly type: 'updateApplicationDraft'; readonly id: string; readonly note: string; readonly documents?: string }
  | { readonly type: 'withdrawApplication'; readonly id: string; readonly reason?: string }
  | { readonly type: 'learningProgress'; readonly title: string; readonly progress: number }
  | { readonly type: 'learningPreferences'; readonly preferences: readonly string[] }
  | { readonly type: 'interviewChecklist'; readonly key: string; readonly value: boolean }
  | { readonly type: 'interviewNote'; readonly note: string }
  | { readonly type: 'requestReschedule' }
  | { readonly type: 'addDocument'; readonly name: string; readonly kind: string; readonly description: string; readonly visibility: string }
  | { readonly type: 'updateDocument'; readonly id: string; readonly name: string; readonly description: string; readonly visibility: string }
  | { readonly type: 'deleteDocument'; readonly id: string }
  | { readonly type: 'setting'; readonly key: keyof StudentPreviewState['settings']; readonly value: boolean }
  | { readonly type: 'coachSend'; readonly message: string }
  | { readonly type: 'coachClear' };

interface StudentPreviewContextValue {
  readonly state: StudentPreviewState;
  readonly dispatch: React.Dispatch<Action>;
}

const StudentPreviewContext = createContext<StudentPreviewContextValue | null>(null);

export function StudentPreviewProvider({ children }: { readonly children: ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StudentPreviewContext.Provider value={value}>{children}</StudentPreviewContext.Provider>;
}

export function useStudentPreview(): StudentPreviewContextValue {
  const value = useContext(StudentPreviewContext);
  if (!value) throw new Error('useStudentPreview must be used within StudentPreviewProvider');
  return value;
}

function initialState(): StudentPreviewState {
  return {
    targetCareer: studentProfile.targetRole,
    preferredName: studentProfile.name,
    profileSummary: 'Cybersecurity Analyst roles focused on SOC monitoring, alert triage and incident communication.',
    skills: skills.map((skill, index) => ({ ...skill, id: `skill-${index}`, studentOwned: ['Self-declared', 'Claimed', 'Course artifact', 'Practice needed'].includes(skill.state) })),
    experiences: experiences.map((item, index) => ({ ...item, id: `experience-${index}`, studentOwned: !item.state.includes('Institution-verified') })),
    documents: documents.map((item, index) => ({ ...item, id: `document-${index}`, studentOwned: ['Resume', 'Portfolio'].includes(item.kind), description: `${item.kind} metadata owned by the student preview.` })),
    savedOpportunityRoles: opportunities.filter((item) => item.saved).map((item) => item.role),
    applications: applications.map((item, index) => ({ ...item, id: `application-${index}`, studentDraft: item.stage === 'Draft' })),
    learningProgress: Object.fromEntries(learningCatalog.map((item) => [item.title, item.progress])),
    learningPreferences: ['SIEM', 'Linux', 'Communication'],
    interviewChecklist: { linuxNotes: true, triageStory: false, resumeReview: true, questionsPrepared: false },
    interviewNote: 'Practice one concise incident timeline before the Aster round.',
    rescheduleRequested: false,
    settings: {
      emailSummary: true,
      inAppNotifications: true,
      assessmentReminders: true,
      interviewReminders: true,
      opportunityAlerts: true,
      profileDiscovery: false,
      employerVisibility: true,
      reducedMotion: false,
      higherContrast: false,
      consentResume: true,
      consentEvidence: true,
    },
    coachMessages,
    activity: [],
    dirty: false,
    status: 'Session-local Student preview ready.',
  };
}

const nextPreviewId = (prefix: string, existing: readonly { id: string }[]) => `${prefix}-${existing.length + 1}`;

function reducer(state: StudentPreviewState, action: Action): StudentPreviewState {
  if (action.type === 'reset') return withActivity(initialState(), 'Reset Student preview', 'Session-local Student edits were reset.');
  if (action.type === 'status') return { ...state, status: action.status };
  if (action.type === 'targetCareer') return withActivity({ ...state, targetCareer: action.value }, 'Updated target career', action.value);
  if (action.type === 'profile') return withActivity({ ...state, preferredName: action.preferredName, profileSummary: action.summary }, 'Updated Student-owned profile', action.preferredName);
  if (action.type === 'addSkill') {
    const newSkill: StudentSkill = { id: nextPreviewId('skill-preview', state.skills), name: action.name, group: action.group, level: action.level, requirement: 70, evidence: action.evidenceNote ? 'Medium' : 'Weak', state: 'Self-declared', trend: '+0', studentOwned: true, ...(action.evidenceNote ? { evidenceNote: action.evidenceNote } : {}) };
    return withActivity({ ...state, skills: [newSkill, ...state.skills] }, 'Added self-declared skill', action.name);
  }
  if (action.type === 'updateSkill') return withActivity({ ...state, skills: state.skills.map((skill) => skill.id === action.id && skill.studentOwned ? { ...skill, level: action.level, ...(action.evidenceNote ? { evidenceNote: action.evidenceNote } : {}), evidence: action.evidenceNote ? 'Medium' : skill.evidence } : skill) }, 'Updated skill evidence', 'Student-owned skill metadata changed.');
  if (action.type === 'removeSkill') return withActivity({ ...state, skills: state.skills.filter((skill) => skill.id !== action.id || !skill.studentOwned) }, 'Removed self-declared skill', 'Verified skills were preserved.');
  if (action.type === 'addExperience') return withActivity({ ...state, experiences: [{ id: nextPreviewId('experience-preview', state.experiences), name: action.name, type: action.typeName, state: 'Self-declared', competency: action.competency, impact: 'Preview only', evidence: action.evidence, studentOwned: true }, ...state.experiences] }, 'Added Student-created experience', action.name);
  if (action.type === 'updateExperience') return withActivity({ ...state, experiences: state.experiences.map((item) => item.id === action.id && item.studentOwned ? { ...item, name: action.name, competency: action.competency, evidence: action.evidence } : item) }, 'Updated experience metadata', action.name);
  if (action.type === 'deleteExperience') return withActivity({ ...state, experiences: state.experiences.filter((item) => item.id !== action.id || !item.studentOwned) }, 'Deleted Student-created experience', 'Verified experience entries were preserved.');
  if (action.type === 'requestVerification') return withActivity({ ...state, experiences: state.experiences.map((item) => item.id === action.id && item.studentOwned ? { ...item, state: 'Verification requested', verificationRequested: true } : item) }, 'Requested verification', 'Institution verification remains read-only until backend review.');
  if (action.type === 'toggleSavedOpportunity') return withActivity({ ...state, savedOpportunityRoles: state.savedOpportunityRoles.includes(action.role) ? state.savedOpportunityRoles.filter((role) => role !== action.role) : [...state.savedOpportunityRoles, action.role] }, 'Updated saved opportunity', action.role);
  if (action.type === 'createApplicationDraft') {
    const exists = state.applications.some((item) => item.role === action.role && item.studentDraft && !item.withdrawn);
    if (exists) return { ...state, status: 'A draft or active application already exists for this role.' };
    return withActivity({ ...state, applications: [{ id: nextPreviewId('application-preview', state.applications), employer: action.employer, role: action.role, stage: 'Draft', date: 'Today', next: 'Complete draft answers', deadline: 'Preview only', documents: 'Choose resume draft', interview: 'Not scheduled', assessment: 'Not assigned', logo: action.employer.slice(0, 2).toUpperCase(), studentDraft: true, draftNote: '' }, ...state.applications] }, 'Created application draft', `${action.role} at ${action.employer}`);
  }
  if (action.type === 'updateApplicationDraft') return withActivity({ ...state, applications: state.applications.map((item) => item.id === action.id && item.studentDraft ? { ...item, draftNote: action.note, documents: action.documents ?? item.documents, next: 'Review and submit through secure backend' } : item) }, 'Updated application draft', 'Draft-only content changed.');
  if (action.type === 'withdrawApplication') return withActivity({ ...state, applications: state.applications.map((item) => item.id === action.id ? { ...item, withdrawn: true, stage: 'Closed', next: action.reason ? `Withdrawal requested: ${action.reason}` : 'Removed local draft in session preview' } : item) }, 'Withdrew application preview', action.reason ? `Reason recorded locally: ${action.reason}` : 'No employer was notified.');
  if (action.type === 'learningProgress') return withActivity({ ...state, learningProgress: { ...state.learningProgress, [action.title]: Math.min(100, action.progress) } }, 'Updated learning progress', action.title);
  if (action.type === 'learningPreferences') return withActivity({ ...state, learningPreferences: action.preferences }, 'Updated learning preferences', action.preferences.join(', '));
  if (action.type === 'interviewChecklist') return withActivity({ ...state, interviewChecklist: { ...state.interviewChecklist, [action.key]: action.value } }, 'Updated interview prep checklist', action.key);
  if (action.type === 'interviewNote') return withActivity({ ...state, interviewNote: action.note }, 'Updated private interview note', 'Student-only note saved locally.');
  if (action.type === 'requestReschedule') return withActivity({ ...state, rescheduleRequested: true }, 'Requested schedule change preview', state.rescheduleRequested ? 'Request already saved locally; no employer was notified again.' : 'No employer was notified.');
  if (action.type === 'addDocument') return withActivity({ ...state, documents: [{ id: nextPreviewId('document-preview', state.documents), name: action.name, kind: action.kind, status: 'Draft metadata', version: 'v1', updated: 'Today', visibility: action.visibility, verification: 'Not verified', studentOwned: true, description: action.description }, ...state.documents] }, 'Added document metadata', action.name);
  if (action.type === 'updateDocument') return withActivity({ ...state, documents: state.documents.map((item) => item.id === action.id && item.studentOwned ? { ...item, name: action.name, description: action.description, visibility: action.visibility, updated: 'Today' } : item) }, 'Updated document metadata', action.name);
  if (action.type === 'deleteDocument') return withActivity({ ...state, documents: state.documents.filter((item) => item.id !== action.id || !item.studentOwned) }, 'Deleted Student-created document metadata', 'Verified files were preserved.');
  if (action.type === 'setting') return withActivity({ ...state, settings: { ...state.settings, [action.key]: action.value } }, 'Updated Student setting', action.key);
  if (action.type === 'coachSend') {
    const studentMessage = { speaker: 'Rahul', message: action.message };
    const coach = { speaker: 'Coach preview', message: `Demo guidance: connect "${action.message}" to verified evidence, readiness gaps, and counselor review before acting.` };
    return withActivity({ ...state, coachMessages: [...state.coachMessages, studentMessage, coach] }, 'Added coach preview exchange', `Local demo response for "${action.message}".`);
  }
  if (action.type === 'coachClear') return withActivity({ ...state, coachMessages: [] }, 'Cleared coach conversation', 'Session-local conversation removed.');
  return state;
}

function withActivity(state: StudentPreviewState, label: string, detail: string): StudentPreviewState {
  return {
    ...state,
    dirty: true,
    status: `${label}: ${detail}`,
    activity: [{ at: 'Now', label, detail }, ...state.activity].slice(0, 8),
  };
}
