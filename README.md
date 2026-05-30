# Beldex Masternode Monitor

A self-hosted dashboard for monitoring and tracking Beldex masternode rewards, status, and earnings across multiple wallet groups.

## Features

- **Dashboard** — Live overview with today's rewards, 30-day earnings chart, wallet group summary, and BDX/USD price
- **Node Management** — Add, edit, remove, and bulk-import masternodes across wallet groups with duplicate detection
- **Block Scanning** — Parallel block scanning (5x speed) with cancel/resume, auto-scheduler, and scan history
- **Reports** — Daily, monthly, date-range, wallet-grouped, and matrix (date × wallet pivot) reports
- **Status Check** — Real-time node status monitoring with alert banners
- **Exports** — Excel (.xlsx) and CSV exports for all report types, plus database backup download
- **Streak Tracking** — Per-node consecutive reward day tracking
- **Node Detail** — Click any node to see lifetime stats, reward history, and performance metrics

## Tech Stack

- **Backend:** Node.js + Express.js
- **Database:** SQLite via `better-sqlite3` (WAL mode)
- **Frontend:** Vanilla HTML/CSS/JS (no framework)
- **Reports:** ExcelJS for .xlsx generation
- **Price:** CoinGecko API (free, cached 5 min)

## Setup

```bash
# Install dependencies
npm install

# Start the server
node server.js
```

Open `http://localhost:3000` in your browser.

## Node Data Setup

Create `public/nodes-data.js` with your masternode groups:

```js
const NODE_GROUPS = [
  ["Group Name", "bxc_wallet_address...", [
    "pubkey1_64hex",
    "pubkey2_64hex",
    // ...
  ]],
  // more groups...
];
```

Then use the **Import Groups** button in the Nodes tab to load them.

## Configuration

| File | Purpose |
|------|---------|
| `scheduler_config.json` | Auto-scan scheduler state (auto-created) |
| `beldex_monitor.db` | SQLite database (auto-created on first run) |
| `public/nodes-data.js` | Your node groups for bulk import (you create this) |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/nodes` | List all nodes |
| POST | `/api/nodes` | Add single node |
| POST | `/api/nodes/bulk` | Bulk import nodes |
| PUT | `/api/nodes/:pubkey` | Update node |
| DELETE | `/api/nodes/:pubkey` | Remove node |
| POST | `/api/scan` | Start block scan |
| GET | `/api/scan/progress` | Scan progress |
| POST | `/api/scan/cancel` | Cancel running scan |
| GET | `/api/report/daily` | Daily reward report |
| GET | `/api/report/monthly` | Monthly reward report |
| GET | `/api/report/range` | Date range report |
| GET | `/api/report/grouped` | Wallet group report |
| GET | `/api/report/matrix` | Date × wallet pivot |
| POST | `/api/status/check` | Check all node statuses |
| GET | `/api/price/bdx` | BDX/USD price |
| GET | `/api/export/excel` | Excel download |
| GET | `/api/export/csv` | CSV download |
| GET | `/api/backup/db` | Database backup download |

## License

Private — All rights reserved.
