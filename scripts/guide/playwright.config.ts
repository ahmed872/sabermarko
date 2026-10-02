import { defineConfig } from '@playwright/test';
// Captures the screenshots of the user guide (docs/user-guide). Not part of the test suite.
export default defineConfig({ testDir: '.', testMatch: 'capture.spec.ts', timeout: 600_000, workers: 1, reporter: [['list']], use: { trace: 'off' } });
