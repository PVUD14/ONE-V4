/**
 * ONE · API client — Stream C — Institution
 *
 * Academic structure, the student roster, staff invitations and roster import.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { requestJson } from './http.js';

export interface InstitutionUnitDto {
  readonly id: string; readonly institutionId: string; readonly kind: string; readonly name: string; readonly parentUnitId?: string | null;
}

export interface InstitutionStaffDto {
  readonly invitations: readonly {
    readonly id: string; readonly email: string; readonly role: string; readonly state: string;
    readonly createdAt: string; readonly expiresAt: string; readonly acceptedAt?: string | null; readonly revokedAt?: string | null;
    readonly delivery?: { readonly commandId: string; readonly state: string; readonly providerKind?: string | null; readonly providerReference?: string | null; readonly outcome?: string | null } | null;
  }[];
  readonly memberships: readonly {
    readonly id: string; readonly userId: string; readonly email: string; readonly role: string; readonly state: string; readonly createdAt: string; readonly updatedAt: string;
  }[];
  readonly unavailableActions: readonly string[];
}

export interface InstitutionStudentDto {
  readonly id: string; readonly institutionId: string; readonly institutionStudentId: string; readonly fullName: string; readonly email: string; readonly status: string;
  readonly relationship?: { readonly id: string; readonly state: string; readonly effectiveFrom: string; readonly effectiveTo?: string | null } | null;
  readonly units?: Record<string, string | null | undefined>;
}

export interface InstitutionStudentCreateRequest {
  readonly institutionStudentId: string;
  readonly fullName: string;
  readonly email: string;
  readonly departmentUnitId?: string;
  readonly programUnitId?: string | null;
  readonly batchUnitId?: string | null;
  readonly sectionUnitId?: string | null;
  readonly academicStartDate?: string;
  readonly expectedGraduationDate?: string;
}

export interface InstitutionStudentUpdateRequest {
  readonly fullName?: string;
  readonly departmentUnitId?: string | null;
  readonly programUnitId?: string | null;
  readonly batchUnitId?: string | null;
  readonly sectionUnitId?: string | null;
  readonly academicStartDate?: string | null;
  readonly expectedGraduationDate?: string | null;
}

export interface InstitutionUnitCreateRequest {
  readonly kind: string;
  readonly name: string;
  readonly parentUnitId?: string;
}

export interface InstitutionUnitUpdateRequest {
  readonly name: string;
}

export interface InstitutionStaffInvitationRequest {
  readonly email: string;
  readonly role: string;
}

export interface RosterImportPreviewDto {
  readonly id: string; readonly rowCount: number; readonly acceptedCount: number; readonly warningCount: number; readonly rejectedCount: number;
  readonly rows: readonly { readonly rowNumber: number; readonly institutionStudentId: string; readonly fullName: string; readonly email: string; readonly state: string; readonly issues: readonly string[]; readonly departmentUnitId?: string | null; readonly programUnitId?: string | null; readonly batchUnitId?: string | null; readonly sectionUnitId?: string | null }[];
}

export function listInstitutionUnits(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly units: readonly InstitutionUnitDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units`, { token, ...(signal ? { signal } : {}) });
}

export function createInstitutionUnit(token: string, institutionId: string, body: InstitutionUnitCreateRequest): Promise<{ readonly unit: InstitutionUnitDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units`, { token, method: 'POST', body });
}

export function updateInstitutionUnit(token: string, institutionId: string, unitId: string, body: InstitutionUnitUpdateRequest): Promise<{ readonly unit: InstitutionUnitDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units/${encodeURIComponent(unitId)}`, { token, method: 'PATCH', body });
}

export function listInstitutionStaff(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly staff: InstitutionStaffDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/staff-role-assignments`, { token, ...(signal ? { signal } : {}) });
}

export function listInstitutionStudents(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly students: readonly InstitutionStudentDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students`, { token, ...(signal ? { signal } : {}) });
}

export function addInstitutionStudent(token: string, institutionId: string, body: InstitutionStudentCreateRequest): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students`, { token, method: 'POST', body });
}

export function updateInstitutionStudent(token: string, institutionId: string, studentProfileId: string, body: InstitutionStudentUpdateRequest): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students/${encodeURIComponent(studentProfileId)}`, { token, method: 'PATCH', body });
}

export function endInstitutionStudentRelationship(token: string, institutionId: string, studentProfileId: string, state: string, effectiveTo?: string): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students/${encodeURIComponent(studentProfileId)}/relationship`, { token, method: 'POST', body: { state, ...(effectiveTo ? { effectiveTo } : {}) } });
}

export function inviteInstitutionStaff(token: string, institutionId: string, email: string, role: string): Promise<Record<string, unknown>> {
  const body: InstitutionStaffInvitationRequest = { email, role };
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/staff-role-assignments`, { token, method: 'POST', body });
}

export function previewStudentRosterImport(token: string, institutionId: string, filename: string, csv: string): Promise<{ readonly import: RosterImportPreviewDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/student-imports`, { token, method: 'POST', body: { filename, csv } });
}

export function commitStudentRosterImport(token: string, institutionId: string, importId: string): Promise<{ readonly import: { readonly id: string; readonly committedCount: number } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/student-imports/${encodeURIComponent(importId)}/commit`, { token, method: 'POST' });
}

// --- Hiring: opportunities, applications, interviews, offers -----------------
