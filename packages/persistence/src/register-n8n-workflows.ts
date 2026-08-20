import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { registerAutomationWorkflow, type AutomationWorkflowDeployment } from './automation-runtime.js';

export async function loadN8nWorkflowDeployments(root = new URL('../../../automation/n8n/workflows/', import.meta.url)):
Promise<readonly AutomationWorkflowDeployment[]> {
  const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const deployments: AutomationWorkflowDeployment[] = [];
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(new URL(`${directory}/manifest.json`, root), 'utf8')) as Record<string, unknown>;
    const workflowBytes = await readFile(new URL(`${directory}/workflow.json`, root));
    if (manifest.allowlistId !== directory || typeof manifest.registryId !== 'string' || typeof manifest.version !== 'number'
      || typeof manifest.workflowSha256 !== 'string' || typeof manifest.operation !== 'string'
      || manifest.destinationClass !== 'EMAIL' || manifest.activeByDefault !== false || manifest.killSwitchByDefault !== true) {
      throw new Error(`${directory}: invalid n8n workflow manifest`);
    }
    if (createHash('sha256').update(workflowBytes).digest('hex') !== manifest.workflowSha256) {
      throw new Error(`${directory}: deployed workflow source does not match its registered hash`);
    }
    deployments.push({ id: manifest.registryId, allowlistId: directory as AutomationWorkflowDeployment['allowlistId'],
      version: manifest.version, workflowHash: manifest.workflowSha256,
      operation: manifest.operation as AutomationWorkflowDeployment['operation'], destinationClass: 'EMAIL', active: false, killSwitch: true });
  }
  const expected = ['assessment-due', 'content-review', 'institution-report', 'ops-failure', 'roadmap-overdue', 'security-notification'];
  if (JSON.stringify(deployments.map((item) => item.allowlistId)) !== JSON.stringify(expected)) throw new Error('n8n workflow manifest set is not exact');
  return deployments;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const deployments = await loadN8nWorkflowDeployments();
    for (const deployment of deployments) await registerAutomationWorkflow(pool, deployment);
    console.log(JSON.stringify({ event: 'automation.workflow.registry.seeded', workflows: deployments.length,
      active: 0, killSwitchesEnabled: deployments.length }));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'automation.workflow.registry.failed', failureClass: error instanceof Error ? error.name : 'UnknownError' }));
    process.exitCode = 1;
  });
}
