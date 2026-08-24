import { createContext, useContext, useMemo, useState } from 'react';

/**
 * Session-local pilot state shared across pages of one portal: navigation by
 * page key, and the rows a demo user creates through sample forms (posted
 * roles, scheduled assessments, assigned interventions, goal companies).
 * Everything resets on reload by design - each client demo starts clean.
 */

export interface PostedRole {
  readonly title: string;
  readonly location: string;
  readonly type: string;
  readonly status: 'Draft' | 'Live';
}

export interface CreatedAssessment {
  readonly name: string;
  readonly date: string;
  readonly kind: string;
  readonly invited: number;
}

export interface CreatedIntervention {
  readonly student: string;
  readonly action: string;
  readonly owner: string;
  readonly due: string;
}

interface PilotSession {
  navigate(pageKey: string): void;
  readonly postedRoles: readonly PostedRole[];
  addRole(role: PostedRole): void;
  readonly createdAssessments: readonly CreatedAssessment[];
  addAssessment(assessment: CreatedAssessment): void;
  readonly createdInterventions: readonly CreatedIntervention[];
  addIntervention(intervention: CreatedIntervention): void;
  readonly goalCompanies: readonly string[];
  addGoalCompany(name: string): void;
  readonly profilePhotoUrl: string | null;
  setProfilePhoto(url: string): void;
}

const PilotSessionContext = createContext<PilotSession | null>(null);

export function usePilotSession(): PilotSession {
  const session = useContext(PilotSessionContext);
  if (!session) throw new Error('usePilotSession must be used inside PilotSessionProvider');
  return session;
}

export function PilotSessionProvider({ navigate, children }: {
  readonly navigate: (pageKey: string) => void;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const [postedRoles, setPostedRoles] = useState<readonly PostedRole[]>([]);
  const [createdAssessments, setCreatedAssessments] = useState<readonly CreatedAssessment[]>([]);
  const [createdInterventions, setCreatedInterventions] = useState<readonly CreatedIntervention[]>([]);
  const [goalCompanies, setGoalCompanies] = useState<readonly string[]>([]);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);

  const session = useMemo<PilotSession>(() => ({
    navigate,
    postedRoles,
    addRole: (role) => setPostedRoles((previous) => [...previous, role]),
    createdAssessments,
    addAssessment: (assessment) => setCreatedAssessments((previous) => [...previous, assessment]),
    createdInterventions,
    addIntervention: (intervention) => setCreatedInterventions((previous) => [...previous, intervention]),
    goalCompanies,
    addGoalCompany: (name) => setGoalCompanies((previous) => previous.includes(name) ? previous : [...previous, name]),
    profilePhotoUrl,
    setProfilePhoto: (url) => setProfilePhotoUrl(url),
  }), [navigate, postedRoles, createdAssessments, createdInterventions, goalCompanies, profilePhotoUrl]);

  return <PilotSessionContext.Provider value={session}>{children}</PilotSessionContext.Provider>;
}
