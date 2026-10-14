/**
 * Placement status of one student, as the college may know it (INST-09).
 *
 * The placement office's first question is "where is each student in their placement
 * journey?". The answer may only come from applications the student has chosen to share
 * with the college (ADR-019), so this function is given exactly those — already filtered
 * for consent, relationship and scope by the caller — and never anything else.
 *
 * Why a student with nothing shared is NOT_SHARED and never NOT_APPLIED: the college
 * cannot tell "has not applied" from "applied and chose not to share". Reporting the
 * first would disclose the second — and would count a private student as unplaced, which
 * INST-12 forbids. So the plan's "Not applied" is only ever shown as "Nothing shared".
 *
 * Why student-declared external applications do not move the status: they are
 * unverified declarations (0019: never verified hires or conversion inputs). They are
 * counted beside the status, never folded into it.
 *
 * Offers are read by response state only; an employer's unsent DRAFT offer must already
 * have been dropped by the caller (INST-07) and is ignored here if one slips through.
 */

export const placementStatuses = ['NOT_SHARED', 'APPLIED', 'IN_PROCESS', 'OFFER', 'ACCEPTED'] as const;
export type PlacementStatus = typeof placementStatuses[number];

/** One shared native application: its stage and the latest sent offer's response state, if any. */
export interface SharedApplicationStage {
  readonly state: string;
  readonly offerState: string | null;
}

const inProcessStages = new Set(['SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW']);
const rank: Readonly<Record<PlacementStatus, number>> = { NOT_SHARED: 0, APPLIED: 1, IN_PROCESS: 2, OFFER: 3, ACCEPTED: 4 };

/** The status one shared application supports on its own. */
export function applicationPlacementStatus(application: SharedApplicationStage): PlacementStatus {
  const offer = application.offerState === 'DRAFT' ? null : application.offerState;
  if (offer === 'ACCEPTED' || application.state === 'HIRED') return 'ACCEPTED';
  if (offer === 'EXTENDED') return 'OFFER';
  // The employer moved the application to OFFER but has not sent one yet (or its only offer
  // is an unsent draft): the stage itself is disclosed, so it reads as an offer stage. An
  // offer that was declined, withdrawn or expired leaves the student where they started.
  if (application.state === 'OFFER' && offer === null) return 'OFFER';
  if (inProcessStages.has(application.state)) return 'IN_PROCESS';
  return 'APPLIED';
}

/** The furthest status any of the student's shared applications supports; NOT_SHARED for none. */
export function studentPlacementStatus(applications: readonly SharedApplicationStage[]): PlacementStatus {
  let status: PlacementStatus = 'NOT_SHARED';
  for (const application of applications) {
    const next = applicationPlacementStatus(application);
    if (rank[next] > rank[status]) status = next;
  }
  return status;
}
