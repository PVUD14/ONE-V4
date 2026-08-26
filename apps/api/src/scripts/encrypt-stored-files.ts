import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encryptFileBytes, isEncryptedFileBytes, parseFileEncryptionKey } from '../storage/encrypted-storage.js';

/**
 * One-time backfill: encrypts every stored document that predates
 * FILE_ENCRYPTION_KEY. Idempotent — already-encrypted files are skipped, so it
 * is safe to run repeatedly, and each file is replaced atomically (temp file
 * then rename) so a crash mid-run never leaves a truncated document.
 *
 * Run on the server with the application environment loaded:
 *   set -a; . /srv/planthepath-next/shared/app.env; set +a
 *   node /srv/planthepath-next/current/apps/api/dist/scripts/encrypt-stored-files.js
 */
export async function encryptExistingFiles(root: string, key: Buffer): Promise<{ encrypted: number; skipped: number }> {
  let encrypted = 0;
  let skipped = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('.enc-tmp')) continue;
      const bytes = await readFile(path);
      if (isEncryptedFileBytes(bytes)) {
        skipped += 1;
        continue;
      }
      const temp = `${path}.enc-tmp`;
      await writeFile(temp, encryptFileBytes(bytes, key), { mode: 0o600 });
      await rename(temp, path);
      encrypted += 1;
    }
  }

  await walk(root);
  return { encrypted, skipped };
}

async function main(): Promise<void> {
  const root = process.env.FILE_STORAGE_ROOT;
  const rawKey = process.env.FILE_ENCRYPTION_KEY;
  if (!root) throw new Error('FILE_STORAGE_ROOT is not set');
  if (!rawKey) throw new Error('FILE_ENCRYPTION_KEY is not set');
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`FILE_STORAGE_ROOT is not a directory: ${root}`);
  const { encrypted, skipped } = await encryptExistingFiles(root, parseFileEncryptionKey(rawKey));
  console.log(JSON.stringify({ event: 'files.encryption.backfill', encrypted, alreadyEncrypted: skipped }));
}

// Invoked directly as a script; imported by tests for encryptExistingFiles only.
if (process.argv[1]?.includes('encrypt-stored-files')) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'files.encryption.backfill.failed', reason: error instanceof Error ? error.message : 'unknown' }));
    process.exitCode = 1;
  });
}
