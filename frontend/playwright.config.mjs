import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
  testDir: './tests', testMatch: '*.spec.mjs', workers: 1, fullyParallel: false, timeout: 45000,
  outputDir: '../_migration/browser-results', reporter: [['list']],
  use: { viewport: { width: 1440, height: 950 }, headless: true,
    launchOptions: process.env.STRUCTBOARD_BROWSER_EXE ? { executablePath: process.env.STRUCTBOARD_BROWSER_EXE }
      : existsSync(edge) ? { executablePath: edge } : {} },
});
