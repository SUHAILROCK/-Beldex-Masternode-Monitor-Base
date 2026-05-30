# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What This Project Is

A **self-hosted Node.js web dashboard** for monitoring Beldex masternode rewards. It scans the Beldex blockchain explorer API, stores reward data in a local SQLite database, and presents analytics, reports, and node status through a browser UI.

- **Stack:** Node.js (CommonJS), Express 5, better-sqlite3, ExcelJS, Helmet, dotenv
- **Frontend:** Vanilla JS + fetch — no framework
- **Auth:** Single-password login — scrypt hashed (SHA-256 only as legacy fallback), stored as `bdx_auth` HttpOnly cookie
- **Database:** `beldex_monitor.db` (SQLite, WAL mode) — local file, no external DB
- **Default port:** 3000 (configurable via `.env`)

---

## Commands

```bash
# Install dependencies
npm install

# Start the server
npm start
# or: node server.js
# Then open http://localhost:3000

# CLI tool (run outside browser)
node monitor.js add-node <pubkey> <label> <wallet_name> <wallet_address>
node monitor.js scan --date 2024-01-15
node monitor.js report daily
node monitor.js report monthly

# Integration tests (Node 18+ built-in test runner)
npm test
# or: node --test test/integration.test.js

# Smoke test (requires puppeteer devDependency)
node check_dashboard.js
```

---

## Environment

`.env` file is **required** — server crashes with `[FATAL]` if `ADMIN_PASSWORD` is missing:

```env
ADMIN_PASSWORD=your_strong_password
PORT=3000                              # optional, default 3000
NODE_ENV=development                   # set to "production" for Secure cookie flag
OP_COOKIE_SECRET=random_string        # optional, defaults to hash of ADMIN_PASSWORD
```

---

## Architecture

### Request flow
Browser → `server.js` (Express routes + auth middleware) → `db.js` (synchronous SQLite queries) → response

Scan flow: `POST /api/scan` → `scanner.js` (parallel block fetches from explorer API) → `db.js` → SSE progress stream back to browser

### Key files
- **`server.js`** — auth middleware, session management, SSE scan endpoint, bundle serving, memory-cached network stats (60s TTL); registers routes from `routes/`
- **`db.js`** — all SQLite queries; tables: `nodes`, `rewards`, `scan_history`, `status_checks`, `archive_log`; composite indexes on `node_status(pubkey,id)` and `rewards(pubkey,block_height)`
- **`scanner.js`** — fetches `https://explorer.beldex.io/api`; **10 parallel fetches, 50ms batch delay**, 5 retries, saves every 100 blocks
- **`scheduler.js`** — reads/writes `scheduler_config.json` (fields: `enabled`, `intervalHours`, `lastAutoScan`)
- **`lib/auth.js`** — `hashPassword` / `verifyPassword` using scrypt; used by `server.js` and `routes/operators.js`
- **`lib/shared.js`** — shared constants (`MAX_BULK_NODES`, `MAX_REPORT_RANGE_DAYS`, etc.), `sendInternalError`, `isValidDate`, `validateDateRange`, rate limiters
- **`routes/reports.js`** — CSV/Excel export routes; matrix export uses local `csvCell` helper with formula-injection protection
- **`routes/nodes.js`**, **`routes/analytics.js`**, **`routes/database.js`**, **`routes/operators.js`** — modular route handlers registered in `server.js`
- **`public/index.html`** — shell + all tab panels; sidebar uses inline SVG icons (no unicode, no `::before` letter hacks)
- **`public/nodes-data.js`** — pre-loaded node group data; auth-protected even though it's a `.js` file (special case in auth middleware)

### Frontend JS bundle
All frontend JS files are concatenated into a **single `/js/bundle.js`** at server startup and served from memory with ETag caching.

- **Dev mode** (`NODE_ENV=development`): `server.js` watches all JS bundle files with `fs.watch` and auto-rebuilds the bundle on change (120ms debounce). **Restart is not required** — just refresh the browser after saving a JS file. A `[Dev] Bundle rebuilt` message appears in the console.
- **Production mode**: Bundle is built once at startup and never rebuilt. Restart the server after any JS change.
- The browser caches the bundle for 1 hour (`max-age=3600`). If the old version is still loading after a rebuild, do a hard refresh (`Ctrl+Shift+R`).

Bundle order (matters — later files can call functions defined earlier):

| File | Responsibility |
|---|---|
| `public/nodes-data.js` | Pre-loaded node group seed data |
| `public/js/core.js` | Shared helpers: `escHtml`, `fmtBdx`, `shortKey`, `apiJson`, `showToast`, pagination, nav/tab switching, CSRF init |
| `public/js/dashboard.js` | Dashboard stats, earnings chart (daily + monthly), trend badges, live payout tape |
| `public/js/nodes.js` | Nodes tab: render, filter, add/edit/delete, import groups |
| `public/js/scanner.js` | Scan tab: start/cancel/resume scan, SSE progress, explorer status, stuck-scan recovery |
| `public/js/reports.js` | Reports tabs: daily, monthly, range, grouped, per-key, ROI, leaderboard, matrix |
| `public/js/analytics.js` | Analytics tab: heatmap, velocity, anomalies, portfolio intelligence, NHM |
| `public/js/status.js` | Node Status tab: live status checks, queue positions |
| `public/js/database.js` | Database tab: health stats, VACUUM, archive, prune, backfill/gaps, DB backup |
| `public/js/events.js` | **Loaded last** — wires all DOM event listeners; replaces all inline `onclick`/`oninput`/`onchange` |

### Frontend SPA
`index.html` holds all tab panels in the DOM. Tab switching toggles `.active` on `.tab-content` divs. Sidebar state (expanded/collapsed) saved in `localStorage`.

### Event handling — CSP-safe delegation
**No inline `onclick`/`oninput`/`onchange` attributes anywhere.** All static listeners are registered in `events.js`. Dynamically generated buttons (inside `innerHTML`) must use `data-action="<name>"` and be handled in `handleGeneratedClick` / `handleGeneratedInput` / `handleGeneratedChange` in `events.js`. Adding a new generated action = add a `data-action` attribute + a new `if (action === '...')` branch in the appropriate handler.

### Reports
8 sub-tabs under `/api/reports/*`: daily, monthly, range, grouped (by wallet), matrix (date × wallet pivot), perkey, roi, leaderboard. All support Export to Excel / CSV via ExcelJS.

All report API calls append `&tz=${_rTz()}` — UTC or IST (+5:30) toggle stored in `localStorage('report-tz')`. IST uses `block_timestamp + 19800` in SQL instead of `reward_date`.

### Matrix report internals
- **Sticky headers use JS `translate3d` transforms**, not CSS `position:sticky` — `border-collapse:separate` breaks CSS sticky. `_matrixScrollWrap` + `_matrixScrollHandler` are module-level refs that get cleaned up on every re-render.
- **Column visibility:** `visibleWallets` is filtered by `_matrixFilterGroup` (exact wallet name match) AND `_matrixFilterWallet` (substring). Both are applied in `_renderMatrix()` before any row filtering.
- **Row filters** (`Reward days only`, `Min BDX`) operate on `visibleWallets` totals only — not the all-wallet `groupDayTotal`. This means filters respect the active column filter.
- **`_escHtml` was removed** — always use the global `escHtml()` from `core.js` everywhere in `reports.js`.

### Analytics
`/api/analytics/*` endpoints: `heatmap`, `velocity`, `anomalies`, `network-history`, `top-earners`, `uptime-summary`, `network-overdue`, `hub-leaderboard`, portfolio intelligence, node health matrix.

### Node detail slide panel (`showNodeDetail`)
Side-drawer (`#nd-drawer`) shows node stats. Current layout: status bar (Active pill only), hero BDX value, insights grid (3 cards: Latest Block, Best Reward, 30D Active Days), stats strip, 30-day chart.
- **Queue position, arc gauge donut, and NEXT WATCH insight card have been removed** — do not re-add them.
- Status bar shows only `<span class="nd-status-pill nd-active">● Active</span>` — no queue or last-reward text.
- Arc gauge (`#nd-arc-wrap`) is hidden via `display: none` in CSS. Insights grid is `repeat(3, minmax(0, 1fr))`.

### Silent panel (daily report)
The daily report has a toggle panel showing nodes that earned no reward on a given date. Key facts:
- The panel div (`#daily-silent-panel`) is placed **between** the summary cards and the reward table (`#daily-pag-wrap`) in the DOM.
- Triggered by clicking the red "silent" count card (`data-action="show-silent"`) — handled in `handleGeneratedClick` in `events.js`.
- Uses `pagInit` for pagination (25 nodes per page). The pag ID is `daily-silent`.
- `_silentCache[pagId]` stores the silent node list; populated when the daily report loads.

---

## Key Behaviour Notes

- **Governance payouts:** Every 5040 blocks, one MN gets ~18,900 BDX treasury payout. Scanner detects this (>100 BDX threshold) and normalises to 6.25 BDX.
- **Queue ordering:** Deterministic — sorted by `last_reward_block_height` ASC. Position #1 wins next block.
- **Rate limits:** Scanner expects ~5 blocks/sec from the explorer. Large date ranges are slow by design.
- **`--teal` CSS variable** is actually violet (`#8B5CF6`) — naming quirk from early dev. Do not rename without updating all references.

### Scanner internals (server.js + scanner.js)
- `scanBlocksForRewards` fires the **progress callback before the save callback** at each batch boundary — this ensures `activeScan.progress` is current when the save callback reads it to compute the resume height.
- Resume height stored as `startH + activeScan.progress - 1` (last completed block, not the count). On resume, `server.js` adds `+1` to get the first unscanned block.
- On cancel, the scanner does **not** fire `progressCallback(total, total)` — `activeScan.progress` stays at the real scanned count, so the UI never falsely shows 100%.
- Cancel check is `() => !activeScan || activeScan.cancelled` — a null `activeScan` (force-reset) counts as cancelled and stops the loop immediately.
- `force-reset` sets `activeScan.cancelled = true` and `activeScan.running = false` before nulling `activeScan` — prevents the background worker from throwing on a null dereference.
- All three scanner callbacks (progress, cancel, save) plus post-scan code have null guards for `activeScan`.

---

## Design System — "Obsidian Plasma"

All dark theme — no light mode. Fonts: `Outfit` (UI) and `JetBrains Mono` (data/code) from Google Fonts.

| Variable | Value | Use |
|---|---|---|
| `--bg` | `#06060A` | Page background |
| `--card` | `#0C0B15` | Card backgrounds |
| `--border` | `#1C1A2E` | Default borders |
| `--teal` | `#8B5CF6` | Primary accent (violet) |
| `--amber` | `#F59E0B` | Warning / secondary |
| `--blue` | `#06B6D4` | Info / cyan |
| `--red` | `#EF4444` | Danger |
| `--green` | `#10B981` | Success |
| `--text` | `#EEF0FA` | Primary text |
| `--text2` | `#A4AECB` | Secondary text |
| `--muted` | `#58607C` | Muted/disabled |

Layout: sidebar 220px expanded / 60px collapsed; cards border-radius 11px; topbar sticky.

### Sidebar
- Nav icons are **inline SVGs** inside `.nav-icon` spans — do not use unicode characters or CSS `::before` letter hacks.
- `.nav-icon svg` styled at 15px (17px in collapsed state) with `stroke: currentColor`.
- Logout button: `<svg>` + `<span class="logout-label">Logout</span>`. In collapsed state `.logout-label` is hidden via CSS (`display: none`) — do not use `font-size: 0` or `::before` content hacks.
- `.network-status` is `display: none` in collapsed state — do not just hide the text while leaving the container visible (causes a floating dot artefact).

### Database health card (`.dbh-*` classes)
The database tab's detailed stats card uses a `.dbh-*` design system defined in `style.css`:
- Health pill: `.dbh-health-pill` + `.dbh-health-ok` / `.dbh-health-warn`
- Metrics row: `.dbh-metrics-row` → `.dbh-metric` cards (add `.dbh-metric-warn` for problems)
- Tables grid: `.dbh-tables-section` → `.dbh-tables-grid` → `.dbh-tbl-row` (`.dbh-tbl-high` / `.dbh-tbl-med` for elevated counts)
- WAL warn threshold: **50 MB** (not 5 MB — normal SQLite WAL is several MB). Fragmentation warn: **20%**.

### Analytics layout
Analytics tab uses a CSS grid (`.analytics-redesign`). Full-width sections need `grid-column: 1 / -1`. Currently full-width: `#lowperf-section`, `#nhm-section`, and any section that would look cramped at half-width.

### Reports redesign context (`.reports-redesign`)
The reports tab wrapper has class `.reports-redesign` which sets CSS variables `--rep-mint`, `--rep-cyan`, `--rep-gold` and overrides base component styles. When debugging visual issues inside reports, check whether base styles (e.g., `overflow: hidden`, `border-radius`, `::before`/`::after` pseudo-elements) from non-redesign selectors are leaking through and need explicit resets in the `.reports-redesign` context.

### Database page layout
Database tab uses `.database-redesign` grid. Cards that span full width (to avoid unequal-height gaps): `#db-retention-card`, `#db-health-page-card`.

---

## CSS & Layout Rules

- Prefer **flexbox or grid** for layout fixes — do not use `zoom`, `transform` hacks, or `aspect-ratio` workarounds.
- Before touching positioning or overflow, identify which element is the actual source (not just the visible symptom).
- If a CSS fix doesn't work, revert it fully before trying a different approach — do not stack patches.

---

## Debugging Rules

- Re-read the relevant file(s) fresh before each fix attempt — do not assume the problem from memory.
- State the **root cause** before making any change. If you can't identify it, say so.
- Make the minimal change that addresses the root cause. Do not touch surrounding code.

---

## Security Rules

- **Always escape user-controlled strings before inserting into `innerHTML`** — use `escHtml()` for node labels, wallet names, wallet addresses, pubkeys, and any other DB-sourced string. `escHtml` is defined in `public/js/core.js` and available globally.
- Numeric values (`reward_count`, BDX amounts from `fmtBdx()`) are safe to insert directly.
- **CSV exports:** Use the `escape` helper (or a local `csvCell` helper for the matrix branch) for all cells. The helper must handle commas, double-quotes, newlines, and **formula injection** — values starting with `=`, `+`, `-`, `@`, or `\t` must be double-quoted so Excel/LibreOffice cannot interpret them as formulas.
- **Trust proxy:** `server.js` reads `TRUST_PROXY` env var at startup and calls `app.set('trust proxy', ...)` — required for correct rate-limit IP detection behind Nginx. Set `TRUST_PROXY=1` in `.env` on VPS.
- **`OP_COOKIE_SECRET`:** If not set, exits in production (`[FATAL]`), warns in dev. Always set a separate random value in `.env` before VPS launch.

---

## Copy Button Pattern

All copy buttons use **CSS `::after` pseudo-elements** for label text — do NOT set `btn.textContent`:
- Button has `font-size: 0` so the element text is invisible
- `::after { content: 'Copy' }` shows the label
- `.copied::after { content: '✓' }` shows feedback
- `copyToClipboard()` in `core.js` only toggles the `.copied` class — it never touches `textContent`

Every section that has copy buttons must have both `::after` and `.copied::after` rules in `style.css`.

## Danger Modal Pattern

Destructive DB operations (Archive, Prune) use overlay modals requiring the user to type `DELETE` before proceeding — not `confirm()`. The modal pattern:
- Overlay shown via `overlay.style.display = 'flex'`
- All listeners (input, click, keydown ESC, overlay-click) registered with named functions and cleaned up in a single `cleanup()` — no anonymous listeners left dangling
- `proceedBtn.disabled = true` until input value === `'DELETE'`

---

## General Rules

- Fix only what was asked. Do not refactor, rename, or "clean up" adjacent code unless explicitly requested.
- Do not add comments, docstrings, or logging to code you didn't change.
- Do not introduce new abstractions or helpers for one-off operations.
