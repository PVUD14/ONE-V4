import { afterEach, describe, expect, it, vi } from 'vitest';
import { inviteInstitutionStaff, resolveApiBaseUrl, updateInstitutionStudent } from './api.js';

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

  it('calls institution staff invitation and student update APIs with bearer auth only', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    await inviteInstitutionStaff('uat-token', 'institution-1', 'faculty@example.test', 'FACULTY_LECTURER');
    await updateInstitutionStudent('uat-token', 'institution-1', 'student-profile-1', { fullName: 'Aanya Updated' });

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
});
