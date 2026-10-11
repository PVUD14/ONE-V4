/**
 * ONE · Role portal — Institution — Placement status vocabulary (INST-09)
 *
 * The labels, chip and roster hook for a student's placement status, split from
 * institutionPlacement.tsx so the roster in institution.tsx can show the status without
 * the two page modules importing each other. "Nothing shared" is never "not applied":
 * the college cannot tell a student who has not applied from one who chose not to share.
 */
import { useEffect, useState } from 'react';
import { listPlacementStatus } from '../api.js';
import type { PlacementStatus, PlacementStatusRowDto } from '../api.js';

export const placementStatusLabels: Readonly<Record<PlacementStatus, string>> = {
  NOT_SHARED: 'Nothing shared', APPLIED: 'Applied', IN_PROCESS: 'In process', OFFER: 'Offer', ACCEPTED: 'Accepted',
};
const placementStatusTones: Readonly<Record<PlacementStatus, string>> = {
  NOT_SHARED: 'slate', APPLIED: 'blue', IN_PROCESS: 'indigo', OFFER: 'amber', ACCEPTED: 'green',
};

/** A status the vocabulary does not know draws no chip (never "NA"). */
export function PlacementStatusChip({ status }: { readonly status: PlacementStatus }): React.ReactElement | null {
  const label = placementStatusLabels[status];
  if (!label) return null;
  return <span className={`pilot-chip ${placementStatusTones[status] ?? 'slate'}`}>{label}</span>;
}

/**
 * Placement status for a whole roster, keyed by student: every audited page, up to a cap.
 * Null while loading; an empty map with `failed` when the read is refused, so the roster
 * shows a plain word rather than an error in a column.
 */
export function useRosterPlacementStatus(token: string, institutionId: string, refresh: number): { readonly byStudent: ReadonlyMap<string, PlacementStatusRowDto> | null; readonly failed: boolean } {
  const [state, setState] = useState<{ readonly byStudent: ReadonlyMap<string, PlacementStatusRowDto> | null; readonly failed: boolean }>({ byStudent: null, failed: false });
  useEffect(() => {
    const controller = new AbortController();
    setState({ byStudent: null, failed: false });
    void (async () => {
      const found = new Map<string, PlacementStatusRowDto>();
      let cursor: string | null = null;
      for (let page = 0; page < 25; page += 1) {
        const result: { readonly students: readonly PlacementStatusRowDto[]; readonly nextCursor: string | null } =
          await listPlacementStatus(token, institutionId, { cursor, limit: 200 }, controller.signal);
        for (const row of result.students ?? []) found.set(row.studentUserId, row);
        cursor = result.nextCursor ?? null;
        if (!cursor) break;
      }
      if (!controller.signal.aborted) setState({ byStudent: found, failed: false });
    })().catch(() => { if (!controller.signal.aborted) setState({ byStudent: new Map(), failed: true }); });
    return () => controller.abort();
  }, [token, institutionId, refresh]);
  return state;
}
