import { describe, expect, it } from 'vitest';
import { resolveApiBaseUrl } from './api.js';

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
});
