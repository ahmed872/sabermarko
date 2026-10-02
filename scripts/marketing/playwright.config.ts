import { defineConfig } from '@playwright/test';
// Captures app screenshots for marketing images (docs/marketing). Not part of the test suite.
export default defineConfig({ testDir: '.', testMatch: '*.spec.ts', timeout: 600_000, workers: 1, reporter: [['list']], use: { trace: 'off' } });
