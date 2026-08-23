import { connect, type Socket } from 'node:net';

/**
 * ClamAV INSTREAM client.
 *
 * Speaks clamd's wire protocol directly rather than pulling in a client library:
 * the protocol is four lines long and a dependency here would sit directly in the
 * path of every uploaded file.
 *
 * Every failure mode resolves to SCAN_FAILED rather than throwing or defaulting to
 * clean. An unreachable scanner, a timeout, a truncated reply or an unrecognised
 * response all mean "we do not know", and the caller must treat not-knowing as
 * not-clean.
 */

export type ScanVerdict =
  | { readonly state: 'CLEAN' }
  | { readonly state: 'INFECTED'; readonly signature: string }
  | { readonly state: 'SCAN_FAILED'; readonly reason: string };

export interface FileScanner {
  readonly engine: string;
  scan(bytes: Buffer): Promise<ScanVerdict>;
}

/**
 * Either a unix socket or a TCP endpoint. Debian and Ubuntu ship clamd on a unix
 * socket at /var/run/clamav/clamd.ctl and leave TCP disabled, so the socket is the
 * expected configuration; enabling TCP only to reach a daemon on the same host
 * widens exposure for nothing.
 */
export type ClamAvOptions =
  | { readonly socketPath: string; readonly timeoutMs?: number; readonly chunkSize?: number }
  | { readonly host: string; readonly port: number; readonly timeoutMs?: number; readonly chunkSize?: number };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CHUNK = 65_536;

export function createClamAvScanner(options: ClamAvOptions): FileScanner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK;

  return {
    engine: 'clamav',
    scan(bytes: Buffer): Promise<ScanVerdict> {
      return new Promise<ScanVerdict>((resolve) => {
        let settled = false;
        const finish = (verdict: ScanVerdict): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(verdict);
        };

        const chunks: Buffer[] = [];
        const socket: Socket = 'socketPath' in options
          ? connect({ path: options.socketPath })
          : connect({ host: options.host, port: options.port });
        socket.setTimeout(timeoutMs);

        socket.on('connect', () => {
          socket.write('zINSTREAM\0');
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
            const header = Buffer.alloc(4);
            header.writeUInt32BE(slice.length, 0);
            socket.write(header);
            socket.write(slice);
          }
          // A zero-length chunk terminates the stream.
          socket.write(Buffer.from([0, 0, 0, 0]));
        });

        socket.on('data', (chunk) => { chunks.push(chunk); });
        socket.on('end', () => finish(interpretClamAvReply(Buffer.concat(chunks).toString('utf8'))));
        socket.on('timeout', () => finish({ state: 'SCAN_FAILED', reason: 'scanner timed out' }));
        socket.on('error', (error) => finish({ state: 'SCAN_FAILED', reason: `scanner unreachable: ${error.message}` }));
      });
    },
  };
}

/**
 * clamd answers `stream: OK`, `stream: <signature> FOUND`, or something containing
 * ERROR. Anything else is unrecognised and therefore unsafe to call clean.
 */
export function interpretClamAvReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0/g, '').trim();
  if (!text) return { state: 'SCAN_FAILED', reason: 'empty scanner reply' };
  if (/\bERROR\b/i.test(text)) return { state: 'SCAN_FAILED', reason: text.slice(0, 200) };
  if (/\bFOUND\b/.test(text)) {
    const match = /^stream:\s*(.+?)\s+FOUND$/i.exec(text);
    return { state: 'INFECTED', signature: (match?.[1] ?? 'unknown').slice(0, 200) };
  }
  if (/\bOK\b/.test(text)) return { state: 'CLEAN' };
  return { state: 'SCAN_FAILED', reason: `unrecognised scanner reply: ${text.slice(0, 120)}` };
}

/**
 * Used when no scanner is configured. It refuses everything rather than passing
 * files through unscanned, so a missing configuration cannot quietly become an
 * unscanned file store.
 */
export function createUnavailableScanner(): FileScanner {
  return {
    engine: 'unconfigured',
    async scan(): Promise<ScanVerdict> {
      return { state: 'SCAN_FAILED', reason: 'no malware scanner is configured' };
    },
  };
}
