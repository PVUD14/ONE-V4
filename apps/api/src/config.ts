import { parseFileEncryptionKey } from './storage/encrypted-storage.js';

export type NodeEnv = 'development' | 'test' | 'production';

export interface RuntimeConfig {
  readonly nodeEnv: NodeEnv;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly apiCorsOrigin?: string;
  readonly databaseUrl: string;
  readonly cognito: {
    readonly userPoolId?: string;
    readonly clientId?: string;
    /**
     * ADR-025's staff pool (MFA required). Absent by default: while it is absent, token
     * verification and membership handling are exactly as before. When present, internal
     * platform roles count only for tokens the staff pool issued (runtime-auth.ts).
     */
    readonly staffPool?: {
      readonly userPoolId: string;
      readonly clientId: string;
    };
  };
  readonly automation: {
    readonly signingSecret?: string;
  };
  readonly documents: {
    /** Absolute directory holding uploaded files. Absent means uploads are refused. */
    readonly storageRoot?: string;
    /** clamd unix socket, or host+port. Absent means uploads are refused. */
    readonly clamavSocketPath?: string;
    readonly clamavHost?: string;
    readonly clamavPort?: number;
    /** base64 of 32 bytes; when set, stored files are encrypted at rest (AES-256-GCM). */
    readonly fileEncryptionKey?: string;
  };
}

const allowedNodeEnvs = new Set<NodeEnv>(['development', 'test', 'production']);

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const apiHost = requireHost(env.API_HOST ?? '127.0.0.1', 'API_HOST');
  const apiPort = parsePort(env.API_PORT ?? '3000', 'API_PORT');
  const apiCorsOrigin = optionalNonEmpty(env.API_CORS_ORIGIN ?? (nodeEnv === 'development' ? 'http://127.0.0.1:5173' : undefined));
  const databaseUrl = requireDatabaseUrl(env.DATABASE_URL);
  const userPoolId = optionalNonEmpty(env.COGNITO_USER_POOL_ID);
  const clientId = optionalNonEmpty(env.COGNITO_CLIENT_ID);
  const automationSigningSecret = optionalNonEmpty(env.AUTOMATION_SIGNING_SECRET);

  if (nodeEnv === 'production' && (!userPoolId || !clientId)) {
    throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required in production');
  }
  const staffPool = parseStaffPool(env, userPoolId, clientId);
  if (automationSigningSecret && Buffer.byteLength(automationSigningSecret, 'utf8') < 32) {
    throw new Error('AUTOMATION_SIGNING_SECRET must contain at least 32 bytes');
  }
  if (nodeEnv === 'production' && !automationSigningSecret) {
    throw new Error('AUTOMATION_SIGNING_SECRET is required in production');
  }

  const storageRoot = optionalNonEmpty(env.FILE_STORAGE_ROOT);
  const clamavSocketPath = optionalNonEmpty(env.CLAMAV_SOCKET_PATH);
  const clamavHost = optionalNonEmpty(env.CLAMAV_HOST);
  const clamavPort = env.CLAMAV_PORT ? parsePort(env.CLAMAV_PORT, 'CLAMAV_PORT') : undefined;

  if (storageRoot && !storageRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(storageRoot)) {
    throw new Error('FILE_STORAGE_ROOT must be an absolute path');
  }
  if (clamavHost && !clamavPort) throw new Error('CLAMAV_PORT is required when CLAMAV_HOST is set');

  const fileEncryptionKey = optionalNonEmpty(env.FILE_ENCRYPTION_KEY);
  if (fileEncryptionKey) parseFileEncryptionKey(fileEncryptionKey);
  // New production deployments must not store documents in plaintext; existing
  // installs get a hard, named requirement rather than a silent downgrade.
  if (nodeEnv === 'production' && storageRoot && !fileEncryptionKey) {
    throw new Error('FILE_ENCRYPTION_KEY is required in production when FILE_STORAGE_ROOT is set; generate with: openssl rand -base64 32');
  }
  // Storage without a scanner would accept files nobody has checked. Rather than
  // silently degrade, refuse the configuration outright.
  if (storageRoot && !clamavSocketPath && !clamavHost) {
    throw new Error('FILE_STORAGE_ROOT requires CLAMAV_SOCKET_PATH or CLAMAV_HOST; uploads must be scanned');
  }

  return {
    nodeEnv,
    apiHost,
    apiPort,
    ...(apiCorsOrigin ? { apiCorsOrigin } : {}),
    databaseUrl,
    cognito: {
      ...(userPoolId ? { userPoolId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(staffPool ? { staffPool } : {}),
    },
    automation: {
      ...(automationSigningSecret ? { signingSecret: automationSigningSecret } : {}),
    },
    documents: {
      ...(storageRoot ? { storageRoot } : {}),
      ...(clamavSocketPath ? { clamavSocketPath } : {}),
      ...(clamavHost ? { clamavHost } : {}),
      ...(clamavPort ? { clamavPort } : {}),
      ...(fileEncryptionKey ? { fileEncryptionKey } : {}),
    },
  };
}

const cognitoUserPoolIdPattern = /^[a-z]{2}(?:-[a-z]+)+-\d+_[A-Za-z0-9]+$/;

/**
 * Both staff-pool settings or neither. Half a staff pool would leave the API believing
 * MFA is enforced for staff when it is not, so a partial configuration is refused at
 * startup rather than ignored. Messages name the setting, never its value.
 */
function parseStaffPool(
  env: NodeJS.ProcessEnv,
  userPoolId: string | undefined,
  clientId: string | undefined,
): { readonly userPoolId: string; readonly clientId: string } | undefined {
  const staffUserPoolId = optionalNonEmpty(env.COGNITO_STAFF_USER_POOL_ID);
  const staffClientId = optionalNonEmpty(env.COGNITO_STAFF_CLIENT_ID);
  if (!staffUserPoolId && !staffClientId) return undefined;
  if (!staffUserPoolId || !staffClientId) {
    throw new Error('COGNITO_STAFF_USER_POOL_ID and COGNITO_STAFF_CLIENT_ID must be set together');
  }
  if (!userPoolId || !clientId) {
    throw new Error('COGNITO_STAFF_USER_POOL_ID requires COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID');
  }
  if (!cognitoUserPoolIdPattern.test(staffUserPoolId)) {
    throw new Error('COGNITO_STAFF_USER_POOL_ID must be a Cognito user pool id (region_suffix)');
  }
  if (staffUserPoolId === userPoolId) {
    throw new Error('COGNITO_STAFF_USER_POOL_ID must name a different pool from COGNITO_USER_POOL_ID');
  }
  if (staffClientId === clientId) {
    throw new Error('COGNITO_STAFF_CLIENT_ID must differ from COGNITO_CLIENT_ID');
  }
  return { userPoolId: staffUserPoolId, clientId: staffClientId };
}

function parseNodeEnv(value: string | undefined): NodeEnv {
  const candidate = value ?? 'development';
  if (allowedNodeEnvs.has(candidate as NodeEnv)) return candidate as NodeEnv;
  throw new Error('NODE_ENV must be one of development, test, or production');
}

function requireHost(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function parsePort(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer port`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be between 1 and 65535`);
  }
  return parsed;
}

function requireDatabaseUrl(value: string | undefined): string {
  const trimmed = optionalNonEmpty(value);
  if (!trimmed) throw new Error('DATABASE_URL is required');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol');
  }
  return trimmed;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
