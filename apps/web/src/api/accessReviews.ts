/**
 * ONE · API client — quarterly internal access reviews (OPS-15).
 *
 * Operations Security: open a campaign (a frozen snapshot of every standing internal
 * access), decide KEEP or REVOKE on each item with a reason code, close it once every item
 * is decided, and download it as CSV evidence. The server decides everything — who may
 * decide which item, the solo safeguard, and whether a removal took effect.
 */
import { ApiRequestError, apiBaseUrl } from './core.js';
import { requestJson } from './http.js';

export type AccessReviewDecision = 'KEEP' | 'REVOKE';
export type AccessReviewScheduleStatus = 'NEVER_REVIEWED' | 'REVIEW_OVERDUE' | 'CAMPAIGN_OVERDUE' | 'IN_PROGRESS' | 'CURRENT';

export interface AccessReviewCampaignDto {
  readonly id: string;
  readonly periodLabel: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly openedBy: { readonly email: string };
  readonly openedAt: string;
  readonly dueAt: string;
  readonly openReasonCode: string;
  readonly openNote: string | null;
  readonly itemCount: number;
  readonly closedBy: { readonly email: string } | null;
  readonly closedAt: string | null;
  readonly closeReasonCode: string | null;
  readonly counts: { readonly decided: number; readonly kept: number; readonly revoked: number; readonly solo: number; readonly highRisk: number };
}

export interface AccessReviewItemDto {
  readonly id: string;
  readonly position: number;
  readonly kind: 'PLATFORM_ROLE' | 'CAPABILITY_GRANT';
  readonly subject: { readonly email: string; readonly isSelf: boolean };
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
  readonly decision: AccessReviewDecision | null;
  readonly decisionReasonCode: string | null;
  readonly decisionNote: string | null;
  readonly decidedBy: { readonly email: string } | null;
  readonly decidedAt: string | null;
  readonly mode: 'DUAL' | 'SOLO' | null;
  readonly revocationOutcome: 'APPLIED' | 'ALREADY_ENDED' | null;
  readonly canKeep: boolean;
  readonly canRevoke: boolean;
  readonly keepMode: 'DUAL' | 'SOLO' | null;
  readonly refusal: string | null;
  readonly coolingOffEndsAt: string | null;
}

export interface AccessReviewOverviewDto {
  readonly summary: {
    readonly reviewerCount: number;
    readonly soloSafeguardActive: boolean;
    readonly open: AccessReviewCampaignDto | null;
    readonly lastClosed: AccessReviewCampaignDto | null;
    readonly status: AccessReviewScheduleStatus;
    readonly overdue: boolean;
    readonly nextDueAt: string | null;
  };
  readonly campaigns: readonly AccessReviewCampaignDto[];
  readonly nextCursor: string | null;
  readonly policy: {
    readonly reasons: {
      readonly open: readonly string[];
      readonly decision: Readonly<Record<AccessReviewDecision, readonly string[]>>;
      readonly close: readonly string[];
      readonly export: readonly string[];
    };
    readonly soloCoolingOffMinutes: number;
    readonly campaignWindowDays: number;
    readonly cadenceMonths: number;
  };
  readonly correlationId: string;
}

const base = '/api/v1/operations/access-reviews';
const options = (token: string, signal?: AbortSignal) => ({ token, ...(signal ? { signal } : {}) });

export function getAccessReviewOverview(token: string, signal?: AbortSignal): Promise<AccessReviewOverviewDto> {
  return requestJson(base, options(token, signal));
}

export function openAccessReview(token: string, body: { readonly reasonCode: string; readonly note?: string }): Promise<{ readonly campaign: AccessReviewCampaignDto; readonly correlationId: string }> {
  return requestJson(base, { token, method: 'POST', body });
}

export function listAccessReviewItems(token: string, campaignId: string, query: { readonly cursor?: string; readonly filter?: 'UNDECIDED' | 'DECIDED' } = {}, signal?: AbortSignal): Promise<{
  readonly campaign: AccessReviewCampaignDto; readonly items: readonly AccessReviewItemDto[]; readonly nextCursor: string | null; readonly correlationId: string;
}> {
  const params = new URLSearchParams({ limit: '200' });
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.filter) params.set('filter', query.filter);
  return requestJson(`${base}/${encodeURIComponent(campaignId)}/items?${params.toString()}`, options(token, signal));
}

export function decideAccessReviewItem(token: string, campaignId: string, itemId: string, body: {
  readonly decision: AccessReviewDecision; readonly reasonCode: string; readonly note?: string;
}): Promise<{ readonly item: AccessReviewItemDto; readonly campaign: AccessReviewCampaignDto; readonly correlationId: string }> {
  return requestJson(`${base}/${encodeURIComponent(campaignId)}/items/${encodeURIComponent(itemId)}/decision`, { token, method: 'POST', body });
}

export function closeAccessReview(token: string, campaignId: string, reasonCode: string): Promise<{ readonly campaign: AccessReviewCampaignDto; readonly correlationId: string }> {
  return requestJson(`${base}/${encodeURIComponent(campaignId)}/close`, { token, method: 'POST', body: { reasonCode } });
}

/**
 * Download a campaign as CSV evidence. The route is authenticated like every other, so the
 * file is fetched with the token and handed to the browser rather than linked. Errors carry
 * only the code and reference.
 */
export async function downloadAccessReviewCsv(token: string, campaignId: string, reasonCode: string): Promise<{ readonly filename: string; readonly csv: string }> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${apiBaseUrl}${base}/${encodeURIComponent(campaignId)}/export`, {
    method: 'POST',
    headers: { Accept: 'text/csv', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Correlation-Id': correlationId },
    body: JSON.stringify({ reasonCode }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { readonly error?: { readonly code?: string; readonly correlationId?: string } } | null;
    throw new ApiRequestError({
      status: response.status,
      correlationId: failure?.error?.correlationId ?? correlationId,
      ...(failure?.error?.code ? { code: failure.error.code } : {}),
    });
  }
  const disposition = response.headers?.get('content-disposition') ?? '';
  const filename = /filename="([A-Za-z0-9._-]+)"/.exec(disposition)?.[1] ?? 'one-access-review.csv';
  return { filename, csv: await response.text() };
}
