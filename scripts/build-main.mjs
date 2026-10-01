import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'better-sqlite3'],
  loader: { '.woff2': 'base64' },
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production') },
};

const entries = [
  { entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' },
  { entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js' },
];
if (process.env.BUILD_SAMPLE) entries.push({ entryPoints: ['scripts/sample-invoice.ts'], outfile: 'dist/sample/sample-invoice.js' });
if (process.env.BUILD_TOOLS) entries.push({ entryPoints: ['scripts/seed-demo.ts'], outfile: 'dist/tools/seed-demo.js', external: ['better-sqlite3'] });

if (process.env.BUILD_SIM || process.argv.includes('--sim')) {
  // one-year simulation tools: test-only, written to dist/sim (excluded from every installer)
  for (const n of ['simulate', 'verify', 'restore-tests']) entries.push({ entryPoints: [`scripts/sim/${n}.ts`], outfile: `dist/sim/${n}.js`, external: ['better-sqlite3'] });
}
for (const e of entries) await build({ ...common, ...e, ...(watch ? {} : {}) });
