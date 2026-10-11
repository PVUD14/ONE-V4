/**
 * The sandbox seed and reset must never run against anything but the sandbox database
 * (ADR-046). These pin every rule of the guard, including the production names.
 */
import { describe, expect, it } from 'vitest';
import { assertSandboxTarget, SandboxGuardError } from '../src/sandbox-guard.js';

const sandboxUrl = 'postgresql://one_sandbox:pw@postgres-demo:5432/one_sandbox';

describe('assertSandboxTarget', () => {
  it('accepts the Compose pack sandbox database with ONE_SANDBOX=true', () => {
    expect(assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: sandboxUrl })).toMatchObject({ databaseName: 'one_sandbox', host: 'postgres-demo' });
  });

  it('accepts a local sandbox database', () => {
    expect(assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: 'postgresql://u:p@127.0.0.1:55432/dev_sandbox' }).databaseName).toBe('dev_sandbox');
  });

  it('refuses without ONE_SANDBOX=true', () => {
    expect(() => assertSandboxTarget({ DATABASE_URL: sandboxUrl })).toThrow(/ONE_SANDBOX=true/);
    expect(() => assertSandboxTarget({ ONE_SANDBOX: '1', DATABASE_URL: sandboxUrl })).toThrow(SandboxGuardError);
  });

  it('refuses in production mode', () => {
    expect(() => assertSandboxTarget({ ONE_SANDBOX: 'true', NODE_ENV: 'production', DATABASE_URL: sandboxUrl })).toThrow(/production/);
  });

  it('refuses the production database, whatever the host', () => {
    expect(() => assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: 'postgresql://planthepath_uat:pw@postgres:5432/planthepath_uat' })).toThrow(/not a sandbox database/);
    expect(() => assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: 'postgresql://u:p@postgres-demo:5432/planthepath_uat' })).toThrow(/not a sandbox database/);
    expect(() => assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: 'postgresql://u:p@postgres-demo:5432/_sandbox' })).toThrow(/not a sandbox database/);
  });

  it('refuses a sandbox-named database on any other host', () => {
    expect(() => assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: 'postgresql://u:p@postgres:5432/one_sandbox' })).toThrow(/host "postgres"/);
    expect(() => assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: 'postgresql://u:p@db.example.com:5432/one_sandbox' })).toThrow(/host/);
  });

  it('refuses a missing or malformed URL without echoing it', () => {
    expect(() => assertSandboxTarget({ ONE_SANDBOX: 'true' })).toThrow(/DATABASE_URL is required/);
    expect(() => assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: 'mysql://u:secretpw@postgres-demo/one_sandbox' })).toThrow(/protocol/);
    try { assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: 'postgresql://u:secretpw@postgres:5432/one_sandbox' }); } catch (error) {
      expect((error as Error).message).not.toContain('secretpw');
    }
  });

  it('refuses a database name that could not be quoted safely', () => {
    expect(() => assertSandboxTarget({ ONE_SANDBOX: 'true', DATABASE_URL: 'postgresql://u:p@postgres-demo:5432/One%22x_sandbox' })).toThrow(/lower-case/);
  });
});
