import { defineConfig } from '@playwright/test';

const PORT = 8788;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    // CI machines have no GPU, and the app needs WebGL.
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: `npm run build && npx wrangler dev --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 120000,
    env: { WRANGLER_SEND_METRICS: 'false' },
  },
});
