import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const expected = ['assessment-due', 'content-review', 'institution-report', 'ops-failure', 'roadmap-overdue', 'security-notification'];
const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
if (JSON.stringify(directories) !== JSON.stringify(expected)) throw new Error(`workflow set is not exact: ${directories.join(',')}`);

const allowedNodeTypes = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.emailSend', 'n8n-nodes-base.respondToWebhook']);
for (const directory of directories) {
  const workflowBytes = await readFile(join(root, directory, 'workflow.json'));
  const workflow = JSON.parse(workflowBytes.toString('utf8'));
  const manifest = JSON.parse(await readFile(join(root, directory, 'manifest.json'), 'utf8'));
  const hash = createHash('sha256').update(workflowBytes).digest('hex');
  if (hash !== manifest.workflowSha256) throw new Error(`${directory}: workflow hash does not match manifest`);
  if (manifest.allowlistId !== directory || manifest.activeByDefault !== false || manifest.killSwitchByDefault !== true) throw new Error(`${directory}: unsafe registry defaults`);
  if (manifest.destinationClass !== 'EMAIL' || !['SEND_EMAIL', 'DELIVER_REPORT'].includes(manifest.operation)) throw new Error(`${directory}: non-email destination`);
  if (JSON.stringify(manifest.approvedNodes) !== JSON.stringify([...allowedNodeTypes])
    || JSON.stringify(manifest.credentialTypes) !== JSON.stringify(['httpHeaderAuth', 'smtp'])
    || !Array.isArray(manifest.egressDestinations) || manifest.egressDestinations.length !== 1
    || typeof manifest.dataClassification !== 'string' || typeof manifest.retention !== 'string'
    || typeof manifest.owner !== 'string' || manifest.runbook !== 'RUNBOOK.md'
    || manifest.testEvidence !== '../../VERIFICATION.md' || typeof manifest.rollback !== 'string') throw new Error(`${directory}: incomplete operational metadata`);
  if (!manifest.acceptedFields?.includes('callbackId') || !manifest.acceptedFields?.includes('callbackToken')) throw new Error(`${directory}: callback contract is incomplete`);
  if (manifest.sourceEvidence.commit !== '94007c1445d9258a7da116646b79473e7c7c3282' || !/^[0-9a-f]{64}$/.test(manifest.sourceEvidence.sha256)) throw new Error(`${directory}: incomplete frozen-source evidence`);
  if (workflow.id !== manifest.registryId || workflow.active !== false || workflow.nodes.length !== 3 || workflow.pinData && Object.keys(workflow.pinData).length) throw new Error(`${directory}: workflow must use its stable ID and remain inactive, minimal, and unpinned`);
  for (const node of workflow.nodes) {
    if (!allowedNodeTypes.has(node.type)) throw new Error(`${directory}: disallowed node ${node.type}`);
  }
  const webhook = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.webhook');
  const email = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.emailSend');
  const callback = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.respondToWebhook');
  if (webhook?.parameters?.authentication !== 'headerAuth' || webhook?.parameters?.httpMethod !== 'POST' || webhook?.parameters?.responseMode !== 'responseNode') throw new Error(`${directory}: webhook is not authenticated synchronous POST`);
  if (webhook?.credentials?.httpHeaderAuth?.name !== 'PlanThePath Adapter Header' || 'id' in webhook.credentials.httpHeaderAuth) throw new Error(`${directory}: source export must contain only the Header Auth credential type/name`);
  if (email?.credentials?.smtp?.name !== 'PlanThePath SMTP' || 'id' in email.credentials.smtp) throw new Error(`${directory}: source export must contain only the SMTP credential type/name`);
  if (callback?.parameters?.respondWith !== 'json' || !String(callback?.parameters?.responseBody).includes('callbackToken')) throw new Error(`${directory}: verified callback response is missing`);
  const raw = workflowBytes.toString('utf8');
  for (const forbidden of ['googleContacts', 'slack', 'asana', 'todoist', 'awsSns', 'httpRequest', 'executeCommand', 'readBinaryFile', 'postgres', 'openAi']) {
    if (raw.includes(forbidden)) throw new Error(`${directory}: forbidden capability ${forbidden}`);
  }
  for (const secretPattern of [/AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /@[A-Za-z0-9.-]+\.(com|org|net)\b/]) {
    if (secretPattern.test(raw)) throw new Error(`${directory}: workflow contains secret-like or external recipient content`);
  }
}
console.log(`validated ${directories.length} inactive, email-only, hash-pinned n8n workflows`);
