import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FileStorage } from './file-storage.js';

/**
 * At-rest encryption for stored documents (resumes, certificates, transcripts —
 * the densest personal data the platform holds). AES-256-GCM per file with a
 * random IV, wrapped around any FileStorage so callers never see ciphertext.
 *
 * Format: MAGIC(8) | version(1) | key fingerprint(8) | iv(12) | tag(16) | ciphertext.
 * The fingerprint turns "restored with the wrong key" into a named error instead
 * of a generic decrypt failure. Files without the magic header are returned as
 * written (pre-encryption uploads), so enabling the key needs no downtime; the
 * backfill script converts the remainder.
 */
const MAGIC = Buffer.from('PTPNENC1', 'ascii');
const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const FINGERPRINT_LENGTH = 8;
const HEADER_LENGTH = MAGIC.length + 1 + FINGERPRINT_LENGTH + IV_LENGTH + TAG_LENGTH;

/** FILE_ENCRYPTION_KEY is base64 for exactly 32 random bytes (openssl rand -base64 32). */
export function parseFileEncryptionKey(value: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(value, 'base64');
  } catch {
    throw new Error('FILE_ENCRYPTION_KEY must be valid base64');
  }
  if (key.length !== 32) {
    throw new Error('FILE_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

function keyFingerprint(key: Buffer): Buffer {
  return createHash('sha256').update(key).digest().subarray(0, FINGERPRINT_LENGTH);
}

export function isEncryptedFileBytes(bytes: Buffer): boolean {
  return bytes.length >= HEADER_LENGTH && bytes.subarray(0, MAGIC.length).equals(MAGIC);
}

export function encryptFileBytes(bytes: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), keyFingerprint(key), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptFileBytes(bytes: Buffer, key: Buffer): Buffer {
  if (!isEncryptedFileBytes(bytes)) throw new Error('stored file is not in the encrypted format');
  let offset = MAGIC.length;
  const version = bytes[offset];
  offset += 1;
  if (version !== VERSION) throw new Error(`stored file uses unsupported encryption version ${version}`);
  const fingerprint = bytes.subarray(offset, offset + FINGERPRINT_LENGTH);
  offset += FINGERPRINT_LENGTH;
  if (!fingerprint.equals(keyFingerprint(key))) {
    throw new Error('stored file was encrypted with a different FILE_ENCRYPTION_KEY');
  }
  const iv = bytes.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const tag = bytes.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(bytes.subarray(offset)), decipher.final()]);
  } catch {
    // GCM authentication failure: the bytes were altered after encryption.
    throw new Error('stored file failed integrity verification during decryption');
  }
}

export function createEncryptedStorage(inner: FileStorage, key: Buffer): FileStorage {
  return {
    provider: inner.provider,
    ...(inner.bucket ? { bucket: inner.bucket } : {}),
    async put(storageKey: string, bytes: Buffer): Promise<void> {
      await inner.put(storageKey, encryptFileBytes(bytes, key));
    },
    async get(storageKey: string): Promise<Buffer> {
      const stored = await inner.get(storageKey);
      // Pre-encryption uploads pass through until the backfill converts them.
      return isEncryptedFileBytes(stored) ? decryptFileBytes(stored, key) : stored;
    },
    async delete(storageKey: string): Promise<void> {
      await inner.delete(storageKey);
    },
  };
}
