import { afterEach, describe, expect, it, vi } from 'vitest';
import { addInstitutionStudent, inviteInstitutionStaff, resolveApiBaseUrl, updateInstitutionStudent } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API base URL policy', () => {
  it('uses same-origin requests when production configuration is omitted', () => {
    expect(resolveApiBaseUrl(undefined, false)).toBe('');
  });

  it('keeps the explicit loopback fallback development-only', () => {
    expect(resolveApiBaseUrl(undefined, true)).toBe('http://127.0.0.1:3000');
    expect(() => resolveApiBaseUrl('http://127.0.0.1:3000', false)).toThrow('HTTPS');
  });

  it('accepts only a credential-free HTTPS origin in production', () => {
    expect(resolveApiBaseUrl('https://api.planthepath.example/', false)).toBe('https://api.planthepath.example');
    expect(() => resolveApiBaseUrl('https://user:secret@api.planthepath.example/', false)).toThrow('trusted origin');
    expect(() => resolveApiBaseUrl('https://api.planthepath.example/v1', false)).toThrow('trusted origin');
  });

  it('serializes institution mutations as explicit flat request contracts with bearer auth only', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    await addInstitutionStudent('uat-token', 'institution-1', {
      institutionStudentId: 'UAT-P2A-DIRECT-002',
      fullName: 'Phase2A Direct Student',
      email: 'phase2a.direct.002@uat.example.test',
      departmentUnitId: 'department-1',
      academicStartDate: '2026-08-22',
      expectedGraduationDate: '2028-08-22',
    });
    await inviteInstitutionStaff('uat-token', 'institution-1', 'faculty@example.test', 'FACULTY_LECTURER');
    await updateInstitutionStudent('uat-token', 'institution-1', 'student-profile-1', { fullName: 'Aanya Updated' });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/institutions/institution-1/students'), expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer uat-token', 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        institutionStudentId: 'UAT-P2A-DIRECT-002',
        fullName: 'Phase2A Direct Student',
        email: 'phase2a.direct.002@uat.example.test',
        departmentUnitId: 'department-1',
        academicStartDate: '2026-08-22',
        expectedGraduationDate: '2028-08-22',
      }),
    }));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/institutions/institution-1/staff-role-assignments'), expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer uat-token', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: 'faculty@example.test', role: 'FACULTY_LECTURER' }),
    }));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/institutions/institution-1/students/student-profile-1'), expect.objectContaining({
      method: 'PATCH',
      headers: expect.objectContaining({ Authorization: 'Bearer uat-token', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ fullName: 'Aanya Updated' }),
    }));
  });

  it('parses safe API error codes from the backend error envelope', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      headers: { get: () => 'ctx-header' },
      json: async () => ({ error: { code: 'INSTITUTION_STUDENT_ID_ALREADY_EXISTS', correlationId: 'ctx-body', field: 'institutionStudentId' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(addInstitutionStudent('uat-token', 'institution-1', {
      institutionStudentId: 'UAT-P2A-DIRECT-002',
      fullName: 'Phase2A Direct Student',
      email: 'phase2a.direct.002@uat.example.test',
    })).rejects.toMatchObject({
      status: 409,
      code: 'INSTITUTION_STUDENT_ID_ALREADY_EXISTS',
      correlationId: 'ctx-body',
      field: 'institutionStudentId',
    });
  });
});
