/**
 * ONE · API client — restricted counselling notes (INST-11, ADR-036).
 *
 * Its own file because the read rule is not the unit scope every other institution client
 * assumes: the server returns only the notes this caller may read (author, owner or admin, or a
 * case participant), and never says whether others exist. Nothing here filters for security.
 */
import { requestJson } from './http.js';

export interface CounsellingCaseDto {
  readonly studentUserId: string; readonly studentName: string; readonly notes: number;
  readonly lastNoteAt: string | null; readonly participant: boolean;
}
export interface CounsellingCasesDto {
  readonly cases: readonly CounsellingCaseDto[];
  /** Students the caller may write a first note about (their write scope). */
  readonly students: readonly { readonly id: string; readonly name: string }[];
  readonly canManageParticipants: boolean;
}
export interface CounsellingNoteDto {
  readonly id: string; readonly title: string; readonly note: string; readonly visibility: 'STAFF_ONLY' | 'SUBJECT_VISIBLE';
  readonly version: number; readonly createdAt: string; readonly authorName: string; readonly authorRole: string;
  readonly writtenByYou: boolean; readonly canChangeVisibility: boolean; readonly canErase: boolean;
}
export interface CounsellingParticipantDto {
  readonly membershipId: string; readonly name: string; readonly role: string; readonly addedAt?: string; readonly reasonCode?: string;
}
export interface CounsellingNotesDto {
  readonly student: { readonly id: string; readonly name: string };
  readonly notes: readonly CounsellingNoteDto[];
  readonly nextCursor: string | null;
  readonly participants: readonly CounsellingParticipantDto[];
  readonly eligibleStaff: readonly CounsellingParticipantDto[];
  readonly canWrite: boolean;
  readonly canManageParticipants: boolean;
}
export interface SharedCounsellingNoteDto {
  readonly id: string; readonly title: string; readonly note: string; readonly createdAt: string; readonly authorRole: string;
}

const base = (institutionId: string) => `/api/v1/institutions/${encodeURIComponent(institutionId)}`;
const student = (institutionId: string, studentUserId: string) => `${base(institutionId)}/students/${encodeURIComponent(studentUserId)}`;
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});

export function listCounsellingCases(token: string, institutionId: string, signal?: AbortSignal): Promise<CounsellingCasesDto> {
  return requestJson(`${base(institutionId)}/counselling-cases`, { token, ...signalOf(signal) });
}

export function listCounsellingNotes(token: string, institutionId: string, studentUserId: string, signal?: AbortSignal, cursor?: string | null): Promise<CounsellingNotesDto> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return requestJson(`${student(institutionId, studentUserId)}/counselling-notes${query}`, { token, ...signalOf(signal) });
}

export function writeCounsellingNote(token: string, institutionId: string, studentUserId: string,
  body: { readonly title: string; readonly note: string; readonly shareWithStudent: boolean }): Promise<{ readonly id: string; readonly visibility: string; readonly version: number }> {
  return requestJson(`${student(institutionId, studentUserId)}/counselling-notes`, { token, method: 'POST', body });
}

export function setCounsellingNoteVisibility(token: string, institutionId: string, noteId: string,
  body: { readonly visibility: 'STAFF_ONLY' | 'SUBJECT_VISIBLE'; readonly version: number }): Promise<{ readonly id: string; readonly visibility: string; readonly version: number }> {
  return requestJson(`${base(institutionId)}/counselling-notes/${encodeURIComponent(noteId)}/visibility`, { token, method: 'POST', body });
}

export function eraseCounsellingNote(token: string, institutionId: string, noteId: string, reasonCode: string): Promise<{ readonly id: string; readonly erased: true }> {
  return requestJson(`${base(institutionId)}/counselling-notes/${encodeURIComponent(noteId)}/erase`, { token, method: 'POST', body: { reasonCode } });
}

export function addCounsellingParticipant(token: string, institutionId: string, studentUserId: string, membershipId: string, reasonCode: string): Promise<{ readonly id: string }> {
  return requestJson(`${student(institutionId, studentUserId)}/counselling-case/participants`, { token, method: 'POST', body: { membershipId, reasonCode } });
}

export function removeCounsellingParticipant(token: string, institutionId: string, studentUserId: string, membershipId: string, reasonCode: string): Promise<{ readonly removed: true }> {
  return requestJson(`${student(institutionId, studentUserId)}/counselling-case/participants/${encodeURIComponent(membershipId)}/remove`, { token, method: 'POST', body: { reasonCode } });
}

/** The notes the student's college chose to share with them. */
export function listMySharedCounsellingNotes(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly notes: readonly SharedCounsellingNoteDto[] }> {
  return requestJson(`/api/v1/students/me/counselling-notes?institutionId=${encodeURIComponent(institutionId)}`, { token, ...signalOf(signal) });
}
