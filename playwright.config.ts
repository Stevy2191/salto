import { defineConfig } from '@playwright/test'

// E2E smoke tests. Runs the real production server (built frontend + API)
// on a throwaway SQLite database. `npx playwright install chromium` once,
// then `npm run test:e2e`.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:3456',
    // Tall enough to hold a 2-hour class window at 5-minute rows without
    // scrolling: the grid is deliberately not compressed to fit, so a short
    // viewport would put half the rows past the fold and out of reach of a
    // pointer drag.
    viewport: { width: 1400, height: 1200 },
  },
  webServer: {
    command: 'bash -c "rm -rf .e2e-data && npm run build && DATA_DIR=.e2e-data PORT=3456 node server/index.ts"',
    url: 'http://localhost:3456/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
