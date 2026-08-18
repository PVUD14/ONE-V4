import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import type { StaffRouteKey } from './staffConfig.js';

export type StaffAuditEvent = {
  readonly id: string;
  readonly route: StaffRouteKey;
  readonly action: string;
  readonly detail: string;
};

export type StaffPreviewRecord = {
  readonly route: StaffRouteKey;
  readonly title: string;
  readonly status: string;
  readonly owner: string;
  readonly note: string;
};

type StaffPreviewState = {
  readonly dirty: boolean;
  readonly records: readonly StaffPreviewRecord[];
  readonly activity: readonly StaffAuditEvent[];
};

type StaffPreviewAction =
  | { readonly type: 'upsert'; readonly record: StaffPreviewRecord; readonly action: string }
  | { readonly type: 'reset' };

const initialRecords: readonly StaffPreviewRecord[] = [
  { route: 'students', title: 'Rahul Kumar placement status', status: 'Needs intervention', owner: 'Anita Sharma', note: 'Student identity, consent and documents are read-only.' },
  { route: 'assessments', title: 'Aptitude diagnostic', status: 'Scheduled', owner: 'Training Team', note: 'Completed assessment results are read-only.' },
  { route: 'interventions', title: 'Resume Review', status: 'In progress', owner: 'Placement Cell', note: 'Institution intervention metadata can be edited in preview.' },
  { route: 'opportunities', title: 'Security Analyst Intern', status: 'Recommended to CSE 2027', owner: 'Employer Relations', note: 'Employer-owned opportunity terms are read-only.' },
  { route: 'communications', title: 'TCS campus drive announcement', status: 'Draft', owner: 'Placement Cell', note: 'Delivery status is a preview presentation.' },
  { route: 'events', title: 'Resume workshop', status: 'Published preview', owner: 'Training Team', note: 'Registration counts are fixture-backed.' },
  { route: 'dashboards', title: 'CSE readiness watch', status: 'Default preview', owner: 'Anita Sharma', note: 'Saved view exists only for this session.' },
];

const initialState: StaffPreviewState = { dirty: false, records: initialRecords, activity: [] };

function reducer(state: StaffPreviewState, action: StaffPreviewAction): StaffPreviewState {
  if (action.type === 'reset') return initialState;
  const existing = state.records.findIndex((record) => record.route === action.record.route && record.title === action.record.title);
  const records = existing >= 0
    ? state.records.map((record, index) => index === existing ? action.record : record)
    : [action.record, ...state.records];
  return {
    dirty: true,
    records,
    activity: [{ id: `staff-activity-${state.activity.length + 1}`, route: action.record.route, action: action.action, detail: `${action.record.title}: ${action.record.status}` }, ...state.activity],
  };
}

const StaffPreviewContext = createContext<{
  readonly dirty: boolean;
  readonly records: readonly StaffPreviewRecord[];
  readonly activity: readonly StaffAuditEvent[];
  readonly upsertRecord: (record: StaffPreviewRecord, action: string) => void;
  readonly resetDemoData: () => void;
} | null>(null);

export function StaffPreviewProvider({ children }: { readonly children: ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({
    dirty: state.dirty,
    records: state.records,
    activity: state.activity,
    upsertRecord: (record: StaffPreviewRecord, action: string) => dispatch({ type: 'upsert', record, action }),
    resetDemoData: () => dispatch({ type: 'reset' }),
  }), [state]);
  return <StaffPreviewContext.Provider value={value}>{children}</StaffPreviewContext.Provider>;
}

export function useStaffPreviewState() {
  const value = useContext(StaffPreviewContext);
  if (!value) throw new Error('useStaffPreviewState must be used inside StaffPreviewProvider');
  return value;
}
