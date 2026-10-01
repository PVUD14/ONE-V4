/**
 * A broken idle connection must not crash the process: the pool gets an 'error' listener.
 */
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { survivePoolErrors } from '../src/pool-errors.js';

describe('survivePoolErrors', () => {
  it('a pool without the listener throws on a connection error, which is what crashed the API', () => {
    const bare = new Pool({ connectionString: 'postgresql://nobody@127.0.0.1:1/none' });
    expect(() => bare.emit('error', new Error('terminating connection due to administrator command'))).toThrow();
  });

  it('with the listener the error is logged once and the process carries on', () => {
    const lines: string[] = [];
    const pool = survivePoolErrors(new Pool({ connectionString: 'postgresql://nobody@127.0.0.1:1/none' }), 'api', (line) => lines.push(line));
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(lines).toEqual(['[api] an idle database connection failed and was discarded: terminating connection due to administrator command']);
  });
});
