import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEncryptedStorage,
  decryptFileBytes,
  encryptFileBytes,
  isEncryptedFileBytes,
  parseFileEncryptionKey,
} from './encrypted-storage.js';
import { encryptExistingFiles } from '../scripts/encrypt-stored-files.js';
import type { FileStorage } from './file-storage.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

function memoryStorage(): FileStorage & { readonly files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    provider: 'LOCAL_DISK',
    files,
    async put(key, bytes) { files.set(key, Buffer.from(bytes)); },
    async get(key) {
      const value = files.get(key);
      if (!value) throw new Error('missing');
      return value;
    },
    async delete(key) { files.delete(key); },
  };
}

describe('file encryption format', () => {
  it('round-trips bytes and marks them as encrypted', () => {
    const original = randomBytes(64 * 1024);
    const sealed = encryptFileBytes(original, KEY);
    expect(isEncryptedFileBytes(sealed)).toBe(true);
    expect(isEncryptedFileBytes(original)).toBe(false);
    expect(sealed.includes(original.subarray(0, 32))).toBe(false);
    expect(decryptFileBytes(sealed, KEY).equals(original)).toBe(true);
  });

  it('names a wrong key instead of failing generically', () => {
    const sealed = encryptFileBytes(Buffer.from('resume'), KEY);
    expect(() => decryptFileBytes(sealed, OTHER_KEY)).toThrow('different FILE_ENCRYPTION_KEY');
  });

  it('detects tampering via GCM authentication', () => {
    const sealed = encryptFileBytes(Buffer.from('certificate bytes'), KEY);
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 0xff;
    expect(() => decryptFileBytes(sealed, KEY)).toThrow('integrity verification');
  });

  it('validates the configured key shape', () => {
    expect(() => parseFileEncryptionKey('short')).toThrow('exactly 32 bytes');
    expect(parseFileEncryptionKey(KEY.toString('base64')).equals(KEY)).toBe(true);
  });
});

describe('encrypted storage wrapper', () => {
  it('stores ciphertext but serves plaintext', async () => {
    const inner = memoryStorage();
    const storage = createEncryptedStorage(inner, KEY);
    const bytes = Buffer.from('%PDF-1.7 resume with phone number');
    await storage.put('docs/a.pdf', bytes);
    expect(isEncryptedFileBytes(inner.files.get('docs/a.pdf')!)).toBe(true);
    expect(inner.files.get('docs/a.pdf')!.includes(Buffer.from('phone'))).toBe(false);
    expect((await storage.get('docs/a.pdf')).equals(bytes)).toBe(true);
  });

  it('passes through files uploaded before encryption was enabled', async () => {
    const inner = memoryStorage();
    const legacy = Buffer.from('legacy plaintext upload');
    inner.files.set('docs/old.pdf', legacy);
    const storage = createEncryptedStorage(inner, KEY);
    expect((await storage.get('docs/old.pdf')).equals(legacy)).toBe(true);
  });
});

describe('backfill of existing files', () => {
  let root = '';
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('encrypts plaintext files once, atomically, and skips them on rerun', async () => {
    root = await mkdtemp(join(tmpdir(), 'ptpn-enc-'));
    const plain = Buffer.from('old resume content');
    await writeFile(join(root, 'one.pdf'), plain);
    await writeFile(join(root, 'two.pdf'), encryptFileBytes(Buffer.from('already sealed'), KEY));

    const first = await encryptExistingFiles(root, KEY);
    expect(first).toEqual({ encrypted: 1, skipped: 1 });
    const onDisk = await readFile(join(root, 'one.pdf'));
    expect(isEncryptedFileBytes(onDisk)).toBe(true);
    expect(decryptFileBytes(onDisk, KEY).equals(plain)).toBe(true);

    const second = await encryptExistingFiles(root, KEY);
    expect(second).toEqual({ encrypted: 0, skipped: 2 });
  });
});
