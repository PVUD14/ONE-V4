/**
 * The lock on the sandbox seed and the nightly reset (ADR-046).
 *
 * demo.oneby8.com runs the real application over its own database of fictional sample
 * data. The scripts that fill and wipe that database are the most dangerous code in the
 * repository if pointed at the wrong place: the reset DROPS the database. So they refuse
 * to run unless every one of these holds, and there is no override:
 *
 *   1. ONE_SANDBOX=true is set explicitly;
 *   2. NODE_ENV is not "production";
 *   3. the database name ends in "_sandbox" (the Compose pack names it one_sandbox;
 *      production's is planthepath_uat);
 *   4. the host is the sandbox's own database container (postgres-demo) or this machine.
 *
 * The seed adds a fifth check against the live database before it writes anything:
 * every account already there must be a sample account (sandbox-seed.ts).
 */

export const SANDBOX_DATABASE_SUFFIX = '_sandbox';
export const SANDBOX_DATABASE_HOSTS: readonly string[] = ['postgres-demo', 'localhost', '127.0.0.1', '[::1]', '::1'];

export interface SandboxTarget {
  readonly databaseUrl: string;
  readonly databaseName: string;
  readonly host: string;
}

export class SandboxGuardError extends Error {}

/**
 * Returns the parsed target, or throws naming the first rule that failed. Messages name
 * the rule and the setting, never a password.
 */
export function assertSandboxTarget(env: NodeJS.ProcessEnv): SandboxTarget {
  if (env.ONE_SANDBOX !== 'true') {
    throw new SandboxGuardError('Refusing to run: this script only runs against the sandbox, and ONE_SANDBOX=true is not set.');
  }
  if (env.NODE_ENV === 'production') {
    throw new SandboxGuardError('Refusing to run: NODE_ENV is production. The sandbox is never a production environment.');
  }
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new SandboxGuardError('Refusing to run: DATABASE_URL is required.');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new SandboxGuardError('Refusing to run: DATABASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new SandboxGuardError('Refusing to run: DATABASE_URL must use the postgres or postgresql protocol.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName.endsWith(SANDBOX_DATABASE_SUFFIX) || databaseName.length === SANDBOX_DATABASE_SUFFIX.length) {
    throw new SandboxGuardError(`Refusing to run: the database "${databaseName}" is not a sandbox database (its name must end in "${SANDBOX_DATABASE_SUFFIX}").`);
  }
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new SandboxGuardError('Refusing to run: the sandbox database name may contain only lower-case letters, digits and underscores.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!SANDBOX_DATABASE_HOSTS.includes(host)) {
    throw new SandboxGuardError(`Refusing to run: the database host "${host}" is not the sandbox database (${SANDBOX_DATABASE_HOSTS.join(', ')}).`);
  }
  return { databaseUrl, databaseName, host };
}
