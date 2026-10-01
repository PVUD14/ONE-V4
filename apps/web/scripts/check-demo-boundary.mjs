#!/usr/bin/env node
/**
 * Proves the line between the real site and the demo site in the built files.
 *
 * oneby8.com is built without VITE_DEMO_SITE and must carry none of the pilot's or the
 * demo site's fictional people - CLAUDE.md forbids invented data on screens real users
 * can reach, and the old release script grepped for exactly this leak. demo.oneby8.com
 * is built with VITE_DEMO_SITE=true and must carry the demo and none of the real
 * application (no sign-in, no API client). Both rely on the bundler dropping code
 * behind build-time flags, so the only trustworthy check is the output itself.
 *
 *   node scripts/check-demo-boundary.mjs <distDir> production   # oneby8.com
 *   node scripts/check-demo-boundary.mjs <distDir> demo         # demo.oneby8.com
 *
 * Run by deploy/vps/Dockerfile.web after every web build and by CI (phase1-ci.yml).
 * Exits non-zero, naming each failed marker, if the boundary is crossed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ASCII-only markers: the bundler may escape non-ASCII characters in string literals.
const FICTION = ['Meera Nair', 'Arjun Reddy', 'Lakeview Institute', 'Zenvia Labs', 'ONE product demo', 'Kavitha Selvam'];
const DEV_ONLY = ['pilot-preview'];
const REAL_APP = ['Sign in to your verified ONE', 'CognitoUserPool', 'Choose workspace'];

const [distDir, variant] = process.argv.slice(2);
if (!distDir || (variant !== 'production' && variant !== 'demo')) {
  console.error('usage: check-demo-boundary.mjs <distDir> production|demo');
  process.exit(2);
}

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const text = filesUnder(distDir)
  .filter((path) => /\.(js|css|html|json|webmanifest)$/.test(path))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
if (!text.includes('<div id="root">')) {
  console.error(`check-demo-boundary: ${distDir} does not look like a built web app (no index.html root).`);
  process.exit(2);
}

const failures = [];
const mustLack = (markers, why) => markers.filter((marker) => text.includes(marker)).forEach((marker) => failures.push(`found "${marker}" - ${why}`));
const mustHave = (markers, why) => markers.filter((marker) => !text.includes(marker)).forEach((marker) => failures.push(`missing "${marker}" - ${why}`));

mustLack(DEV_ONLY, 'the development-only preview route must never ship');
if (variant === 'production') {
  mustLack(FICTION, 'the production build must carry no demo or pilot sample data');
  mustHave(REAL_APP.slice(0, 1), 'this does not look like the real application build');
} else {
  mustHave(FICTION, 'the demo build must carry the demo site');
  mustLack(REAL_APP, 'the demo build must not carry the real application or its sign-in');
}

if (failures.length > 0) {
  console.error(`check-demo-boundary (${variant}) FAILED for ${distDir}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`check-demo-boundary (${variant}) passed for ${distDir}.`);
