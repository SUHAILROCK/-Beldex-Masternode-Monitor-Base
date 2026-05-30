/**
 * Beldex Masternode Monitor - Database Module
 * SQLite database for storing masternodes, rewards, and status snapshots.
 */

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.BDX_DB_PATH || path.join(__dirname, "beldex_monitor.db");
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
  }
  return db;
}

function initDb() {
  const conn = getDb();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS masternodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT UNIQUE NOT NULL,
      label TEXT,
      wallet_name TEXT,
      wallet_address TEXT,
      added_date TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT NOT NULL,
      block_height INTEGER NOT NULL,
      reward_amount REAL NOT NULL,
      block_timestamp INTEGER NOT NULL,
      reward_date TEXT NOT NULL,
      UNIQUE(pubkey, block_height)
    );

    CREATE TABLE IF NOT EXISTS node_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      last_uptime_proof TEXT,
      version TEXT,
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scan_progress (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scanned_height INTEGER NOT NULL,
      last_scan_time TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_type TEXT NOT NULL,
      date_from TEXT,
      date_to TEXT,
      start_height INTEGER,
      end_height INTEGER,
      rewards_found INTEGER DEFAULT 0,
      duration_seconds INTEGER DEFAULT 0,
      scanned_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rewards_pubkey ON rewards(pubkey);
    CREATE INDEX IF NOT EXISTS idx_rewards_date ON rewards(reward_date);
    CREATE INDEX IF NOT EXISTS idx_rewards_height ON rewards(block_height);
    CREATE INDEX IF NOT EXISTS idx_rewards_pubkey_date ON rewards(pubkey, reward_date);
    CREATE INDEX IF NOT EXISTS idx_rewards_date_pubkey ON rewards(reward_date, pubkey);
    CREATE INDEX IF NOT EXISTS idx_rewards_pubkey_height ON rewards(pubkey, block_height);
    CREATE INDEX IF NOT EXISTS idx_node_status_pubkey ON node_status(pubkey);
    CREATE INDEX IF NOT EXISTS idx_node_status_checked_at ON node_status(checked_at);
    CREATE INDEX IF NOT EXISTS idx_node_status_pubkey_id ON node_status(pubkey, id);

    CREATE TABLE IF NOT EXISTS price_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at INTEGER NOT NULL,
      bdx_usd REAL,
      bdx_inr REAL
    );

    CREATE TABLE IF NOT EXISTS network_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at INTEGER NOT NULL,
      total_masternodes INTEGER,
      active_masternodes INTEGER
    );

    CREATE TABLE IF NOT EXISTS uptime_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT NOT NULL,
      recorded_date TEXT NOT NULL,
      status TEXT NOT NULL,
      proof_age_hours REAL,
      checked_at INTEGER NOT NULL,
      UNIQUE(pubkey, recorded_date)
    );

    CREATE TABLE IF NOT EXISTS backfill_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT NOT NULL,
      gap_from TEXT NOT NULL,
      gap_to TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      found_rewards INTEGER DEFAULT 0,
      detected_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      hub_access TEXT DEFAULT '[]',
      is_admin INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS archive_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      archived_at INTEGER NOT NULL,
      table_name TEXT NOT NULL,
      rows_archived INTEGER NOT NULL,
      archive_path TEXT,
      date_range TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_uptime_pubkey_date ON uptime_history(pubkey, recorded_date);
    CREATE INDEX IF NOT EXISTS idx_backfill_status ON backfill_gaps(status);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migration: collapse node_status to one row per node (upsert model).
  // Keep only the latest row per pubkey, then add a UNIQUE constraint via table rebuild.
  try {
    conn.exec(`
      DELETE FROM node_status WHERE id NOT IN (
        SELECT MAX(id) FROM node_status GROUP BY pubkey
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_node_status_pubkey_unique ON node_status(pubkey);
    `);
  } catch (e) {
    if (!e.message.includes('duplicate column name') && !e.message.includes('already exists')) throw e;
  }

  // Migration: add is_governance column. The backfill only runs the first time
  // (when ALTER TABLE succeeds). On subsequent starts the catch skips it entirely,
  // avoiding a full-table scan and protecting data if the threshold ever changes.
  try {
    conn.exec("ALTER TABLE rewards ADD COLUMN is_governance INTEGER DEFAULT 0");
    // First-time backfill: fix existing records that were stored with the full
    // ~18,900 BDX governance lump sum. The MN winner only earns 6.25 BDX —
    // the rest is protocol treasury.
    conn.exec("UPDATE rewards SET reward_amount = 6.25, is_governance = 1 WHERE reward_amount > 100");
  } catch (e) {
    if (!e.message.includes('duplicate column name') && !e.message.includes('already exists')) throw e;
  }

  // Drop queue_positions table if it still exists (feature removed)
  try { conn.exec("DROP TABLE IF EXISTS queue_positions"); } catch (e) {
    if (!e.message.includes('duplicate column name') && !e.message.includes('already exists')) throw e;
  }

  // Migration: add scan context columns to scan_progress for resume validation
  for (const col of ["start_height INTEGER", "end_height INTEGER", "scan_type TEXT", "date_from TEXT", "date_to TEXT"]) {
    try { conn.exec(`ALTER TABLE scan_progress ADD COLUMN ${col}`); } catch (e) {
      if (!e.message.includes('duplicate column name') && !e.message.includes('already exists')) throw e;
    }
  }

  // Migration: add missed_blocks column to scan_history for data quality tracking
  try { conn.exec("ALTER TABLE scan_history ADD COLUMN missed_blocks INTEGER DEFAULT 0"); } catch (e) {
    if (!e.message.includes('duplicate column name') && !e.message.includes('already exists')) throw e;
  }

  // Keep query planner statistics fresh so compound indexes are used
  conn.pragma("optimize");
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// --- Masternode CRUD ---

function addNode(pubkey, label = null, walletName = null, walletAddress = null) {
  const conn = getDb();
  try {
    conn
      .prepare("INSERT INTO masternodes (pubkey, label, wallet_name, wallet_address, added_date) VALUES (?, ?, ?, ?, ?)")
      .run(pubkey.trim(), label, walletName, walletAddress, new Date().toISOString().slice(0, 19).replace("T", " "));
    return true;
  } catch (e) {
    if (e.message.includes("UNIQUE")) return false;
    throw e;
  }
}

function updateNode(pubkey, label, walletName, walletAddress) {
  const conn = getDb();
  const result = conn.prepare(
    "UPDATE masternodes SET label = ?, wallet_name = ?, wallet_address = ? WHERE pubkey = ?"
  ).run(label, walletName, walletAddress, pubkey.trim());
  return result.changes > 0;
}

function removeNode(pubkey) {
  const conn = getDb();
  const result = conn.prepare("DELETE FROM masternodes WHERE pubkey = ?").run(pubkey.trim());
  return result.changes > 0;
}

function removeAllNodes() {
  const result = getDb().prepare("DELETE FROM masternodes").run();
  return result.changes;
}

function bulkAddNodes(nodes) {
  const conn = getDb();
  const stmt = conn.prepare(
    "INSERT OR IGNORE INTO masternodes (pubkey, label, wallet_name, wallet_address, added_date) VALUES (?, ?, ?, ?, ?)"
  );
  const checkStmt = conn.prepare("SELECT wallet_name FROM masternodes WHERE pubkey = ?");
  let added = 0, skipped = 0;
  const conflicts = [];
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const tx = conn.transaction((list) => {
    for (const n of list) {
      const result = stmt.run(n.pubkey, n.label || null, n.walletName || null, n.walletAddress || null, now);
      if (result.changes > 0) {
        added++;
      } else {
        skipped++;
        const existing = checkStmt.get(n.pubkey);
        if (existing && existing.wallet_name && existing.wallet_name !== n.walletName) {
          conflicts.push({ pubkey: n.pubkey, incomingWallet: n.walletName, existingWallet: existing.wallet_name });
        }
      }
    }
  });
  tx(nodes);
  return { added, skipped, conflicts };
}

function getAllNodes() {
  return getDb()
    .prepare("SELECT * FROM masternodes WHERE active = 1 ORDER BY id")
    .all();
}

function getNodeByPubkey(pubkey) {
  return getDb()
    .prepare("SELECT * FROM masternodes WHERE pubkey = ?")
    .get(pubkey.trim());
}

function getNodeCount() {
  return getDb()
    .prepare("SELECT COUNT(*) as count FROM masternodes WHERE active = 1")
    .get().count;
}

// --- Rewards ---

function insertRewardsBatch(rewardsList) {
  const conn = getDb();
  const stmt = conn.prepare(
    "INSERT OR IGNORE INTO rewards (pubkey, block_height, reward_amount, block_timestamp, reward_date, is_governance) VALUES (?, ?, ?, ?, ?, ?)"
  );
  let inserted = 0;
  const tx = conn.transaction((rewards) => {
    for (const r of rewards) {
      const result = stmt.run(r.pubkey, r.block_height, r.reward_amount, r.block_timestamp, r.reward_date, r.is_governance || 0);
      if (result.changes > 0) inserted++;
    }
  });
  tx(rewardsList);
  return inserted;
}

const ALLOWED_ALIASES = new Set(['r', 'rw', 'n']);
function _tzDateCol(alias, tz) {
  if (!ALLOWED_ALIASES.has(alias)) alias = 'r';
  if (tz !== 'ist' && tz !== 'utc') tz = 'utc';
  return tz === 'ist'
    ? `strftime('%Y-%m-%d', ${alias}.block_timestamp + 19800, 'unixepoch')`
    : `${alias}.reward_date`;
}

function getExistingBlockHeightsForNodes(pubkeys, blockHeights = null) {
  if (!pubkeys || !pubkeys.length) return new Set();
  const CHUNK = 999;
  const conn = getDb();
  const result = new Set();
  const useHeightFilter = Array.isArray(blockHeights) && blockHeights.length > 0;
  for (let i = 0; i < pubkeys.length; i += CHUNK) {
    const pkChunk = pubkeys.slice(i, i + CHUNK);
    const pkPlaceholders = pkChunk.map(() => '?').join(',');
    if (useHeightFilter) {
      for (let j = 0; j < blockHeights.length; j += CHUNK) {
        const hChunk = blockHeights.slice(j, j + CHUNK);
        const hPlaceholders = hChunk.map(() => '?').join(',');
        const rows = conn
          .prepare(`SELECT DISTINCT block_height FROM rewards WHERE pubkey IN (${pkPlaceholders}) AND block_height IN (${hPlaceholders})`)
          .all(...pkChunk, ...hChunk);
        for (const r of rows) result.add(r.block_height);
      }
    } else {
      const rows = conn
        .prepare(`SELECT DISTINCT block_height FROM rewards WHERE pubkey IN (${pkPlaceholders})`)
        .all(...pkChunk);
      for (const r of rows) result.add(r.block_height);
    }
  }
  return result;
}

function getDailySummary(targetDate, tz = 'utc') {
  const dateCol = _tzDateCol('r', tz);
  return getDb()
    .prepare(
      `SELECT r.pubkey, m.label, m.wallet_name, m.wallet_address,
              COUNT(*) as reward_count,
              SUM(r.reward_amount) as total_amount, MAX(r.reward_amount) as max_amount,
              COALESCE(SUM(r.is_governance), 0) as governance_count,
              GROUP_CONCAT(r.block_height) as block_heights
       FROM rewards r
       LEFT JOIN masternodes m ON r.pubkey = m.pubkey
       WHERE ${dateCol} = ?
       GROUP BY r.pubkey ORDER BY reward_count DESC`
    )
    .all(targetDate);
}

function getMonthlySummary(year, month, tz = 'utc') {
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}`;
  if (tz === 'ist') {
    return getDb()
      .prepare(
        `SELECT r.pubkey, m.label, m.wallet_name, m.wallet_address,
                COUNT(*) as reward_count,
                SUM(r.reward_amount) as total_amount, MAX(r.reward_amount) as max_amount,
                COALESCE(SUM(r.is_governance), 0) as governance_count
         FROM rewards r
         LEFT JOIN masternodes m ON r.pubkey = m.pubkey
         WHERE strftime('%Y-%m', r.block_timestamp + 19800, 'unixepoch') = ?
         GROUP BY r.pubkey ORDER BY total_amount DESC`
      )
      .all(monthPrefix);
  }
  return getDb()
    .prepare(
      `SELECT r.pubkey, m.label, m.wallet_name, m.wallet_address,
              COUNT(*) as reward_count,
              SUM(r.reward_amount) as total_amount, MAX(r.reward_amount) as max_amount,
              COALESCE(SUM(r.is_governance), 0) as governance_count
       FROM rewards r
       LEFT JOIN masternodes m ON r.pubkey = m.pubkey
       WHERE r.reward_date LIKE ?
       GROUP BY r.pubkey ORDER BY total_amount DESC`
    )
    .all(`${monthPrefix}%`);
}

function getMonthlyRewards(year, month, tz = 'utc') {
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}`;
  if (tz === 'ist') {
    return getDb()
      .prepare(
        `SELECT r.*, m.label FROM rewards r
         LEFT JOIN masternodes m ON r.pubkey = m.pubkey
         WHERE strftime('%Y-%m', r.block_timestamp + 19800, 'unixepoch') = ?
         ORDER BY r.block_height`
      )
      .all(monthPrefix);
  }
  return getDb()
    .prepare(
      `SELECT r.*, m.label FROM rewards r
       LEFT JOIN masternodes m ON r.pubkey = m.pubkey
       WHERE r.reward_date LIKE ?
       ORDER BY r.block_height`
    )
    .all(`${monthPrefix}%`);
}

function getDateRangeSummary(fromDate, toDate, tz = 'utc') {
  const dateCol = _tzDateCol('r', tz);
  return getDb()
    .prepare(
      `SELECT r.pubkey, m.label, m.wallet_name, m.wallet_address,
              COUNT(*) as reward_count,
              SUM(r.reward_amount) as total_amount, MAX(r.reward_amount) as max_amount,
              COALESCE(SUM(r.is_governance), 0) as governance_count
       FROM rewards r
       LEFT JOIN masternodes m ON r.pubkey = m.pubkey
       WHERE ${dateCol} >= ? AND ${dateCol} <= ?
       GROUP BY r.pubkey ORDER BY total_amount DESC`
    )
    .all(fromDate, toDate);
}

function getPerKeyReport(fromDate, toDate, tz = 'utc') {
  const dateCol = _tzDateCol('r', tz);
  const lastDateExpr = tz === 'ist'
    ? `strftime('%Y-%m-%d', MAX(r.block_timestamp) + 19800, 'unixepoch')`
    : `COALESCE(NULLIF(MAX(r.reward_date), ''), strftime('%Y-%m-%d', datetime(MAX(r.block_timestamp), 'unixepoch')), '')`;
  // Fallback: all-time last reward for nodes silent in the selected range
  const histLastExpr = tz === 'ist'
    ? `strftime('%Y-%m-%d', rh.hist_last_ts + 19800, 'unixepoch')`
    : `COALESCE(NULLIF(rh.hist_last_date, ''), strftime('%Y-%m-%d', datetime(rh.hist_last_ts, 'unixepoch')), '')`;
  const firstDateExpr = tz === 'ist'
    ? `strftime('%Y-%m-%d', MIN(r.block_timestamp) + 19800, 'unixepoch')`
    : `COALESCE(NULLIF(MIN(r.reward_date), ''), strftime('%Y-%m-%d', datetime(MIN(r.block_timestamp), 'unixepoch')), '')`;
  return getDb()
    .prepare(
      `SELECT m.pubkey, m.label, m.wallet_name, m.wallet_address,
              COUNT(r.id) as reward_count,
              COALESCE(SUM(r.reward_amount), 0) as total_amount,
              COALESCE(SUM(r.is_governance), 0) as governance_count,
              COALESCE(NULLIF(${lastDateExpr}, ''), ${histLastExpr}) as last_reward_date,
              ${firstDateExpr} as first_reward_date
       FROM masternodes m
       LEFT JOIN rewards r
         ON m.pubkey = r.pubkey
        AND ${dateCol} >= ?
        AND ${dateCol} <= ?
       LEFT JOIN (
         SELECT pubkey, MAX(block_timestamp) AS hist_last_ts,
                MAX(reward_date) AS hist_last_date
         FROM rewards GROUP BY pubkey
       ) rh ON rh.pubkey = m.pubkey
       WHERE m.active = 1
       GROUP BY m.pubkey
       ORDER BY total_amount DESC, m.wallet_name, m.label, m.pubkey`
    )
    .all(fromDate, toDate);
}

function getDateRangeRewards(fromDate, toDate, tz = 'utc') {
  const dateCol = _tzDateCol('r', tz);
  return getDb()
    .prepare(
      `SELECT r.*, m.label, m.wallet_name FROM rewards r
       LEFT JOIN masternodes m ON r.pubkey = m.pubkey
       WHERE ${dateCol} >= ? AND ${dateCol} <= ?
       ORDER BY r.block_height`
    )
    .all(fromDate, toDate);
}

function getDateRangeDailyTotals(fromDate, toDate, tz = 'utc') {
  if (tz === 'ist') {
    return getDb()
      .prepare(
        `SELECT strftime('%Y-%m-%d', block_timestamp + 19800, 'unixepoch') as reward_date,
                COUNT(*) as reward_count, SUM(reward_amount) as total_amount
         FROM rewards
         WHERE strftime('%Y-%m-%d', block_timestamp + 19800, 'unixepoch') >= ? AND strftime('%Y-%m-%d', block_timestamp + 19800, 'unixepoch') <= ?
         GROUP BY strftime('%Y-%m-%d', block_timestamp + 19800, 'unixepoch')
         ORDER BY strftime('%Y-%m-%d', block_timestamp + 19800, 'unixepoch')`
      )
      .all(fromDate, toDate);
  }
  return getDb()
    .prepare(
      `SELECT reward_date, COUNT(*) as reward_count, SUM(reward_amount) as total_amount
       FROM rewards
       WHERE reward_date >= ? AND reward_date <= ?
       GROUP BY reward_date ORDER BY reward_date`
    )
    .all(fromDate, toDate);
}

function getLatestNodeStatus() {
  return getDb()
    .prepare(
      `SELECT ns.pubkey, ns.status, ns.last_uptime_proof, ns.version, ns.checked_at,
              m.label, m.wallet_name
       FROM node_status ns
       INNER JOIN (SELECT pubkey, MAX(id) as max_id FROM node_status GROUP BY pubkey) latest
         ON ns.id = latest.max_id
       LEFT JOIN masternodes m ON ns.pubkey = m.pubkey
       ORDER BY ns.status, m.wallet_name`
    )
    .all();
}

function getWalletGroups() {
  return getDb()
    .prepare(
      `SELECT wallet_name, wallet_address, COUNT(*) as node_count
       FROM masternodes WHERE active = 1
       GROUP BY wallet_name ORDER BY wallet_name`
    )
    .all();
}

// --- Node Status ---

function saveNodeStatus(pubkey, status, lastUptimeProof = null, version = null) {
  getDb()
    .prepare(
      `INSERT INTO node_status (pubkey, status, last_uptime_proof, version, checked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET
         status = excluded.status,
         last_uptime_proof = excluded.last_uptime_proof,
         version = excluded.version,
         checked_at = excluded.checked_at`
    )
    .run(pubkey, status, lastUptimeProof, version, new Date().toISOString().slice(0, 19).replace("T", " "));
}

function pruneNodeStatus(retentionDays = 30) {
  const days = Math.max(1, Number(retentionDays) || 30);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace("T", " ");
  return getDb()
    .prepare(
      `WITH latest AS (
         SELECT MAX(id) AS max_id FROM node_status GROUP BY pubkey
       )
       DELETE FROM node_status
       WHERE checked_at < ?
         AND id NOT IN (SELECT max_id FROM latest)`
    )
    .run(cutoff).changes;
}

// --- Scan Progress ---

function getLastScannedHeight() {
  const row = getDb().prepare("SELECT last_scanned_height FROM scan_progress WHERE id = 1").get();
  return row ? row.last_scanned_height : null;
}

function getLastScanInfo() {
  return getDb().prepare("SELECT last_scanned_height, last_scan_time, start_height, end_height, scan_type, date_from, date_to FROM scan_progress WHERE id = 1").get() || null;
}

function setLastScannedHeight(height, ctx = {}) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const sh = ctx.startH ?? null;
  const eh = ctx.endH ?? null;
  const st = ctx.scanType ?? null;
  const df = ctx.dateFrom ?? null;
  const dt = ctx.dateTo ?? null;
  getDb()
    .prepare(
      `INSERT INTO scan_progress (id, last_scanned_height, last_scan_time, start_height, end_height, scan_type, date_from, date_to)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_scanned_height = ?, last_scan_time = ?, start_height = ?, end_height = ?, scan_type = ?, date_from = ?, date_to = ?`
    )
    .run(height, now, sh, eh, st, df, dt, height, now, sh, eh, st, df, dt);
}

// --- Chart Data ---

function getDailyChartData(days = 30) {
  return getDb()
    .prepare(
      `SELECT reward_date, SUM(reward_amount) as total_bdx, COUNT(*) as reward_count
       FROM rewards
       WHERE reward_date >= date('now', '-' || ? || ' days')
       GROUP BY reward_date ORDER BY reward_date`
    )
    .all(String(days));
}

function getMonthlyChartData(months = 12) {
  return getDb()
    .prepare(
      `SELECT strftime('%Y-%m', reward_date) as month,
              SUM(reward_amount) as total_bdx,
              COUNT(*) as reward_count
       FROM rewards
       WHERE reward_date >= date('now', '-' || ? || ' months')
       GROUP BY month ORDER BY month`
    )
    .all(String(months));
}

// --- Per-Node Detail ---

function getNodeRewardHistory(pubkey, limit = 300) {
  return getDb()
    .prepare(
      `SELECT block_height, reward_amount, reward_date, block_timestamp
       FROM rewards WHERE pubkey = ? ORDER BY block_height DESC LIMIT ?`
    )
    .all(pubkey, limit);
}

function getNodeLifetimeStats(pubkey) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) as total_rewards, SUM(reward_amount) as total_bdx,
              MIN(reward_date) as first_reward_date, MAX(reward_date) as last_reward_date,
              COUNT(DISTINCT reward_date) as active_days
       FROM rewards WHERE pubkey = ?`
    )
    .get(pubkey);
}

// --- Streaks ---

function _computeStreak(dates) {
  // dates: sorted DESC array of 'YYYY-MM-DD' strings
  if (!dates.length) return 0;
  const todayUtc = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const newest = new Date(dates[0] + "T00:00:00Z");
  const diffDays = Math.round((todayUtc - newest) / 86400000);
  // If newest reward is older than yesterday, streak is broken
  if (diffDays > 1) return 0;
  let streak = 1;
  for (let i = 0; i < dates.length - 1; i++) {
    const a = new Date(dates[i] + "T00:00:00Z");
    const b = new Date(dates[i + 1] + "T00:00:00Z");
    if (a - b === 86400000) streak++;
    else break;
  }
  return streak;
}

function getNodeStreak(pubkey) {
  const dates = getDb()
    .prepare("SELECT DISTINCT reward_date FROM rewards WHERE pubkey = ? ORDER BY reward_date DESC")
    .all(pubkey)
    .map(r => r.reward_date);
  return _computeStreak(dates);
}

function getAllNodeStreaks(days = 180) {
  const lookbackDays = Math.max(30, Number(days) || 180);
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT pubkey, reward_date
       FROM rewards
       WHERE reward_date >= date('now', '-' || ? || ' days')
       ORDER BY pubkey, reward_date DESC`
    )
    .all(String(lookbackDays));
  const byPubkey = {};
  for (const r of rows) {
    if (!byPubkey[r.pubkey]) byPubkey[r.pubkey] = [];
    byPubkey[r.pubkey].push(r.reward_date);
  }
  return Object.entries(byPubkey).map(([pubkey, dates]) => ({
    pubkey,
    streak_days: _computeStreak(dates),
    last_reward_date: dates[0] || null,
  }));
}

// --- Matrix Report (dates × wallet groups) ---

function getMatrixData(fromDate, toDate, tz = 'utc') {
  const dateCol = _tzDateCol('r', tz);
  return getDb()
    .prepare(
      `SELECT ${dateCol} as reward_date, m.wallet_name, SUM(r.reward_amount) as total_bdx, COUNT(*) as reward_count
       FROM rewards r
       LEFT JOIN masternodes m ON r.pubkey = m.pubkey
       WHERE ${dateCol} >= ? AND ${dateCol} <= ?
       GROUP BY ${dateCol}, m.wallet_name
       ORDER BY ${dateCol}, m.wallet_name`
    )
    .all(fromDate, toDate);
}

function getMatrixCellDetail(date, walletName, tz = 'utc') {
  const dateCol = _tzDateCol('r', tz);
  return getDb()
    .prepare(
      `SELECT m.pubkey, m.label, r.reward_amount, r.block_height
       FROM rewards r
       LEFT JOIN masternodes m ON r.pubkey = m.pubkey
       WHERE ${dateCol} = ?
         AND (m.wallet_name = ? OR (m.wallet_name IS NULL AND ? = 'Ungrouped'))
       ORDER BY r.reward_amount DESC`
    )
    .all(date, walletName, walletName);
}

// --- Wallet Group Report ---

function getWalletGroupReport(fromDate, toDate, tz = 'utc') {
  const dateCol = _tzDateCol('r', tz);
  return getDb()
    .prepare(
      `SELECT m.wallet_name, m.wallet_address,
              COUNT(DISTINCT m.pubkey) as node_count,
              COALESCE(SUM(r.reward_amount), 0) as total_bdx,
              COUNT(r.id) as reward_count
       FROM masternodes m
       LEFT JOIN rewards r ON m.pubkey = r.pubkey AND ${dateCol} >= ? AND ${dateCol} <= ?
       WHERE m.active = 1
       GROUP BY m.wallet_name, m.wallet_address
       ORDER BY total_bdx DESC`
    )
    .all(fromDate, toDate);
}

// --- Scan History ---

function insertScanHistory(type, dateFrom, dateTo, startH, endH, found, durationSec, missedBlocks = 0) {
  getDb()
    .prepare(
      `INSERT INTO scan_history (scan_type, date_from, date_to, start_height, end_height, rewards_found, duration_seconds, missed_blocks, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(type, dateFrom || null, dateTo || null, startH || null, endH || null,
      found || 0, durationSec || 0, missedBlocks || 0,
      new Date().toISOString().slice(0, 19).replace("T", " "));
}

function getDataQuality() {
  const conn = getDb();
  const lastScan = conn.prepare(
    "SELECT * FROM scan_history WHERE scan_type != 'auto' ORDER BY id DESC LIMIT 1"
  ).get() || null;
  const lastAutoScan = conn.prepare(
    "SELECT * FROM scan_history ORDER BY id DESC LIMIT 1"
  ).get() || null;
  const scanProgress = conn.prepare(
    "SELECT last_scanned_height, last_scan_time FROM scan_progress WHERE id = 1"
  ).get() || null;
  const totalNodes = conn.prepare("SELECT COUNT(*) AS n FROM masternodes WHERE active = 1").get().n;
  const rewardDays = conn.prepare(
    "SELECT COUNT(DISTINCT reward_date) AS n FROM rewards"
  ).get().n;
  return { lastScan, lastAutoScan, scanProgress, totalNodes, rewardDays };
}

function getScanHistory(limit = 30) {
  return getDb().prepare("SELECT * FROM scan_history ORDER BY id DESC LIMIT ?").all(limit);
}

function getScannedDatesInRange(fromDate, toDate) {
  // Get all scan history entries that overlap with the requested range
  const rows = getDb()
    .prepare(
      `SELECT date_from, date_to FROM scan_history
       WHERE scan_type IN ('date','range','date_range','auto')
         AND date_from IS NOT NULL AND date_to IS NOT NULL
         AND date_from <= ? AND date_to >= ?`
    )
    .all(toDate, fromDate);
  // Expand each scan entry into individual dates
  const scanned = new Set();
  for (const row of rows) {
    const cur = new Date(row.date_from + "T00:00:00Z");
    const end = new Date(row.date_to + "T00:00:00Z");
    while (cur <= end) {
      const d = cur.toISOString().slice(0, 10);
      if (d >= fromDate && d <= toDate) scanned.add(d);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  return scanned;
}

function getAllTimeStats() {
  return getDb()
    .prepare(
      `SELECT COUNT(DISTINCT pubkey) as rewarded_nodes,
              SUM(reward_amount) as total_bdx_earned,
              COUNT(*) as total_reward_events,
              MIN(reward_date) as first_reward_date,
              MAX(reward_date) as last_reward_date
       FROM rewards`
    ).get();
}

function getLastRewardDatePerNode() {
  return getDb()
    .prepare(
      `SELECT pubkey, MAX(reward_date) as last_reward_date, MAX(block_height) as last_block
       FROM rewards GROUP BY pubkey`
    ).all();
}

// ─── Price Cache ──────────────────────────────────────────

function savePriceCache(bdx_usd, bdx_inr) {
  const conn = getDb();
  conn.prepare("INSERT INTO price_cache (fetched_at, bdx_usd, bdx_inr) VALUES (?, ?, ?)").run(Date.now(), bdx_usd, bdx_inr);
  conn.prepare("DELETE FROM price_cache WHERE fetched_at < ?").run(Date.now() - 7 * 86400000); // keep 7 days
}

function getLatestPrice() {
  return getDb().prepare("SELECT bdx_usd, bdx_inr, fetched_at FROM price_cache ORDER BY id DESC LIMIT 1").get() || null;
}

function getLatestRewardDate() {
  const row = getDb().prepare("SELECT MAX(reward_date) as latest FROM rewards").get();
  return row ? row.latest : null;
}

function pruneRewardsBefore(date) {
  const result = getDb().prepare("DELETE FROM rewards WHERE reward_date < ?").run(date);
  return result.changes;
}

function getTopEarners(date, limit = 10) {
  return getDb().prepare(
    `SELECT r.pubkey,
            COALESCE(m.label, '') as label,
            COALESCE(m.wallet_name, '') as wallet_name,
            SUM(r.reward_amount) as total_bdx,
            COUNT(*) as reward_count
     FROM rewards r
     LEFT JOIN masternodes m ON r.pubkey = m.pubkey
     WHERE r.reward_date = ? AND r.is_governance = 0
     GROUP BY r.pubkey
     ORDER BY total_bdx DESC
     LIMIT ?`
  ).all(date, limit);
}

// ─── Network Stats ────────────────────────────────────────

function saveNetworkStats(total, active) {
  const conn = getDb();
  conn.prepare("INSERT INTO network_stats (recorded_at, total_masternodes, active_masternodes) VALUES (?, ?, ?)").run(Date.now(), total, active);
  conn.prepare("DELETE FROM network_stats WHERE recorded_at < ?").run(Date.now() - 30 * 86400000); // keep 30 days
}

function getNetworkStatsHistory(days = 30) {
  return getDb().prepare(
    "SELECT recorded_at, total_masternodes, active_masternodes FROM network_stats WHERE recorded_at >= ? ORDER BY recorded_at"
  ).all(Date.now() - days * 86400000);
}

function getLatestNetworkStats() {
  return getDb().prepare("SELECT total_masternodes, active_masternodes, recorded_at FROM network_stats ORDER BY id DESC LIMIT 1").get() || null;
}

// ─── Uptime History ───────────────────────────────────────

function saveUptimeSnapshot(pubkey, status, proofAgeHours) {
  const today = new Date().toISOString().slice(0, 10);
  getDb().prepare(
    `INSERT INTO uptime_history (pubkey, recorded_date, status, proof_age_hours, checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pubkey, recorded_date) DO UPDATE SET status = excluded.status, proof_age_hours = excluded.proof_age_hours, checked_at = excluded.checked_at`
  ).run(pubkey, today, status, proofAgeHours, Date.now());
}

function pruneUptimeHistory(keepDays = 90) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - keepDays);
  return getDb().prepare("DELETE FROM uptime_history WHERE recorded_date < ?").run(cutoff.toISOString().slice(0, 10)).changes;
}

// ─── Backfill Gaps ────────────────────────────────────────

function detectRewardGaps() {
  const conn = getDb();
  const todayStr = new Date().toISOString().slice(0, 10);

  const shRow = conn.prepare("SELECT MIN(date_from) AS earliest FROM scan_history WHERE date_from IS NOT NULL").get();
  const trackingStart = shRow?.earliest || null;

  const trackingFilter = (trackingStart && trackingStart.trim()) ? "AND r.reward_date >= @trackingStart" : "";
  const sql = `
    WITH distinct_dates AS (
      SELECT r.pubkey, r.reward_date
      FROM rewards r
      INNER JOIN masternodes m ON m.pubkey = r.pubkey AND m.active = 1
      WHERE 1=1 ${trackingFilter}
      GROUP BY r.pubkey, r.reward_date
    ),
    lagged AS (
      SELECT pubkey,
             LAG(reward_date) OVER (PARTITION BY pubkey ORDER BY reward_date) AS prev_date,
             reward_date AS cur_date
      FROM distinct_dates
    ),
    between_gaps AS (
      SELECT l.pubkey,
             date(l.prev_date, '+1 day') AS gap_from,
             date(l.cur_date, '-1 day')  AS gap_to,
             CAST(julianday(l.cur_date) - julianday(l.prev_date) - 1 AS INTEGER) AS days
      FROM lagged l
      WHERE l.prev_date IS NOT NULL
        AND CAST(julianday(l.cur_date) - julianday(l.prev_date) - 1 AS INTEGER) >= 7
    ),
    trailing_gaps AS (
      SELECT d.pubkey,
             date(MAX(d.reward_date), '+1 day') AS gap_from,
             @today                              AS gap_to,
             CAST(julianday(@today) - julianday(MAX(d.reward_date)) - 1 AS INTEGER) AS days
      FROM distinct_dates d
      GROUP BY d.pubkey
      HAVING CAST(julianday(@today) - julianday(MAX(d.reward_date)) - 1 AS INTEGER) >= 7
    ),
    all_gaps AS (
      SELECT * FROM between_gaps
      UNION ALL
      SELECT * FROM trailing_gaps
    )
    SELECT g.pubkey, g.gap_from, g.gap_to, g.days,
           m.label, m.wallet_name
    FROM all_gaps g
    INNER JOIN masternodes m ON m.pubkey = g.pubkey
    ORDER BY g.pubkey, g.gap_from
  `;

  const params = { today: todayStr };
  if (trackingStart && trackingStart.trim()) params.trackingStart = trackingStart;
  return conn.prepare(sql).all(params);
}

function detectRewardGapsInRange(fromDate, toDate, minGapDays = 1) {
  const conn = getDb();
  const sql = `
    WITH distinct_dates AS (
      SELECT r.pubkey, r.reward_date
      FROM rewards r
      INNER JOIN masternodes m ON m.pubkey = r.pubkey AND m.active = 1
      WHERE r.reward_date >= @fromDate AND r.reward_date <= @toDate
      GROUP BY r.pubkey, r.reward_date
    ),
    lagged AS (
      SELECT pubkey,
             LAG(reward_date) OVER (PARTITION BY pubkey ORDER BY reward_date) AS prev_date,
             reward_date AS cur_date
      FROM distinct_dates
    ),
    between_gaps AS (
      SELECT l.pubkey,
             date(l.prev_date, '+1 day') AS gap_from,
             date(l.cur_date, '-1 day')  AS gap_to,
             CAST(julianday(l.cur_date) - julianday(l.prev_date) - 1 AS INTEGER) AS days
      FROM lagged l
      WHERE l.prev_date IS NOT NULL
        AND CAST(julianday(l.cur_date) - julianday(l.prev_date) - 1 AS INTEGER) >= @minGapDays
    ),
    node_bounds AS (
      SELECT m.pubkey,
             MIN(d.reward_date) AS first_in_range,
             MAX(d.reward_date) AS last_in_range
      FROM masternodes m
      LEFT JOIN distinct_dates d ON d.pubkey = m.pubkey
      WHERE m.active = 1
      GROUP BY m.pubkey
    ),
    leading_gaps AS (
      SELECT nb.pubkey,
             @fromDate AS gap_from,
             CASE WHEN nb.first_in_range IS NULL THEN @toDate
                  ELSE date(nb.first_in_range, '-1 day')
             END AS gap_to,
             CASE WHEN nb.first_in_range IS NULL
                  THEN CAST(julianday(@toDate) - julianday(@fromDate) + 1 AS INTEGER)
                  ELSE CAST(julianday(nb.first_in_range) - julianday(@fromDate) AS INTEGER)
             END AS days
      FROM node_bounds nb
      WHERE CASE WHEN nb.first_in_range IS NULL
                 THEN CAST(julianday(@toDate) - julianday(@fromDate) + 1 AS INTEGER)
                 ELSE CAST(julianday(nb.first_in_range) - julianday(@fromDate) AS INTEGER)
            END >= @minGapDays
    ),
    trailing_gaps AS (
      SELECT nb.pubkey,
             date(nb.last_in_range, '+1 day') AS gap_from,
             @toDate AS gap_to,
             CAST(julianday(@toDate) - julianday(nb.last_in_range) AS INTEGER) AS days
      FROM node_bounds nb
      WHERE nb.last_in_range IS NOT NULL
        AND CAST(julianday(@toDate) - julianday(nb.last_in_range) AS INTEGER) >= @minGapDays
    ),
    all_gaps AS (
      SELECT * FROM between_gaps
      UNION ALL
      SELECT * FROM leading_gaps
      UNION ALL
      SELECT * FROM trailing_gaps
    )
    SELECT g.pubkey, g.gap_from, g.gap_to, g.days,
           m.label, m.wallet_name
    FROM all_gaps g
    INNER JOIN masternodes m ON m.pubkey = g.pubkey
    ORDER BY g.pubkey, g.gap_from
  `;
  return conn.prepare(sql).all({ fromDate, toDate, minGapDays });
}

function getBackfillGaps() {
  return getDb().prepare(
    `SELECT g.*, m.label, m.wallet_name
     FROM backfill_gaps g LEFT JOIN masternodes m ON g.pubkey = m.pubkey
     ORDER BY g.detected_at DESC`
  ).all();
}

function saveBackfillGap(pubkey, gap_from, gap_to) {
  try {
    getDb().prepare(
      "INSERT INTO backfill_gaps (pubkey, gap_from, gap_to, detected_at) VALUES (?, ?, ?, ?)"
    ).run(pubkey, gap_from, gap_to, Date.now());
    return true;
  } catch (e) { return false; }
}

function updateGapStatus(id, status, foundRewards = 0) {
  getDb().prepare("UPDATE backfill_gaps SET status = ?, found_rewards = ? WHERE id = ?").run(status, foundRewards, id);
}

function clearBackfillGaps() {
  getDb().prepare("DELETE FROM backfill_gaps").run();
}

// ─── Analytics ────────────────────────────────────────────

function getHeatmapData(year) {
  return getDb().prepare(
    `SELECT reward_date, COUNT(*) as reward_count, SUM(reward_amount) as total_bdx
     FROM rewards WHERE reward_date LIKE ? GROUP BY reward_date ORDER BY reward_date`
  ).all(`${year}%`);
}

function getHubLeaderboard(fromDate, toDate) {
  return getDb().prepare(
    `SELECT
       m.wallet_name,
       m.wallet_address,
       COUNT(DISTINCT m.pubkey) as node_count,
       COALESCE(SUM(r.reward_amount), 0) as total_bdx,
       COUNT(r.id) as reward_count,
       COALESCE(SUM(r.reward_amount), 0) / COUNT(DISTINCT m.pubkey) as bdx_per_node,
       COUNT(r.id) * 1.0 / COUNT(DISTINCT m.pubkey) as rewards_per_node,
       COUNT(DISTINCT r.reward_date) as active_days
     FROM masternodes m
     LEFT JOIN rewards r ON m.pubkey = r.pubkey AND r.reward_date >= ? AND r.reward_date <= ?
     WHERE m.active = 1
     GROUP BY m.wallet_name, m.wallet_address
     ORDER BY total_bdx DESC`
  ).all(fromDate, toDate);
}

function getVelocityData(weeks = 12) {
  const days = weeks * 7;
  return getDb().prepare(
    `SELECT
       strftime('%Y-W%W', reward_date) as week_key,
       MIN(reward_date) as week_start,
       COUNT(*) as reward_count,
       SUM(reward_amount) as total_bdx,
       COUNT(DISTINCT pubkey) as unique_nodes
     FROM rewards
     WHERE reward_date >= date('now', '-' || ? || ' days')
     GROUP BY week_key
     ORDER BY week_key`
  ).all(String(days));
}

function getAnomalousNodes(thresholdMultiplier = 1.5) {
  // Nodes whose days-since-last-reward exceeds their personal avg interval × threshold
  return getDb().prepare(
    `WITH node_stats AS (
       SELECT
         pubkey,
         COUNT(*) as total_rewards,
         MAX(reward_date) as last_reward,
         CAST(julianday('now') - julianday(MAX(reward_date)) AS REAL) as days_since,
         CASE
           WHEN COUNT(*) >= 2
           THEN (julianday(MAX(reward_date)) - julianday(MIN(reward_date))) / (COUNT(*) - 1)
           ELSE NULL
         END as avg_interval_days
       FROM rewards GROUP BY pubkey
       HAVING COUNT(*) >= 2
     )
     SELECT ns.pubkey, m.label, m.wallet_name,
       ns.last_reward, ROUND(ns.days_since, 1) as days_since,
       ROUND(ns.avg_interval_days, 1) as avg_interval_days,
       ROUND(ns.days_since / ns.avg_interval_days, 2) as overdue_ratio,
       ns.total_rewards
     FROM node_stats ns
     JOIN masternodes m ON ns.pubkey = m.pubkey
     WHERE ns.avg_interval_days > 0
       AND ns.days_since > ns.avg_interval_days * ?
     ORDER BY overdue_ratio DESC`
  ).all(thresholdMultiplier);
}

// ─── DB Management ────────────────────────────────────────

function getDbDetailedStats() {
  const conn = getDb();
  const tables = ["masternodes", "rewards", "node_status", "scan_history", "uptime_history",
    "backfill_gaps", "operators", "archive_log", "price_cache", "network_stats"];
  const ALLOWED_TABLES = new Set(['nodes','rewards','scan_history','status_checks','archive_log',
    'masternodes','node_status','uptime_history','backfill_gaps','operators','price_cache','network_stats']);
  const counts = {};
  for (const t of tables) {
    if (!ALLOWED_TABLES.has(t)) continue;
    try { counts[t] = conn.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c; } catch { counts[t] = 0; }
  }
  const pageSize = conn.pragma("page_size", { simple: true });
  const pageCount = conn.pragma("page_count", { simple: true });
  const freelistCount = conn.pragma("freelist_count", { simple: true });
  const dateRange = conn.prepare("SELECT MIN(reward_date) as oldest, MAX(reward_date) as newest FROM rewards").get();
  return {
    page_size: pageSize,
    page_count: pageCount,
    freelist_count: freelistCount,
    total_pages_size_mb: parseFloat(((pageSize * pageCount) / 1048576).toFixed(2)),
    fragmentation_pct: pageCount > 0 ? parseFloat(((freelistCount / pageCount) * 100).toFixed(1)) : 0,
    table_counts: counts,
    rewards_oldest: dateRange?.oldest || null,
    rewards_newest: dateRange?.newest || null,
  };
}

function runVacuumAndCheckpoint() {
  const conn = getDb();
  conn.pragma("wal_checkpoint(TRUNCATE)");
  conn.exec("VACUUM");
  return true;
}

function archiveAndPruneRewards(beforeDate, archivePath) {
  const ARCHIVES_BASE = path.resolve(__dirname, 'archives');
  const resolvedPath = path.resolve(archivePath);
  if (!resolvedPath.startsWith(ARCHIVES_BASE + path.sep)) {
    throw new Error('Archive path outside allowed directory');
  }

  const conn = getDb();
  const fs = require("fs");
  const zlib = require("zlib");
  const pathMod = require("path");

  // Count rows first (cheap) to short-circuit the empty case without opening a file
  const count = conn.prepare("SELECT COUNT(*) AS n FROM rewards WHERE reward_date < ?").get(beforeDate).n;
  if (count === 0) return { archived: 0 };

  // Build JSON array via cursor (iterator) to avoid loading all rows into a JS array.
  // Each row is serialised immediately then discarded — peak memory is one row at a time.
  // Parts array avoids V8 string reallocation on every append for large datasets.
  const parts = [];
  for (const row of conn.prepare("SELECT * FROM rewards WHERE reward_date < ?").iterate(beforeDate)) {
    parts.push(JSON.stringify(row));
  }
  let json = '[' + parts.join(',') + ']';

  const compressed = zlib.gzipSync(json);
  json = null; // release string before writing
  fs.mkdirSync(pathMod.dirname(archivePath), { recursive: true });
  const tmpPath = archivePath + '.tmp';
  fs.writeFileSync(tmpPath, compressed);

  // Rename to final path BEFORE the transaction — if rename fails, DB is untouched and data is safe in .tmp.
  // If the transaction fails after rename, we rename back to preserve the file.
  fs.renameSync(tmpPath, archivePath);

  let deleted;
  try {
    conn.transaction(() => {
      deleted = conn.prepare("DELETE FROM rewards WHERE reward_date < ?").run(beforeDate).changes;
      conn.prepare(
        "INSERT INTO archive_log (archived_at, table_name, rows_archived, archive_path, date_range) VALUES (?, 'rewards', ?, ?, ?)"
      ).run(Date.now(), deleted, archivePath, `before ${beforeDate}`);
    })();
  } catch (e) {
    try { fs.renameSync(archivePath, tmpPath); } catch {}
    throw e;
  }

  return { archived: deleted, path: archivePath };
}

function getArchiveLog() {
  return getDb().prepare("SELECT * FROM archive_log ORDER BY archived_at DESC LIMIT 200").all();
}

// ─── Operators ────────────────────────────────────────────

function getOperators() {
  return getDb()
    .prepare("SELECT id, username, hub_access, is_admin, created_at FROM operators ORDER BY id")
    .all()
    .map(o => {
      let parsed = [];
      try { parsed = JSON.parse(o.hub_access || "[]"); } catch {}
      return { ...o, hub_access: parsed };
    });
}

function getOperatorByUsername(username) {
  return getDb().prepare("SELECT * FROM operators WHERE username = ?").get(username);
}

function createOperator(username, passwordHash, hubAccess = [], isAdmin = 0) {
  try {
    getDb().prepare(
      "INSERT INTO operators (username, password_hash, hub_access, is_admin, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(username, passwordHash, JSON.stringify(hubAccess), isAdmin ? 1 : 0, Date.now());
    return true;
  } catch (e) {
    if (e.message.includes("UNIQUE")) return false;
    throw e;
  }
}

function updateOperator(id, hubAccess, isAdmin) {
  return getDb().prepare(
    "UPDATE operators SET hub_access = ?, is_admin = ? WHERE id = ?"
  ).run(JSON.stringify(hubAccess), isAdmin ? 1 : 0, id).changes > 0;
}

function updateOperatorPassword(id, passwordHash) {
  return getDb().prepare("UPDATE operators SET password_hash = ? WHERE id = ?").run(passwordHash, id).changes > 0;
}

function deleteOperator(id) {
  return getDb().prepare("DELETE FROM operators WHERE id = ? AND is_admin = 0").run(id).changes > 0;
}

function ensureAdminExists(passwordHash) {
  const existing = getDb().prepare("SELECT id FROM operators WHERE is_admin = 1 LIMIT 1").get();
  if (!existing) {
    createOperator("admin", passwordHash, [], 1);
  }
}

function getLegacyHashOperators() {
  return getDb()
    .prepare("SELECT id, username FROM operators WHERE password_hash NOT LIKE '%:%'")
    .all();
}

// Hot backup using better-sqlite3 API — captures WAL pages correctly
function hotBackup(destPath) {
  return getDb().backup(destPath);
}

// Detects scan gaps by finding large block-height jumps between consecutive dates.
// A trailing_gap > threshold means blocks were mined on date X after the scan ended.
function findScanGaps(gapThreshold, fromDate) {
  if (gapThreshold === undefined) gapThreshold = 50;
  const conn = getDb();

  // Derive the earliest date we should validate.
  // Priority: explicit fromDate → earliest date_from in scan_history → earliest reward_date.
  // This prevents surfacing false gaps for data that predates active tracking.
  if (!fromDate) {
    const sh = conn.prepare(
      "SELECT MIN(date_from) AS earliest FROM scan_history WHERE date_from IS NOT NULL"
    ).get();
    fromDate = sh && sh.earliest
      ? sh.earliest
      : (conn.prepare("SELECT MIN(reward_date) AS earliest FROM rewards").get()?.earliest || null);
  }

  return conn.prepare(`
    WITH daily AS (
      SELECT reward_date,
             COUNT(*)          AS reward_count,
             MIN(block_height) AS day_start,
             MAX(block_height) AS day_end
      FROM rewards
      ${fromDate ? "WHERE reward_date >= ?" : ""}
      GROUP BY reward_date
    ),
    gaps AS (
      SELECT
        curr.reward_date,
        curr.reward_count,
        curr.day_start,
        curr.day_end,
        nxt.reward_date                    AS next_date,
        nxt.day_start                      AS next_day_start,
        nxt.day_start - curr.day_end - 1   AS trailing_gap,
        curr.day_end + 1                   AS gap_start,
        nxt.day_start - 1                  AS gap_end
      FROM daily curr
      LEFT JOIN daily nxt ON nxt.reward_date = date(curr.reward_date, '+1 day')
      WHERE nxt.day_start - curr.day_end - 1 > ?
    )
    SELECT g.reward_date, g.reward_count, g.day_start, g.day_end,
           g.next_date, g.next_day_start, g.trailing_gap
    FROM gaps g
    WHERE NOT EXISTS (
      SELECT 1 FROM scan_history sh
      WHERE sh.start_height IS NOT NULL
        AND sh.end_height IS NOT NULL
        AND sh.start_height <= g.gap_start
        AND sh.end_height >= g.gap_end
    )
    ORDER BY g.reward_date
  `).all(...(fromDate ? [fromDate, gapThreshold] : [gapThreshold]));
}

function deleteRewardsInRange(startDate, endDate) {
  return getDb().prepare(
    "DELETE FROM rewards WHERE reward_date >= ? AND reward_date <= ?"
  ).run(startDate, endDate).changes;
}

// Returns 30-day uptime summary per node: { pubkey, total_30d, active_30d }
function getUptimeSummary() {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return getDb()
    .prepare(
      `SELECT pubkey,
              COUNT(*) AS total_30d,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_30d
       FROM uptime_history
       WHERE recorded_date >= ?
       GROUP BY pubkey`
    )
    .all(cutoff);
}

// Returns nodes whose days-since-last-reward exceeds their personal avg interval,
// shaped for the network-overdue overlay: { pubkey, label, wallet_name, overdue_ratio, days_since }
function getNetworkOverdueNodes(thresholdMultiplier = 1.0) {
  return getDb()
    .prepare(
      `WITH node_stats AS (
         SELECT
           pubkey,
           MAX(reward_date) AS last_reward,
           CAST(julianday('now') - julianday(MAX(reward_date)) AS REAL) AS days_since,
           CASE
             WHEN COUNT(*) >= 2
             THEN (julianday(MAX(reward_date)) - julianday(MIN(reward_date))) / (COUNT(*) - 1)
             ELSE NULL
           END AS avg_interval_days
         FROM rewards
         GROUP BY pubkey
         HAVING COUNT(*) >= 2
       )
       SELECT ns.pubkey, m.label, m.wallet_name,
         ROUND(ns.days_since / ns.avg_interval_days, 2) AS overdue_ratio,
         ROUND(ns.days_since, 1) AS days_since
       FROM node_stats ns
       JOIN masternodes m ON ns.pubkey = m.pubkey
       WHERE ns.avg_interval_days > 0
         AND ns.days_since > ns.avg_interval_days * ?
       ORDER BY overdue_ratio DESC`
    )
    .all(thresholdMultiplier);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDb, addNode, updateNode, removeNode, removeAllNodes, bulkAddNodes, getAllNodes, getNodeByPubkey, getNodeCount,
  insertRewardsBatch, getExistingBlockHeightsForNodes, getDailySummary, getMonthlySummary, getMonthlyRewards,
  getDateRangeSummary, getDateRangeRewards, getDateRangeDailyTotals, getPerKeyReport,
  saveNodeStatus, pruneNodeStatus, getLatestNodeStatus, getWalletGroups,
  getLastScannedHeight, setLastScannedHeight, getLastScanInfo,
  getDailyChartData, getMonthlyChartData, getNodeRewardHistory, getNodeLifetimeStats,
  getNodeStreak, getAllNodeStreaks, getWalletGroupReport,
  insertScanHistory, getScanHistory, getDataQuality, getMatrixData, getMatrixCellDetail, getScannedDatesInRange,
  getAllTimeStats, getLastRewardDatePerNode,
  // Price
  savePriceCache, getLatestPrice, getLatestRewardDate, pruneRewardsBefore, deleteRewardsInRange, getTopEarners,
  // Network stats
  saveNetworkStats, getNetworkStatsHistory, getLatestNetworkStats,
  // Uptime history
  saveUptimeSnapshot, pruneUptimeHistory,
  // Gap analysis
  findScanGaps,
  // Backfill
  detectRewardGaps, detectRewardGapsInRange, getBackfillGaps, saveBackfillGap, updateGapStatus, clearBackfillGaps,
  // Analytics
  getHeatmapData, getHubLeaderboard, getVelocityData, getAnomalousNodes,
  getUptimeSummary, getNetworkOverdueNodes,
  // DB management
  getDbDetailedStats, runVacuumAndCheckpoint, archiveAndPruneRewards, getArchiveLog, hotBackup,
  // Operators
  getOperators, getOperatorByUsername, createOperator, updateOperator, updateOperatorPassword,
  deleteOperator, ensureAdminExists, getLegacyHashOperators,
  getSetting, setSetting,
  closeDb
};
