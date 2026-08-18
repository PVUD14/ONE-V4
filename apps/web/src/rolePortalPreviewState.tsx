import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import type { RoleFixture, RolePortalKey } from './rolePortalConfig.js';

export interface RolePreviewRecord extends RoleFixture {
  readonly note: string;
}

export interface RolePreviewActivity {
  readonly id: string;
  readonly role: RolePortalKey;
  readonly action: string;
  readonly detail: string;
}

interface RolePreviewState {
  readonly dirty: boolean;
  readonly recordsByRole: Readonly<Record<string, readonly RolePreviewRecord[]>>;
  readonly activity: readonly RolePreviewActivity[];
  readonly savedViews: readonly string[];
}

type RolePreviewAction =
  | { readonly type: 'detail'; readonly role: RolePortalKey; readonly record: RoleFixture }
  | { readonly type: 'save'; readonly role: RolePortalKey; readonly record: RoleFixture; readonly note: string; readonly status: string; readonly action: string }
  | { readonly type: 'savedView'; readonly role: RolePortalKey; readonly name: string }
  | { readonly type: 'reset' };

const initialState: RolePreviewState = { dirty: false, recordsByRole: {}, activity: [], savedViews: [] };

function nextActivityId(state: RolePreviewState): string {
  return `role-activity-${state.activity.length + 1}`;
}

function reducer(state: RolePreviewState, action: RolePreviewAction): RolePreviewState {
  if (action.type === 'reset') return initialState;
  if (action.type === 'savedView') {
    return {
      ...state,
      dirty: true,
      savedViews: state.savedViews.includes(action.name) ? state.savedViews : [action.name, ...state.savedViews],
      activity: [{ id: nextActivityId(state), role: action.role, action: 'Saved preview view', detail: action.name }, ...state.activity],
    };
  }
  if (action.type === 'detail') {
    return {
      ...state,
      activity: [{ id: nextActivityId(state), role: action.role, action: 'Opened detail', detail: action.record.title }, ...state.activity],
    };
  }
  const nextRecord: RolePreviewRecord = { ...action.record, status: action.status, note: action.note };
  const existing = state.recordsByRole[action.role] ?? [];
  const records = existing.some((record) => record.id === nextRecord.id)
    ? existing.map((record) => record.id === nextRecord.id ? nextRecord : record)
    : [nextRecord, ...existing];
  return {
    ...state,
    dirty: true,
    recordsByRole: { ...state.recordsByRole, [action.role]: records },
    activity: [{ id: nextActivityId(state), role: action.role, action: action.action, detail: `${nextRecord.title}: ${nextRecord.status}` }, ...state.activity],
  };
}

const RolePreviewContext = createContext<{
  readonly dirty: boolean;
  readonly recordsByRole: Readonly<Record<string, readonly RolePreviewRecord[]>>;
  readonly activity: readonly RolePreviewActivity[];
  readonly savedViews: readonly string[];
  readonly openDetail: (role: RolePortalKey, record: RoleFixture) => void;
  readonly saveRecord: (role: RolePortalKey, record: RoleFixture, note: string, status: string, action: string) => void;
  readonly saveView: (role: RolePortalKey, name: string) => void;
  readonly reset: () => void;
} | null>(null);

export function RolePreviewProvider({ children }: { readonly children: ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({
    dirty: state.dirty,
    recordsByRole: state.recordsByRole,
    activity: state.activity,
    savedViews: state.savedViews,
    openDetail: (role: RolePortalKey, record: RoleFixture) => dispatch({ type: 'detail', role, record }),
    saveRecord: (role: RolePortalKey, record: RoleFixture, note: string, status: string, action: string) => dispatch({ type: 'save', role, record, note, status, action }),
    saveView: (role: RolePortalKey, name: string) => dispatch({ type: 'savedView', role, name }),
    reset: () => dispatch({ type: 'reset' }),
  }), [state]);
  return <RolePreviewContext.Provider value={value}>{children}</RolePreviewContext.Provider>;
}

export function useRolePreviewState() {
  const value = useContext(RolePreviewContext);
  if (!value) throw new Error('useRolePreviewState must be used inside RolePreviewProvider');
  return value;
}
