/**
 * "From your lecturer" on the student's Learning page (INST-16): what the student's lecturers set for them —
 * assigned practice sets and lessons, group sessions they are invited to, and a next step a lecturer chose for
 * them, with the reason in plain words.
 *
 * Why it exists: faculty actions are constraints the planner honours, so a student must be able to see where a
 * step came from and what is waiting. The lecturer is named by role and college only (ONE stores no staff
 * names). Nothing here is a score or a number about the student; missing data reads NA. The card lives inside
 * the existing Learning page — no navigation change (HG-3). INST-17: a preparation sprint from the college shows
 * with its end date, and the card is headed "From your college" while one is among its items.
 */
import React from 'react';
import { BookOpen, ClipboardList, Compass, Users } from 'lucide-react';
import type { StudentLearningActionsDto } from './api.js';
import { formatDate, formatDateTime } from './dates.js';

/** Why a lecturer set a student's next step, as the student reads it. */
export const LECTURER_REASON_TEXT: Readonly<Record<string, string>> = {
  CLASS_TOPIC_ALIGNMENT: 'It matches what your class is working on now.',
  PREREQUISITE_FIRST: 'Something it builds on needs attention first.',
  REVISIT_FUNDAMENTALS: 'Going back over the fundamentals will help.',
  UPCOMING_ASSESSMENT: 'It prepares you for an upcoming assessment.',
  STUDENT_REQUEST: 'You asked for it.',
  FACULTY_JUDGEMENT: 'Your lecturer thinks it is the right next step.',
};
const ACTION_WORD: Readonly<Record<string, string>> = { LEARN: 'Learn', PRACTICE: 'Practise', REVIEW: 'Review' };
const KIND_WORD: Readonly<Record<string, string>> = { PRACTICE: 'Practice set', LESSON: 'Lesson' };
const muted: React.CSSProperties = { color: 'var(--p-muted)', margin: '4px 0' };
const when = (value: string): string => formatDateTime(value);
const day = (value: string): string => formatDate(value);

/** True when a lecturer has set something the planner will bring up next. */
export function hasLecturerWork(actions: StudentLearningActionsDto | null): boolean {
  return Boolean(actions && (actions.pendingOverride || actions.assignments.some((assignment) => assignment.status === 'OPEN')));
}

export function isStudentLearningActions(value: unknown): value is StudentLearningActionsDto {
  const body = value as Partial<StudentLearningActionsDto> | null;
  return Boolean(body && Array.isArray(body.assignments) && Array.isArray(body.sessions) && 'pendingOverride' in body);
}

export function FromYourLecturerCard({ actions, status, busy, onStart }: {
  readonly actions: StudentLearningActionsDto | null;
  readonly status: string;
  readonly busy: boolean;
  readonly onStart: () => void;
}): React.ReactElement {
  const open = actions ? actions.assignments.filter((assignment) => assignment.status === 'OPEN').length : 0;
  const pending = actions?.pendingOverride ?? null;
  const empty = actions !== null && actions.assignments.length === 0 && actions.sessions.length === 0 && !pending;
  // INST-17: a preparation sprint comes from the college (the placement office, an admin or a head), not a lecturer.
  const heading = actions && actions.assignments.some((assignment) => assignment.sprint) ? 'From your college' : 'From your lecturer';
  return <section className="pilot-card" aria-labelledby="lecturer-heading">
    <div className="pilot-card-head">
      <h2 id="lecturer-heading">{heading}</h2>
      <span className={`pilot-chip ${actions ? (open || pending ? 'purple' : 'slate') : 'slate'}`}>{actions ? (pending ? 'Next step set' : `${open} open`) : 'NA'}</span>
    </div>
    {!actions ? <p style={muted}>{status}</p> : empty ? <p style={muted}>Nothing from your lecturers right now. Work they assign you appears here and comes up as your next step.</p> : <>
      {pending ? <div className="pilot-list-row" aria-label="Next step set by your lecturer">
        <span className="pilot-tile purple"><Compass size={16} /></span>
        <div className="grow">
          <strong>{`Your lecturer at ${pending.institutionName} set your next step: ${ACTION_WORD[pending.action] ?? 'Work on'} ${pending.title}`}</strong>
          <small>{LECTURER_REASON_TEXT[pending.reasonCode] ?? 'NA'}{pending.note ? ` “${pending.note}”` : ''} It starts when you plan your next step.</small>
        </div>
      </div> : null}
      {actions.assignments.length ? <div className="pilot-list" aria-label="Assigned to you">
        {actions.assignments.map((assignment) => <div key={assignment.id} className="pilot-list-row">
          <span className={`pilot-tile ${assignment.kind === 'LESSON' ? 'teal' : 'blue'}`}>{assignment.kind === 'LESSON' ? <BookOpen size={16} /> : <ClipboardList size={16} />}</span>
          <div className="grow">
            <strong>{assignment.title}</strong>
            <small>{assignment.sprint
              ? `${KIND_WORD[assignment.kind] ?? 'Work'} · ${assignment.skillName} · preparation sprint from ${assignment.institutionName} until ${day(assignment.sprint.endsAt)}`
              : `${KIND_WORD[assignment.kind] ?? 'Work'} · ${assignment.skillName} · from your lecturer at ${assignment.institutionName}`}{assignment.note ? ` · “${assignment.note}”` : ''}</small>
          </div>
          <span className={`pilot-chip ${assignment.status === 'DONE' ? 'green' : 'amber'}`}>{assignment.status === 'DONE' ? 'Done' : 'To do'}</span>
        </div>)}
      </div> : null}
      {actions.sessions.length ? <div className="pilot-list" aria-label="Group sessions">
        {actions.sessions.map((session) => <div key={session.id} className="pilot-list-row">
          <span className="pilot-tile green"><Users size={16} /></span>
          <div className="grow">
            <strong>{session.title}</strong>
            <small>{`${when(session.scheduledStartAt)} – ${when(session.scheduledEndAt)} · ${session.institutionName}`}</small>
            <small>{session.content.length ? `Covers: ${session.content.map((item) => item.title).join(', ')}` : 'Covers: NA'}</small>
          </div>
          <span className="pilot-chip green">Group session</span>
        </div>)}
      </div> : null}
      {open || pending ? <div style={{ marginTop: 10 }}>
        {pending ? null : <p style={muted}>Your plan brings assigned work up next, after anything due for review.</p>}
        <button type="button" className="pilot-btn small" disabled={busy} onClick={onStart}>Start my lecturer’s work</button>
      </div> : null}
    </>}
  </section>;
}
