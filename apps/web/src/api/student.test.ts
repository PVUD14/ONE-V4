/**
 * ONE · Stream D — Learner
 * Owner: Santhosh · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeStudentStaffAction, listStudentStaffActions } from './student.js';
import { ApiRequestError } from './core.js';

afterEach(() => vi.unstubAllGlobals());

describe('student support read and completion transport', () => {
  it('authenticates the scoped read, encodes the institution and propagates cancellation', async () => {
    const payload = { actions: [] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    expect(await listStudentStaffActions('student-token', 'institution & other=value', signal)).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/api/v1/students/me/staff-actions?institutionId=institution%20%26%20other%3Dvalue'), {
      method: 'GET', signal, headers: { Accept: 'application/json', Authorization: 'Bearer student-token', 'X-Correlation-Id': expect.any(String) },
    });
  });

  it('posts only version and responseNote to the narrow authenticated completion route', async () => {
    const payload = { id: 'action', state: 'COMPLETED', version: 5, responseNote: 'Done', resolvedAt: '2030-04-02T10:00:00Z' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const body = { version: 4, responseNote: 'Done', state: 'APPROVED', institutionId: 'other', studentUserId: 'other' };
    expect(await completeStudentStaffAction('student-token', 'action/other', body, signal)).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/api/v1/students/me/staff-actions/action%2Fother/complete'), {
      method: 'POST', signal, headers: { Accept: 'application/json', Authorization: 'Bearer student-token',
        'Content-Type': 'application/json', 'X-Correlation-Id': expect.any(String) },
      body: JSON.stringify({ version: 4, responseNote: 'Done' }),
    });
  });

  it.each([401, 403, 409, 500])('preserves the shared API error convention for HTTP %s without retrying a write', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status, headers: new Headers(),
      json: async () => ({ error: { code: 'REQUEST_REJECTED', correlationId: 'test-correlation', message: 'private upstream detail' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const result = completeStudentStaffAction('student-token', 'action', { version: 1, responseNote: '' });
    await expect(result).rejects.toBeInstanceOf(ApiRequestError);
    await expect(result).rejects.toMatchObject({ status, code: 'REQUEST_REJECTED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
