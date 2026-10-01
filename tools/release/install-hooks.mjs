// `npm install` hook: point git at the repository's hooks (.githooks/pre-commit blocks secrets).
// Silent no-op outside a git checkout (e.g. a source tarball).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (existsSync('.git')) {
  try { execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' }); } catch { /* git missing */ }
}
