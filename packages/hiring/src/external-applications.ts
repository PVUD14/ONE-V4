/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
export const externalApplicationCap = 500;
export const externalApplicationStages = ['APPLIED', 'SCREENING', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'] as const;
export const externalApplicationSources = ['JOB_BOARD', 'COMPANY_SITE', 'REFERRAL'] as const;
export type ExternalApplicationFields = {
  companyName: string; roleTitle: string; sourceKind: typeof externalApplicationSources[number];
  appliedOn: string; applicationUrl: string | null; stage: typeof externalApplicationStages[number];
};
export class ExternalApplicationInputError extends Error {}
function invalid(): never { throw new ExternalApplicationInputError('Invalid external application input'); }
export function externalInputRecord(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) return invalid();
  return record;
}
export function externalRevision(record: Record<string, unknown>): number {
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision >= 2_147_483_647) return invalid();
  return record.revision;
}
export function externalFields(body: unknown, partial = false, today = new Date().toISOString().slice(0, 10)): Partial<ExternalApplicationFields> {
  const fields = ['companyName', 'roleTitle', 'sourceKind', 'appliedOn', 'applicationUrl', 'stage'];
  const record = externalInputRecord(body, [...fields, ...(partial ? ['revision'] : ['institutionVisibilityGranted'])]);
  if (partial && !fields.some((key) => key in record)) return invalid();
  const result: Partial<ExternalApplicationFields> = {};
  for (const key of ['companyName', 'roleTitle'] as const) {
    if (partial && !(key in record)) continue;
    const value = record[key];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /^[=+@-]/.test(value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
    result[key] = value.trim();
  }
  if (!partial || 'sourceKind' in record) {
    if (!externalApplicationSources.includes(record.sourceKind as never)) return invalid();
    result.sourceKind = record.sourceKind as ExternalApplicationFields['sourceKind'];
  }
  if (!partial || 'stage' in record) {
    const stage = record.stage === undefined && !partial ? 'APPLIED' : record.stage;
    if (!externalApplicationStages.includes(stage as never)) return invalid();
    result.stage = stage as ExternalApplicationFields['stage'];
  }
  if (!partial || 'appliedOn' in record) {
    const date = record.appliedOn;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '0001-01-01' || date > today) return invalid();
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return invalid();
    result.appliedOn = date;
  }
  if (!partial || 'applicationUrl' in record) {
    const value = record.applicationUrl;
    if (value == null || value === '') result.applicationUrl = null;
    else {
      if (typeof value !== 'string' || value.length > 2048 || /\s|[\u0000-\u001f\u007f]/.test(value) || !/^https:\/\//i.test(value)) return invalid();
      let parsed: URL;
      try { parsed = new URL(value); } catch { return invalid(); }
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || value.includes('\\')) return invalid();
      result.applicationUrl = parsed.href;
      if (result.applicationUrl.length > 2048) return invalid();
    }
  }
  if (!partial && record.institutionVisibilityGranted !== undefined && typeof record.institutionVisibilityGranted !== 'boolean') return invalid();
  return result;
}
