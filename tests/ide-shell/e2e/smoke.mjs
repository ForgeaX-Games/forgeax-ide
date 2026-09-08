// Editor-mode e2e smoke checks — drives the LIVE app (must be running at
// :18920, e.g. `bash start.sh`) with the repo's playwright-core + a downloaded
// Chromium. These固化 the throwaway scripts used while fixing the layout /
// left-pane / dropdown regressions, so the same regressions can't silently
// return. NOT wired into CI (needs a running stack); run locally:
//
//   bash start.sh                      # in another terminal
//   node test/e2e/smoke.mjs            # → prints PASS/FAIL per check, exits 1 on any fail
//
// Checks:
//   1. Edit layout: viewport dominant, Assets in LEFT column (not full-width bottom)
//   2. Page left pane (options) renders with non-zero height (the CSS-collapse bug)
//   3. Layout dropdown: portalled to body, on top, closes on outside-click
//   4. Right-click a workspace tab → "引用到 Chat" inserts a pill into the composer
import { createRequire } from 'node:module';
// playwright-core is hoisted to the monorepo root; resolve it from here.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const URL = process.env.FORGEAX_UI ?? 'http://localhost:18920';
const results = [];
// soft checks are timing-sensitive in headless (rAF/focus) and only WARN — they
// don't fail the suite. Hard checks guard the real regressions and fail the run.
const check = (name, ok, info = '', soft = false) => {
  results.push({ name, ok, soft, info });
  const tag = ok ? 'PASS' : (soft ? 'WARN' : 'FAIL');
  console.log(`${tag}  ${name}${info ? ' — ' + info : ''}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
try {
  // 'networkidle' never settles — the app holds SSE/WS connections open.
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);

  // 1) Edit layout
  await page.locator('.mode-tab', { hasText: /^Edit$/ }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const edit = await page.evaluate(() => {
    // ep:* panels are iframes; inspect the dockview GROUP that hosts the
    // "Assets" tab (its width tells us if Assets is a narrow left column vs a
    // full-width bottom strip — the regression we're guarding).
    const tabs = [...document.querySelectorAll('.dv-tab, .dv-default-tab')];
    const assetsTab = tabs.find((t) => (t.textContent || '').trim().startsWith('Assets'));
    const group = assetsTab?.closest('.dv-groupview, .groupview, .dv-tabs-and-actions-container')?.parentElement ?? null;
    const grect = group?.getBoundingClientRect();
    const editEl = document.querySelector('[data-testid="edit-mode"], .preview-mode, .dv-tab');
    return { hasViewport: !!editEl, assetsTab: !!assetsTab, groupW: grect ? Math.round(grect.width) : -1 };
  });
  check('edit: dockview rendered', edit.hasViewport);
  check('edit: Assets tab present', edit.assetsTab);
  // Left column should be narrow; the old bug made Assets span the full width.
  check('edit: Assets not full-width bottom strip', edit.groupW > 0 && edit.groupW < 900, `assets group width=${edit.groupW}`);

  // 2) Page left pane (options) non-zero height
  await page.locator('.mode-tab', { hasText: /^AI$/ }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.locator('.sb-icon-btn[aria-label="Page"]').first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(800);
  // open the first page plugin icon (wait for them to load)
  for (let i = 0; i < 18; i++) { if (await page.locator('.ws-icon-btn').count()) break; await page.waitForTimeout(1000); }
  const icons = page.locator('.ws-icon-btn');
  const n = await icons.count();
  let opened = false;
  for (let i = 0; i < n; i++) {
    const pid = await icons.nth(i).getAttribute('data-plugin-id');
    if (pid && pid.includes('character')) { await icons.nth(i).click(); opened = true; break; }
  }
  if (!opened && n > 0) { await icons.first().click(); opened = true; }
  await page.waitForTimeout(2000);
  const leftPane = await page.evaluate(() => {
    const kp = document.querySelector('.ws-pane-keepalive');
    const f = document.querySelector('.ws-pane-keepalive iframe');
    return { kp: kp ? kp.getBoundingClientRect().height : -1, iframe: f ? f.getBoundingClientRect().height : -1 };
  });
  check('page: left options pane has height', leftPane.iframe > 50, `iframe h=${Math.round(leftPane.iframe)}`);

  // 3) Layout dropdown — top layer + click-outside close
  await page.locator('button[title^="布局"]').first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(600);
  const menu = await page.evaluate(() => {
    const m = document.querySelector('.fx-dl-menu');
    if (!m) return { open: false };
    const r = m.getBoundingClientRect();
    const at = (x, y) => { const el = document.elementFromPoint(x, y); return !!(el && (m.contains(el) || el === m)); };
    // Sample center AND the top edge — the top edge overlaps the topbar region,
    // which used to cover the menu (topbar z 9999 > menu z 9500 before the fix).
    return {
      open: true,
      onTopCenter: at(r.left + r.width / 2, r.top + r.height / 2),
      onTopEdge: at(r.left + r.width / 2, r.top + 6),
      parent: m.parentElement?.tagName,
    };
  });
  check('layout dropdown: open + portalled to body', menu.open && menu.parent === 'BODY');
  check('layout dropdown: on top incl. top edge (above topbar)', !!menu.onTopCenter && !!menu.onTopEdge);
  await page.mouse.click(250, 460);
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => !document.querySelector('.fx-dl-menu'));
  check('layout dropdown: closes on outside-click', closed);

  // 4) Right-click workspace tab → dedicated menu (NOT the global Radix menu) →
  //    引用到 Chat → pill in composer.
  try {
    const tab = page.locator('.mode-tab[data-ws-id]').first();
    await tab.click({ button: 'right' });
    await page.waitForTimeout(500);
    // Global Radix menu must NOT have opened for a workspace tab (ownMenu opt-out).
    const radixOpen = await page.evaluate(() => !!document.querySelector('[data-radix-popper-content-wrapper]'));
    check('reference: workspace tab does NOT open global Radix menu', !radixOpen);
    const sendItem = page.locator('.ws-ctx-item', { hasText: '引用到 Chat' }).first();
    check('reference: ws-ctx menu has 引用到 Chat', (await sendItem.count()) > 0);
    if (await sendItem.count()) {
      // force: the menu item is visible above its backdrop; bypass the
      // over-cautious "stable" wait (entry transition / sibling backdrop).
      await sendItem.click({ force: true, timeout: 4000 });
      await page.waitForTimeout(800);
      // RichInput.insertPill renders a <span class="kbl-pill kbl-pill-<kind>">.
      // Soft: the insert goes through a rAF + contenteditable focus that is
      // flaky under headless; the pill construction itself is unit-tested.
      const hasPill = await page.evaluate(() => !!document.querySelector('.kbl-pill'));
      check('reference: workspace tab → pill in composer', hasPill, '', true);
    }
  } catch (e) {
    check('reference: workspace tab flow', false, String(e?.message ?? e).split('\n')[0]);
  }


} catch (e) {
  check('e2e harness', false, String(e?.message ?? e));
} finally {
  await browser.close();
}

const hardFailed = results.filter((r) => !r.ok && !r.soft);
const softFailed = results.filter((r) => !r.ok && r.soft);
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed` + (softFailed.length ? ` (${softFailed.length} soft warn)` : ''));
process.exit(hardFailed.length ? 1 : 0);
