#!/usr/bin/env node
/**
 * Proves the line between the real site and the sandbox in the built files.
 *
 * oneby8.com is built without VITE_SANDBOX and must carry none of the pilot's fictional
 * people and no sandbox marker - CLAUDE.md forbids invented data on screens real users
 * can reach, and the old release script grepped for exactly this leak. demo.oneby8.com
 * (ADR-046) is built with VITE_SANDBOX=true: it must be the real application, carry the
 * "Demo - sample data" marker, and still ship no pilot fiction - its sample people live in
 * its own database, never in the bundle. Both rely on the bundler dropping code behind
 * build-time flags, so the only trustworthy check is the output itself.
 *
 *   node scripts/check-demo-boundary.mjs <distDir> production   # oneby8.com
 *   node scripts/check-demo-boundary.mjs <distDir> sandbox      # demo.oneby8.com
 *
 * Run by deploy/vps/Dockerfile.web after every web build and by CI (phase1-ci.yml).
 * Exits non-zero, naming each failed marker, if the boundary is crossed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ASCII-only markers: the bundler may escape non-ASCII characters in string literals.
const FICTION = ['Meera Nair', 'Arjun Reddy', 'Lakeview Institute', 'Zenvia Labs', 'ONE product demo', 'Kavitha Selvam'];
const DEV_ONLY = ['pilot-preview'];
// The sign-in card's lead line and the workspace chooser's title: present only in the real application.
const REAL_APP = ['Pick up your loop where you left it', 'Choose workspace'];
// The sandbox marker (src/sandboxMarker.tsx) and the header the sandbox sends its token in.
const SANDBOX = ['data-one-sandbox', 'X-One-Authorization'];

const [distDir, variant] = process.argv.slice(2);
if (!distDir || (variant !== 'production' && variant !== 'sandbox')) {
  console.error('usage: check-demo-boundary.mjs <distDir> production|sandbox');
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
mustLack(FICTION, `the ${variant} build must carry no demo or pilot sample data in the bundle`);
mustHave(REAL_APP, 'this does not look like the real application build');
if (variant === 'production') {
  mustLack(SANDBOX, 'the production build must not carry the sandbox marker or send its token as the sandbox does');
} else {
  mustHave(SANDBOX, 'the sandbox build must carry the "Demo - sample data" marker and the sandbox token header');
}

if (failures.length > 0) {
  console.error(`check-demo-boundary (${variant}) FAILED for ${distDir}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`check-demo-boundary (${variant}) passed for ${distDir}.`);
