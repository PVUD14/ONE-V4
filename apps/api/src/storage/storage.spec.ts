import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClamAvScanner, createUnavailableScanner, interpretClamAvReply } from './clamav.js';
import { assertSafeStorageKey, createLocalDiskStorage } from './file-storage.js';

describe('clamd reply interpretation', () => {
  it('reads a clean verdict', () => {
    expect(interpretClamAvReply('stream: OK\0')).toEqual({ state: 'CLEAN' });
  });

  it('reads an infection and keeps the signature', () => {
    expect(interpretClamAvReply('stream: Eicar-Test-Signature FOUND\0'))
      .toEqual({ state: 'INFECTED', signature: 'Eicar-Test-Signature' });
  });

  it('treats a scanner error as failure, never as clean', () => {
    const verdict = interpretClamAvReply('INSTREAM size limit exceeded. ERROR\0');
    expect(verdict.state).toBe('SCAN_FAILED');
  });

  it('treats an empty or unrecognised reply as failure', () => {
    expect(interpretClamAvReply('').state).toBe('SCAN_FAILED');
    expect(interpretClamAvReply('something unexpected').state).toBe('SCAN_FAILED');
  });

  it('does not mistake a filename containing OK for a clean verdict', () => {
    // 'FOUND' must win: a signature name can legitimately contain other words.
    expect(interpretClamAvReply('stream: Win.Test.OK-1 FOUND\0').state).toBe('INFECTED');
  });
});

describe('clamd client', () => {
  let server: Server | undefined;
  const openSockets = new Set<Socket>();

  afterEach(async () => {
    // The timeout case deliberately leaves a connection open, and net.Server.close()
    // waits for existing connections, so sockets are tracked and dropped explicitly.
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
    if (!server) return;
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
  });

  const track = (socket: Socket): void => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  };

  /** `reply: null` leaves the connection open so the client's timeout is what fires. */
  async function startFakeClamd(reply: string | null): Promise<number> {
    server = createServer((socket) => {
      track(socket);
      socket.on('data', (chunk) => {
        // The terminating zero-length chunk ends the stream.
        if (chunk.length >= 4 && chunk.subarray(chunk.length - 4).equals(Buffer.from([0, 0, 0, 0]))) {
          if (reply === null) return;
          socket.write(reply);
          socket.end();
        }
      });
    });
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready));
    return (server!.address() as { port: number }).port;
  }

  it('streams a payload and returns the verdict', async () => {
    const port = await startFakeClamd('stream: OK\0');
    const scanner = createClamAvScanner({ host: '127.0.0.1', port });
    await expect(scanner.scan(Buffer.from('harmless'))).resolves.toEqual({ state: 'CLEAN' });
  });

  it('reports an infection from the stream reply', async () => {
    const port = await startFakeClamd('stream: Eicar-Test-Signature FOUND\0');
    const scanner = createClamAvScanner({ host: '127.0.0.1', port });
    await expect(scanner.scan(Buffer.from('x'))).resolves.toEqual({ state: 'INFECTED', signature: 'Eicar-Test-Signature' });
  });

  it('fails closed when the scanner is unreachable', async () => {
    // Port 1 is reserved and refuses connections.
    const scanner = createClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    const verdict = await scanner.scan(Buffer.from('x'));
    expect(verdict.state).toBe('SCAN_FAILED');
  });

  it('fails closed when the scanner never answers', async () => {
    const port = await startFakeClamd(null);
    const scanner = createClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 400 });
    const verdict = await scanner.scan(Buffer.from('x'));
    expect(verdict).toEqual({ state: 'SCAN_FAILED', reason: 'scanner timed out' });
  });

  it('fails closed when the scanner closes without answering', async () => {
    server = createServer((socket) => { track(socket); socket.end(); });
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready));
    const port = (server.address() as { port: number }).port;
    const scanner = createClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 2000 });
    const verdict = await scanner.scan(Buffer.from('x'));
    expect(verdict).toEqual({ state: 'SCAN_FAILED', reason: 'empty scanner reply' });
  });

  it('refuses everything when no scanner is configured', async () => {
    const verdict = await createUnavailableScanner().scan(Buffer.from('x'));
    expect(verdict.state).toBe('SCAN_FAILED');
  });
});

describe('storage keys', () => {
  it('accepts a server-generated key', () => {
    expect(() => assertSafeStorageKey('students/2026/08/abc-123.pdf')).not.toThrow();
  });

  it('refuses traversal, absolute paths, whitespace and null bytes', () => {
    expect(() => assertSafeStorageKey('../../etc/passwd')).toThrow('traversal');
    expect(() => assertSafeStorageKey('/etc/passwd')).toThrow('relative');
    expect(() => assertSafeStorageKey('students/a b.pdf')).toThrow('whitespace');
    expect(() => assertSafeStorageKey('students\\a.pdf')).toThrow('whitespace');
    expect(() => assertSafeStorageKey('students/a\0.pdf')).toThrow();
    expect(() => assertSafeStorageKey('')).toThrow();
  });
});

describe('local disk storage', () => {
  it('round-trips a file, keeps it private, and refuses to escape the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'one-storage-'));
    try {
      const storage = createLocalDiskStorage(root);
      await storage.put('students/a/cv.pdf', Buffer.from('%PDF-1.7 test'));
      expect((await storage.get('students/a/cv.pdf')).toString()).toBe('%PDF-1.7 test');

      if (process.platform !== 'win32') {
        const mode = (await stat(join(root, 'students/a/cv.pdf'))).mode & 0o777;
        expect(mode).toBe(0o600);
      }

      await expect(storage.put('../escaped.pdf', Buffer.from('x'))).rejects.toThrow();
      await expect(storage.get('/etc/passwd')).rejects.toThrow();

      // Writing the same key twice must not silently replace stored bytes.
      await expect(storage.put('students/a/cv.pdf', Buffer.from('other'))).rejects.toThrow();
      expect((await readFile(join(root, 'students/a/cv.pdf'))).toString()).toBe('%PDF-1.7 test');

      await storage.delete('students/a/cv.pdf');
      await expect(storage.get('students/a/cv.pdf')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
