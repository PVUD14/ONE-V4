/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-08
 * Agent-assisted: yes (Claude) · Reviewed: pending
 */
import { defineConfig } from 'vitest/config';

/**
 * Same reasoning as apps/api/vitest.config.ts: these integration tests replay the
 * whole migration set before they assert anything, and the ten-second default hook
 * timeout is not related to how long that legitimately takes.
 *
 * fileParallelism stays off here as the package script already sets it — these specs
 * share one database and truncate in setup, so running them concurrently makes them
 * delete each other's fixtures.
 */
export default defineConfig({
  test: {
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
