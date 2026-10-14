/**
 * The end of a student's time at a college, and what it leaves them (INST-10).
 *
 * Two rules live here so the API, the outbox consumer and the tests share one definition:
 * which relationship states a college may apply to a whole batch at year end, and which
 * make someone a *former student* — a person who has left their college and keeps their
 * ONE account, records and choices (decision 10.2 #12). Only the college's access to them
 * changes; that is `canonicalInstitutionRelationshipPolicy`, not this file.
 * Design: docs/architecture/institution-batch-lifecycle-design.md.
 */

/** States a year-end batch action may set. REVOKED is a per-student correction, never a cohort event. */
export const relationshipBatchStates = ['GRADUATED', 'TRANSFERRED', 'ENDED'] as const;
export type RelationshipBatchState = (typeof relationshipBatchStates)[number];

/**
 * A person whose relationship ended in one of these states has left the college and keeps the
 * student workspace. REVOKED is not among them: it is the college withdrawing a roster link it
 * made in error, and a workspace cannot rest on a link that was never valid.
 */
export const formerStudentRelationshipStates = ['GRADUATED', 'TRANSFERRED', 'ENDED'] as const;

export const currentStudentRelationshipStates = ['ACTIVE', 'VERIFIED'] as const;

/** Most students a single batch action may change; a larger unit is split by the college. */
export const relationshipBatchMaxStudents = 1_000;

export const relationshipReasonCodePattern = /^[A-Z0-9_:-]{3,64}$/;

export interface StudentRelationshipWindow {
  readonly state: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date | null;
}

export type StudentStanding = 'CURRENT' | 'FORMER' | 'NONE';

/**
 * Where a person stands as a student at `now`: CURRENT with an active relationship whose
 * window is open, FORMER when none is current but one ended in a former-student state,
 * otherwise NONE. A graduation dated in the future still reads FORMER — its state is terminal.
 */
export function studentStanding(relationships: readonly StudentRelationshipWindow[], now: Date): StudentStanding {
  const current = relationships.some((relationship) =>
    (currentStudentRelationshipStates as readonly string[]).includes(relationship.state)
    && relationship.effectiveFrom <= now
    && (!relationship.effectiveTo || relationship.effectiveTo > now));
  if (current) return 'CURRENT';
  return relationships.some((relationship) => (formerStudentRelationshipStates as readonly string[]).includes(relationship.state)) ? 'FORMER' : 'NONE';
}

const noticeDate = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

const stateWords: Readonly<Record<string, string>> = {
  GRADUATED: 'graduated',
  TRANSFERRED: 'transferred',
  ENDED: 'no longer enrolled',
  REVOKED: 'removed from the roster',
};

/**
 * The in-app notice a student receives when their college ends their relationship. Plain
 * words, no identifiers. The date is written in India time: ONE's colleges are Indian, and the
 * web screen sends the start of the chosen day in the admin's local time, which in UTC would
 * read as the day before.
 */
export function relationshipChangeNotice(input: { readonly institutionName: string; readonly state: string; readonly effectiveTo: Date }): { readonly title: string; readonly body: string } {
  const college = input.institutionName.trim() || 'Your college';
  const words = stateWords[input.state] ?? 'no longer enrolled';
  const date = noticeDate.format(input.effectiveTo);
  const title = `${college} recorded you as ${words}`.slice(0, 160);
  const keeps = input.state === 'REVOKED'
    ? 'Your ONE account and anything you added to it stay yours.'
    : 'Your ONE account, your records and your choices stay yours.';
  const body = [
    `From ${date}, ${college} records you as ${words}.`,
    keeps,
    `${college} now sees only what happened before that date.`,
    input.state === 'REVOKED' ? '' : 'You can still ask it to verify past results from Academic record.',
  ].filter(Boolean).join(' ').slice(0, 500);
  return { title, body };
}
