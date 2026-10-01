// Release gate run by the GitHub release workflow (and locally before tagging):
//   1. the tag matches package.json version
//   2. CHANGELOG.md has a section for this version
//   3. the app does NOT embed a development license key (unless ALLOW_DEV_LICENSE_KEY=1 for a test pre-release)
//   4. no secrets are tracked in git
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { embeddedPublicKeyPem, fingerprint } from '../license/common.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const errors = [];
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : process.argv[2] || '';
if (tag && tag !== `v${pkg.version}`) errors.push(`tag ${tag} does not match package.json version v${pkg.version}`);
const changelog = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : '';
if (!changelog.includes(`## [${pkg.version}]`)) errors.push(`CHANGELOG.md has no "## [${pkg.version}]" section`);
const fp = fingerprint(embeddedPublicKeyPem());
const dev = JSON.parse(readFileSync('tools/release/dev-keys.json', 'utf8')).fingerprints;
if (dev.includes(fp)) {
  if (process.env.ALLOW_DEV_LICENSE_KEY === '1') console.warn(`WARNING: building with the DEVELOPMENT license key ${fp} (allowed for a test pre-release only).`);
  else errors.push(`the app embeds the DEVELOPMENT license key (${fp}). Add your key as the repository secret SBM_LICENSE_PRIVATE_KEY (Settings → Secrets and variables → Actions; create it with tools/license/license-tool.html), or run "npm run license:keygen" and commit src/main/license/public-key.ts, then tag again.`);
}
try { execFileSync('node', ['tools/release/scan-secrets.mjs'], { stdio: 'inherit' }); } catch { errors.push('secret scan failed'); }
if (errors.length) { console.error('RELEASE GATE FAILED:\n' + errors.map((e) => ` - ${e}`).join('\n')); process.exit(1); }
console.log(`release gate passed: v${pkg.version}, license key ${fp}`);
