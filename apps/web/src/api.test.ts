import { afterEach, describe, expect, it, vi } from 'vitest';
import { addInstitutionStudent, allowLoopbackApiFallback, inviteInstitutionStaff, resolveApiBaseUrl, updateInstitutionStudent } from './api.js';

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

  it('refuses the loopback fallback when the app is served from a public host', () => {
    // A production build that inherited NODE_ENV=development would otherwise point
    // every visitor's browser at their own machine.
    const original = window.location.hostname;
    try {
      Object.defineProperty(window, 'location', { value: { ...window.location, hostname: 'one.ai8ht.pro' }, writable: true, configurable: true });
      expect(allowLoopbackApiFallback()).toBe(false);
      Object.defineProperty(window, 'location', { value: { ...window.location, hostname: '127.0.0.1' }, writable: true, configurable: true });
      expect(allowLoopbackApiFallback()).toBe(import.meta.env.DEV);
    } finally {
      Object.defineProperty(window, 'location', { value: { ...window.location, hostname: original }, writable: true, configurable: true });
    }
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
