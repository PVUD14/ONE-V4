/**
 * `bake-off:build-set` — regenerate deploy/ai-pod/bake-off/eval-set-v1.json from the packs and the
 * prompt registry (ENG-21). Run after a prompt version or a pack changes; the drift test fails until
 * the committed file matches. Prints the case count and the file's SHA-256.
 */
import { writeFileSync } from 'node:fs';
import { committedSetPath, repositoryEvaluationSet } from '../repository.js';

const { set, text, sha256 } = repositoryEvaluationSet();
writeFileSync(committedSetPath, text, 'utf8');
console.log(JSON.stringify({ event: 'ai.bake_off.set_built', setKey: set.setKey, setVersion: set.setVersion, cases: set.cases.length, sha256 }));
