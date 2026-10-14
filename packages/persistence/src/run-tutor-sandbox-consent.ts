/**
 * `ai:tutor-sandbox-consent` (ENG-22): puts the sandbox-only `ai-tutoring` consent in place for the
 * sandbox's sample students, so the AI tutor can be demonstrated. Refuses anything but the sandbox
 * database (tutor-sandbox.ts); prints counts only.
 */
import { Pool } from 'pg';
import { TutorSandboxRefused, assertTutorSandboxTarget, setUpTutorSandboxConsent } from './tutor-sandbox.js';

async function main(): Promise<void> {
  assertTutorSandboxTarget(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await setUpTutorSandboxConsent(pool, process.env);
    console.log(JSON.stringify({ event: 'tutor.sandbox_consent', definitionCreated: result.definitionCreated, granted: result.granted }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof TutorSandboxRefused ? error.message : JSON.stringify({ event: 'tutor.sandbox_consent.failed', failureClass: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
