import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outputFlag = process.argv.indexOf('--output');
if (outputFlag === -1 || !process.argv[outputFlag + 1]) throw new Error('--output is required');
const output = resolve(process.argv[outputFlag + 1]);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
if (output === source || source.startsWith(`${output}\\`) || source.startsWith(`${output}/`)) throw new Error('output must be outside the source workflow tree');
const headerCredentialId = requireCredentialId('PTP_ADAPTER_HEADER_CREDENTIAL_ID');
const smtpCredentialId = requireCredentialId('PTP_SMTP_CREDENTIAL_ID');
const directories = (await readdir(source, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

for (const directory of directories) {
  const workflow = JSON.parse(await readFile(join(source, directory, 'workflow.json'), 'utf8'));
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.webhook') node.credentials.httpHeaderAuth.id = headerCredentialId;
    if (node.type === 'n8n-nodes-base.emailSend') node.credentials.smtp.id = smtpCredentialId;
  }
  const target = join(output, directory);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
console.log(JSON.stringify({ event: 'n8n.workflows.materialized', workflows: directories.length, output }));

function requireCredentialId(name) {
  const value = process.env[name]?.trim();
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${name} must be a deployment-managed n8n credential ID`);
  return value;
}
