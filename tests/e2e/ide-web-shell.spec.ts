import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chromium } from 'playwright-core';

const baseUrl = process.env.IDE_E2E_URL ?? 'http://127.0.0.1:18920/';
const browserPath = process.env.IDE_BROWSER_EXECUTABLE;
const evidenceDir = 'tests/evidence/ide-web-shell';
setDefaultTimeout(30_000);

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error('IDE_WEB_SERVER_NOT_READY');
}

describe('real IDE Web product shell', () => {
  it.skipIf(!browserPath)('renders the baseline entries without startup console errors', async () => {
    const port = new URL(baseUrl).port || '18920';
    const server = Bun.spawn(['bun', 'run', 'dev:web', '--', '--port', port], { stdout: 'ignore', stderr: 'pipe' });
    const consoleErrors: string[] = [];
    try {
      await waitForServer(baseUrl);
      const browser = await chromium.launch({ executablePath: browserPath, headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(error.message));
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      const snapshot = await page.locator('body').innerText();
      await Bun.write(`${evidenceDir}/snapshot.txt`, snapshot);
      await Bun.write(`${evidenceDir}/console.json`, JSON.stringify(consoleErrors, null, 2));
      await Bun.write(`${evidenceDir}/runtime-report.json`, JSON.stringify({ status: 'ready', consoleErrors }, null, 2));
      await page.screenshot({ path: `${evidenceDir}/ide-web-shell.png`, fullPage: true });
      expect(await page.locator('.fx-ob-overlay, .topbar').count()).toBeGreaterThan(0);
      expect(snapshot).not.toContain('PUBLIC GAMEPLAY CARRIER');
      expect(consoleErrors.filter((message) => !message.startsWith('Failed to load resource:'))).toEqual([]);
      await browser.close();
    } finally {
      server.kill();
    }
  });
});
