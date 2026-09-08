# interface e2e smoke checks

Browser-driven smoke checks for the editor-mode UI systems (layout, page
panes, overlays, right-click reference). They固化 the throwaway Playwright
scripts that were used while fixing the layout / left-pane / dropdown
regressions — so those regressions can't silently return.

## Run

The app stack must be running first (these drive the live UI at `:18920`):

```bash
bash start.sh            # in another terminal (server :18900 / UI :18920 / engine :15173)
bun run test:e2e         # from packages/interface  (== node test/e2e/smoke.mjs)
```

Override the URL with `FORGEAX_UI=http://host:port`.

Uses the repo-root hoisted `playwright-core` + a downloaded Chromium. Not wired
into CI (needs a running stack); run locally before/after touching DockShell,
Sidebar, TopBar overlays, or the reference/pill system.

## What it guards

| Check | Regression it catches |
|---|---|
| Edit: Assets not full-width bottom strip | dockview `buildDefault` column-order bug |
| Page: left options pane has height | `.ws-pane-keepalive` CSS 0-height collapse |
| Layout dropdown portalled + on top | overlay covered by chat panel (z-index) |
| Layout dropdown closes on outside-click | mouse-out-close anti-pattern |
| Workspace tab → no global Radix menu | double-menu conflict (ownMenu opt-out) |
| Workspace tab → ws-ctx menu has 引用到 Chat | reference menu wiring |

`WARN` (soft) checks are timing-sensitive under headless (rAF/contenteditable
focus) and don't fail the run; the underlying logic is covered by unit tests
(`bun run test`).

## Unit tests

Pure + happy-dom unit tests live next to their modules and run via `bun test`:

```bash
bun run test             # == bun test src
```

- `src/components/Composer/referenceRegistry.test.ts` — every referenceable unit
  builds the right pill (the contract that used to break silently).
- `src/components/Composer/pill.test.ts` — the ⟦pill:…⟧ sentinel codec round-trip.
