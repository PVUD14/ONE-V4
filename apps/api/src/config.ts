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
