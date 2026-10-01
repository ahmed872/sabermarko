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

for (const e of entries) await build({ ...common, ...e, ...(watch ? {} : {}) });
