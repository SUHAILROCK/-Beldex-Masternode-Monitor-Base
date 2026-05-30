# Beldex Masternode Monitor — Launch Guide

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18 or later |
| npm | 8 or later |

Install Node.js from https://nodejs.org if not already installed.

---

## Step 1 — Install dependencies

```bash
cd /path/to/Automate
npm install
```

This installs Express, better-sqlite3, helmet, ExcelJS, and all other packages listed in `package.json`.

---

## Step 2 — Create your `.env` file

Copy the example and fill in the required values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# REQUIRED — the dashboard login password. Server refuses to start without this.
ADMIN_PASSWORD=change_this_to_a_strong_password

# Optional — change if port 3000 is taken
PORT=3000

# Optional — set to "production" to add Secure flag to auth cookie (needed behind HTTPS proxy)
NODE_ENV=development

# Optional — separate secret for operator session cookies.
# Defaults to a hash of ADMIN_PASSWORD if not set.
OP_COOKIE_SECRET=another_strong_random_string
```

> **Important:** Never commit `.env` to git. It is already listed in `.gitignore`.

---

## Step 3 — Start the server

**Development (foreground):**
```bash
node server.js
```

**Production (persistent — using pm2):**
```bash
npm install -g pm2
pm2 start server.js --name beldex-monitor
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

You should see:
```
Beldex Monitor running at http://localhost:3000
```

---

## Step 4 — Open the dashboard

Open your browser at:
```
http://localhost:3000
```

Log in with the password you set in `ADMIN_PASSWORD`.

---

## Step 5 — Add your masternodes

1. Go to **Nodes** in the dashboard.
2. Click **Add Node** and paste your masternode pubkey (64-character hex string).
3. Optionally add a label and wallet address for grouping in reports.
4. Repeat for all nodes.

---

## Step 6 — Run your first scan

1. Go to **Scan** in the dashboard.
2. Select a date range (start with the last 7 days to test).
3. Click **Start Scan**.
4. Watch the progress log — it will show found rewards in real time.
5. Once complete, go to **Reports → Daily** or **Monthly** to see earnings.

---

## Step 7 — (Optional) Set up scheduled scans

The dashboard includes a built-in scheduler. Go to **Settings → Scheduler** to configure automatic daily scans.

For daily scans at midnight, you can also use cron:

```bash
# Run a daily scan at 00:10 UTC
10 0 * * * cd /path/to/Automate && node -e "require('./scanner').runDailyScan()" >> logs/scan.log 2>&1
```

---

## Running behind a reverse proxy (HTTPS — recommended for internet access)

If you expose the dashboard to the internet, put it behind nginx or Caddy with HTTPS and set `NODE_ENV=production` in your `.env`.

**nginx example:**
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Backup your data

Download a full database backup from **Settings → Backup DB** in the dashboard.

Or via curl (authenticated):
```bash
curl -b "bdx_auth=<your_auth_token>" http://localhost:3000/api/backup/db -o backup.db
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `[FATAL] ADMIN_PASSWORD not set` | Create `.env` with `ADMIN_PASSWORD=yourpassword` |
| Port already in use | Change `PORT=3001` in `.env` |
| No rewards found after scan | Check internet connection to `explorer.beldex.io` |
| Database error on startup | Delete `beldex_monitor.db` to start fresh (loses history) |
| Scan very slow | Normal — Beldex explorer limits request rate; ~5 blocks/sec is expected |
