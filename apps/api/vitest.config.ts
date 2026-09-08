/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-08
 * Agent-assisted: yes (Claude) · Reviewed: pending
 */
import { defineConfig } from 'vitest/config';

/**
 * Integration specs in this package create a Postgres schema and replay every
 * migration in `beforeAll`. That set is now twenty-one files and grows with the
 * product, and on a loaded machine it comfortably exceeds vitest's ten-second
 * default hook timeout.
 *
 * The failure that produces is misleading: the setup times out in whichever spec
 * happens to be running when the machine is busiest, so it reads as a defect in
 * unrelated code rather than as a timeout. It cost one cross-stream debugging cycle
 * already, and the trigger was simply two new migrations landing.
 *
 * Setting it here rather than per spec means a new integration test inherits a
 * workable timeout instead of depending on its author having been bitten before.
 */
export default defineConfig({
  test: {
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
