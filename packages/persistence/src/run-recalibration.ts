/**
 * Offline command for the monthly recalibration and BKT refit (ENG-26):
 *   corepack pnpm --silent --filter @planthepath/persistence engine:recalibration <command> …
 *
 *   export  --kind items|bkt --out <export.json> --baseline <baseline.json>
 *   record  --in <proposal.json> [--report-dir <dir>]
 *   list    [--limit 20]
 *   report  [--run <id>] [--json]           (no --run: the latest run)
 *   accept  --run <id> --reason "<why>"
 *   reject  --run <id> --reason "<why>"
 *   revert  --run <id> --reason "<why>"
 *
 * Why this exists: the Python job has no database access (ADR-034); this exports what it reads,
 * records what it proposes, and is the only way a proposal is adopted — by an explicit, recorded
 * decision. Started by deploy/scripts/run-recalibration.sh (export, record) and by Divakar (the
 * rest), per docs/ops/runbook-monthly-recalibration.md. On no route. Logs counts only.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { PersistenceDb } from './repositories.js';
import {
  RecalibrationError,
  decideRecalibration,
  exportBktRefit,
  exportItemRecalibration,
  listRecalibrationRuns,
  loadRecalibrationRun,
  recordRecalibrationProposal,
  renderRecalibrationMarkdown,
  revertRecalibration,
} from './recalibration.js';

const [command, ...rest] = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`engine:recalibration ${command}: --${name} is required`);
  return value;
}

const commands = ['export', 'record', 'list', 'report', 'accept', 'reject', 'revert'];
if (!command || !commands.includes(command)) {
  throw new Error(`usage: engine:recalibration <${commands.join('|')}> … (see docs/ops/runbook-monthly-recalibration.md)`);
}
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl });

async function main(db: PersistenceDb): Promise<void> {
  switch (command) {
    case 'export': {
      const kind = required('kind');
      if (kind !== 'items' && kind !== 'bkt') throw new Error('--kind must be items or bkt');
      const outPath = required('out');
      const baselinePath = required('baseline');
      // The export is pseudonymous per-learner data: owner-only, and the caller deletes it after the fit.
      if (kind === 'items') {
        const { export: exported, baseline } = await exportItemRecalibration(db);
        await writeFile(outPath, JSON.stringify(exported), { encoding: 'utf8', mode: 0o600 });
        await writeFile(baselinePath, JSON.stringify(baseline), { encoding: 'utf8', mode: 0o600 });
        console.log(JSON.stringify({
          event: 'engine.recalibration.exported', kind: 'ITEM_2PL', runId: exported.runId,
          learners: new Set(exported.responses.map(([learner]) => learner)).size,
          items: new Set(exported.responses.map(([, item]) => item)).size,
          responses: exported.responses.length, baselineItems: baseline.items?.length ?? 0,
        }));
      } else {
        const { export: exported, baseline } = await exportBktRefit(db);
        await writeFile(outPath, JSON.stringify(exported), { encoding: 'utf8', mode: 0o600 });
        await writeFile(baselinePath, JSON.stringify(baseline), { encoding: 'utf8', mode: 0o600 });
        console.log(JSON.stringify({
          event: 'engine.recalibration.exported', kind: 'BKT', runId: exported.runId,
          sequences: exported.sequences.length, skills: new Set(exported.sequences.map(([skill]) => skill)).size,
          observations: exported.sequences.reduce((total, [, observed]) => total + observed.length, 0),
          baselineSkills: baseline.skills?.length ?? 0,
        }));
      }
      return;
    }
    case 'record': {
      const outcome = await recordRecalibrationProposal(db, JSON.parse(await readFile(required('in'), 'utf8')) as unknown);
      console.log(JSON.stringify({ event: 'engine.recalibration.recorded', ...outcome }));
      const reportDir = option('report-dir');
      if (reportDir) {
        const run = await loadRecalibrationRun(db, outcome.runId);
        await mkdir(reportDir, { recursive: true });
        const file = join(reportDir, `${run!.recordedAt.slice(0, 10)}-${run!.kind}-${run!.id}.md`);
        await writeFile(file, renderRecalibrationMarkdown(run!), { encoding: 'utf8', mode: 0o640 });
        console.log(JSON.stringify({ event: 'engine.recalibration.report-written', runId: outcome.runId, file }));
      }
      return;
    }
    case 'list': {
      for (const run of await listRecalibrationRuns(db, Number(option('limit') ?? 20))) console.log(JSON.stringify(run));
      return;
    }
    case 'report': {
      const runId = option('run') ?? (await listRecalibrationRuns(db, 1))[0]?.id;
      if (!runId) throw new Error('no recalibration run is recorded');
      const run = await loadRecalibrationRun(db, runId);
      if (!run) throw new Error('no recalibration run has that id');
      if (rest.includes('--json')) console.log(JSON.stringify({ ...run, results: undefined }, null, 2));
      else console.log(renderRecalibrationMarkdown(run));
      return;
    }
    case 'accept':
    case 'reject': {
      const outcome = await decideRecalibration(db, {
        runId: required('run'), decision: command === 'accept' ? 'ACCEPTED' : 'REJECTED', reason: required('reason'),
      });
      console.log(JSON.stringify({ event: 'engine.recalibration.decided', ...outcome }));
      return;
    }
    case 'revert': {
      const outcome = await revertRecalibration(db, { runId: required('run'), reason: required('reason') });
      console.log(JSON.stringify({ event: 'engine.recalibration.reverted', ...outcome }));
      return;
    }
  }
}

try {
  await main(drizzle(pool, { schema }) as unknown as PersistenceDb);
} catch (error) {
  if (error instanceof RecalibrationError) {
    console.error(JSON.stringify({ event: 'engine.recalibration.refused', code: error.code, detail: error.message }));
    process.exitCode = 2;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
