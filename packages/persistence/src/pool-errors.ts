/**
 * Keeps a long-running process alive when one idle database connection breaks.
 *
 * node-postgres emits 'error' on the Pool when an idle client loses its connection (a
 * Postgres restart, a network blip, an admin terminating sessions). An EventEmitter with
 * no 'error' listener throws, so without this the whole API or worker process crashed and
 * Docker restarted it, failing every request in flight. The pool already discards the
 * broken client and opens a new one on the next query; the listener only has to exist and
 * say what happened in the server log.
 */
import type { Pool } from 'pg';

export function survivePoolErrors<T extends Pool>(pool: T, label: string, log: (line: string) => void = (line) => console.error(line)): T {
  pool.on('error', (error: Error) => {
    log(`[${label}] an idle database connection failed and was discarded: ${error.message}`);
  });
  return pool;
}
