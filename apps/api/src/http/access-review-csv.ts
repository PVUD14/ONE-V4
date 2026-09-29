/**
 * The access review evidence file (OPS-15).
 *
 * One row per item, in snapshot order, each carrying its campaign's columns, built from
 * the same DTOs the API returns so the file and the screen cannot disagree. Written by the
 * house CSV writer (every cell quoted, formula-leading text prefixed with `'`). It holds
 * staff and faculty email addresses, roles and capability names — no student data.
 */
import { toCsv, type CsvValue } from './institution-export-csv.js';

export interface AccessReviewCsvCampaign {
  readonly id: string;
  readonly periodLabel: string;
  readonly state: string;
  readonly openedBy: { readonly email: string };
  readonly openedAt: string;
  readonly dueAt: string;
  readonly openReasonCode: string;
  readonly closedBy: { readonly email: string } | null;
  readonly closedAt: string | null;
  readonly closeReasonCode: string | null;
}

export interface AccessReviewCsvItem {
  readonly id: string;
  readonly position: number;
  readonly kind: string;
  readonly subject: { readonly email: string };
  readonly organizationName: string;
  readonly organizationKind: string;
  readonly role: string;
  readonly membershipState: string;
  readonly capability: string | null;
  readonly capabilities: readonly string[];
  readonly highRisk: boolean;
  readonly grantedBy: { readonly email: string } | null;
  readonly grantedAt: string;
  readonly grantReasonCode: string | null;
  readonly decision: string | null;
  readonly decisionReasonCode: string | null;
  readonly decisionNote: string | null;
  readonly decidedBy: { readonly email: string } | null;
  readonly decidedAt: string | null;
  readonly mode: string | null;
  readonly revocationOutcome: string | null;
}

export const accessReviewCsvHeader = [
  'campaign_id', 'period', 'campaign_state', 'opened_by', 'opened_at', 'due_at', 'open_reason', 'closed_by', 'closed_at', 'close_reason',
  'position', 'item_id', 'item_kind', 'subject_email', 'organization', 'organization_kind', 'role', 'membership_state_at_snapshot',
  'capability', 'capabilities', 'high_risk', 'granted_by', 'granted_at', 'grant_reason', 'decision', 'decision_reason', 'decision_note',
  'decided_by', 'decided_at', 'mode', 'revocation_outcome',
] as const;

/** The row values for one item, before CSV quoting. Missing values are empty; an unknown grantor is NA. */
export function accessReviewCsvRow(campaign: AccessReviewCsvCampaign, item: AccessReviewCsvItem): readonly CsvValue[] {
  return [
    campaign.id, campaign.periodLabel, campaign.state, campaign.openedBy.email, campaign.openedAt, campaign.dueAt, campaign.openReasonCode,
    campaign.closedBy?.email ?? '', campaign.closedAt ?? '', campaign.closeReasonCode ?? '',
    item.position, item.id, item.kind, item.subject.email, item.organizationName, item.organizationKind, item.role, item.membershipState,
    item.capability ?? '', item.capabilities.join(' '), item.highRisk, item.grantedBy?.email ?? 'NA', item.grantedAt, item.grantReasonCode ?? '',
    item.decision ?? '', item.decisionReasonCode ?? '', item.decisionNote ?? '', item.decidedBy?.email ?? '', item.decidedAt ?? '',
    item.mode ?? '', item.revocationOutcome ?? '',
  ];
}

export function accessReviewCsv(campaign: AccessReviewCsvCampaign, items: readonly AccessReviewCsvItem[]): string {
  return toCsv(accessReviewCsvHeader, items.map((item) => accessReviewCsvRow(campaign, item)));
}

export function accessReviewCsvFilename(campaign: AccessReviewCsvCampaign): string {
  return `one-access-review-${campaign.periodLabel.toLowerCase()}-${campaign.openedAt.slice(0, 10)}.csv`;
}
