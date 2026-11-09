// Builds Firefox MV3 and signs it as an unlisted add-on on AMO.
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET in .env.local (bun loads it automatically).
import { spawnSync } from 'node:child_process';

const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!issuer || !secret) {
  console.error('Missing AMO_JWT_ISSUER / AMO_JWT_SECRET in .env.local');
  process.exit(1);
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('bun', ['run', 'build:firefox']);
run('bunx', [
  'web-ext',
  'sign',
  '--channel=unlisted',
  '--source-dir=.output/firefox-mv3',
  '--artifacts-dir=.output/signed',
  `--api-key=${issuer}`,
  `--api-secret=${secret}`,
]);
console.log('Signed .xpi written to .output/signed/');
