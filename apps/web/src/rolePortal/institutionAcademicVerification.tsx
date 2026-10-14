/**
 * Where institution staff reach academic verification (INST-04, plan Section 4.2).
 *
 * The queue already existed as a page but no route could render it for the people it was
 * built for. It now mounts behind existing labels only — no navigation item is added:
 *
 *   Faculty · "Academic Verification": the verification queue, with the free-form
 *     ACADEMIC_VERIFICATION staff-action list it used to show kept as the second tab.
 *   Institution admin · "Students" and department head · "Students": a verification
 *     section with the queue and the bulk results upload.
 *
 * The server scopes every row (INST-02); nothing here filters for security.
 */
import React, { useRef, useState } from 'react';
import { AcademicResultsUpload, AcademicVerificationPage } from '../academicVerificationPage.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { PilotTabs } from '../pilot/pilotOverlay.js';

/** Queue plus, for the roles the server lets upload, the bulk results upload. */
export function AcademicVerificationSection({ institutionId, canUpload }: {
  readonly institutionId: string; readonly canUpload: boolean;
}): React.ReactElement {
  return <section aria-label="Academic verification">
    <AcademicVerificationPage institutionId={institutionId} />
    {canUpload ? <div className="workspace-grid"><AcademicResultsUpload institutionId={institutionId} /></div> : null}
  </section>;
}

const facultyTabs = ['Verification queue', 'Staff actions'] as const;

/**
 * Faculty: the queue first, the existing staff-action list second. The tabs jump between
 * the two rather than hiding one: the staff-action list is where verification work was
 * recorded before this screen existed, and it stays in view on this route exactly as it
 * was (the dispatcher test for this label pins that).
 */
export function FacultyAcademicVerification({ institutionId, staffActions }: {
  readonly institutionId: string; readonly staffActions: React.ReactNode;
}): React.ReactElement {
  const [tab, setTab] = useState(0);
  const queueRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  function jump(index: number): void {
    setTab(index);
    (index === 0 ? queueRef : actionsRef).current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }
  return <StaffPilotWrap title="Academic Verification" subtitle="Confirm the results students ask you to verify, and keep the verification tasks you record.">
    <PilotTabs labels={facultyTabs} active={tab} onChange={jump} />
    <div ref={queueRef} id="verification-queue"><AcademicVerificationPage institutionId={institutionId} /></div>
    <div ref={actionsRef} id="verification-staff-actions">{staffActions}</div>
  </StaffPilotWrap>;
}
