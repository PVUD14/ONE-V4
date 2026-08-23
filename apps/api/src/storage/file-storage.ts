import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * File storage behind a narrow interface so the move from VPS disk to S3 is a
 * provider swap rather than a change to any caller. Keys are opaque and
 * server-generated; the same shape the database constrains.
 */
export interface FileStorage {
  readonly provider: 'LOCAL_DISK' | 'S3';
  readonly bucket?: string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Mirrors the stored_files_key_ck constraint so a bad key is refused before any IO. */
export function assertSafeStorageKey(key: string): void {
  if (!key || key.length > 512) throw new Error('storage key must be between 1 and 512 characters');
  if (key.startsWith('/')) throw new Error('storage key must be relative');
  if (key.includes('..')) throw new Error('storage key must not contain traversal segments');
  if (/[\s\\]/.test(key)) throw new Error('storage key must not contain whitespace or backslashes');
  if (/\0/.test(key)) throw new Error('storage key must not contain a null byte');
}

export function createLocalDiskStorage(root: string): FileStorage {
  const rootPath = resolve(root);

  /**
   * Resolves the key and then proves the result is still inside the root. The key
   * checks above should make this unreachable; it is here because a containment bug
   * in this function is the difference between a file store and arbitrary file write.
   */
  const resolveWithin = (key: string): string => {
    assertSafeStorageKey(key);
    const target = resolve(join(rootPath, key));
    if (target !== rootPath && !target.startsWith(rootPath + sep)) {
      throw new Error('resolved storage path escapes the storage root');
    }
    return target;
  };

  return {
    provider: 'LOCAL_DISK',
    async put(key: string, bytes: Buffer): Promise<void> {
      const target = resolveWithin(key);
      await mkdir(dirname(target), { recursive: true });
      // 0600: the files are student documents, readable only by the service account.
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    },
    async get(key: string): Promise<Buffer> {
      return readFile(resolveWithin(key));
    },
    async delete(key: string): Promise<void> {
      await rm(resolveWithin(key), { force: true });
    },
  };
}
