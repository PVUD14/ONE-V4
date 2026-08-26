import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.js';

describe('runtime configuration', () => {
  it('defaults development host and port while requiring DATABASE_URL', () => {
    const config = loadRuntimeConfig({
      DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev',
    });

    expect(config).toMatchObject({
      nodeEnv: 'development',
      apiHost: '127.0.0.1',
      apiPort: 3000,
      apiCorsOrigin: 'http://127.0.0.1:5173',
      databaseUrl: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev',
    });
  });

  it('refuses a file store with no malware scanner', () => {
    const base = { DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev' };
    // Storage without a scanner would accept files nobody has checked.
    expect(() => loadRuntimeConfig({ ...base, FILE_STORAGE_ROOT: '/srv/one/files' }))
      .toThrow('must be scanned');
    expect(() => loadRuntimeConfig({ ...base, FILE_STORAGE_ROOT: 'relative/path', CLAMAV_SOCKET_PATH: '/var/run/clamav/clamd.ctl' }))
      .toThrow('absolute path');
    expect(() => loadRuntimeConfig({ ...base, FILE_STORAGE_ROOT: '/srv/one/files', CLAMAV_HOST: '127.0.0.1' }))
      .toThrow('CLAMAV_PORT is required');

    const configured = loadRuntimeConfig({ ...base, FILE_STORAGE_ROOT: '/srv/one/files', CLAMAV_SOCKET_PATH: '/var/run/clamav/clamd.ctl' });
    expect(configured.documents).toEqual({ storageRoot: '/srv/one/files', clamavSocketPath: '/var/run/clamav/clamd.ctl' });
  });

  it('validates the file encryption key and requires it for production storage', () => {
    const base = {
      DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev',
      FILE_STORAGE_ROOT: '/srv/one/files',
      CLAMAV_SOCKET_PATH: '/var/run/clamav/clamd.ctl',
    };
    const validKey = Buffer.alloc(32, 7).toString('base64');

    expect(() => loadRuntimeConfig({ ...base, FILE_ENCRYPTION_KEY: 'not-32-bytes' }))
      .toThrow('exactly 32 bytes');
    expect(loadRuntimeConfig({ ...base, FILE_ENCRYPTION_KEY: validKey }).documents.fileEncryptionKey)
      .toBe(validKey);
    // Production must not store student documents in plaintext.
    expect(() => loadRuntimeConfig({
      ...base,
      NODE_ENV: 'production',
      API_HOST: '127.0.0.1',
      API_PORT: '7310',
      COGNITO_USER_POOL_ID: 'ap-south-1_test',
      COGNITO_CLIENT_ID: 'client',
      AUTOMATION_SIGNING_SECRET: 'x'.repeat(48),
    })).toThrow('FILE_ENCRYPTION_KEY is required in production');
  });

  it('leaves documents unconfigured when no storage root is set', () => {
    const config = loadRuntimeConfig({ DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev' });
    expect(config.documents).toEqual({});
  });

  it('fails production startup without Cognito configuration', () => {
    expect(() => loadRuntimeConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev',
    })).toThrow('COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required in production');
  });

  it('requires a strong automation callback secret in production', () => {
    expect(() => loadRuntimeConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev',
      COGNITO_USER_POOL_ID: 'ap-south-1_example',
      COGNITO_CLIENT_ID: 'client-id',
    })).toThrow('AUTOMATION_SIGNING_SECRET is required in production');
  });

  it('rejects unsafe or malformed runtime inputs', () => {
    expect(() => loadRuntimeConfig({ DATABASE_URL: 'https://example.test/db' }))
      .toThrow('DATABASE_URL must use the postgres or postgresql protocol');
    expect(() => loadRuntimeConfig({
      API_HOST: '',
      DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev',
    })).toThrow('API_HOST is required');
    expect(() => loadRuntimeConfig({
      API_PORT: '70000',
      DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev',
    })).toThrow('API_PORT must be between 1 and 65535');
    expect(() => loadRuntimeConfig({
      AUTOMATION_SIGNING_SECRET: 'too-short',
      DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev',
    })).toThrow('AUTOMATION_SIGNING_SECRET must contain at least 32 bytes');
  });
});
