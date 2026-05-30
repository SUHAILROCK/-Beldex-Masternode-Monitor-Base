/**
 * Beldex Masternode Monitor - Web Server
 * REST API + serves the web dashboard
 */

require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const db = require("./db");
const scanner = require("./scanner");
const schedulerCfg = require("./scheduler");
const compression = require("compression");

// ── Shared utilities & constants ─────────────────────────
const {
  MAX_BULK_NODES, NODE_STATUS_RETENTION_DAYS, MAX_REPORT_RANGE_DAYS,
  MAX_MANUAL_SCAN_BLOCKS,
  sendInternalError, isValidDate, validateDateRange,
  loginLimiter, destructiveLimiter,
} = require("./lib/shared");

const { hashPassword, verifyPassword } = require("./lib/auth");

// ── Route modules ─────────────────────────────────────────
const registerNodes     = require("./routes/nodes");
const { register: registerReports, clearReportCache } = require("./routes/reports");
const registerAnalytics = require("./routes/analytics");
const registerDatabase  = require("./routes/database");
const registerOperators = require("./routes/operators");

const DB_PATH = process.env.BDX_DB_PATH || path.join(__dirname, "beldex_monitor.db");

if (!process.env.ADMIN_PASSWORD) {
  console.error("[FATAL] ADMIN_PASSWORD environment variable is not set. Set it in your .env file and restart.");
  process.exit(1);
}
// _adminPasswordHash is loaded/generated at startup — scrypt hash stored in app_settings table.
// Set after db.initDb() — see startup block below.
let _adminPasswordHash = null;
let _viewerPasswordHash = process.env.VIEWER_PASSWORD ? hashPassword(process.env.VIEWER_PASSWORD) : null;
const AUTH_COOKIE = "bdx_auth";
const ROLE_COOKIE = "bdx_role";
// Session store: password-equivalent tokens are never used as session values.
// Each login gets a random 32-byte token that lives only in this Map.
const _sessions = new Map(); // token → { createdAt, role }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function _createSession(role = 'admin') {
  if (_sessions.size >= 1000) { _sessions.delete(_sessions.keys().next().value); }
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  _sessions.set(token, { createdAt: Date.now(), csrf, role });
  return token;
}
function _getSessionRole(token) {
  const s = _sessions.get(token);
  return s ? (s.role || 'admin') : null;
}
function _isValidSession(token) {
  if (!token) return false;
  const s = _sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { _sessions.delete(token); return false; }
  return true;
}
// Prune expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of _sessions) { if (now - s.createdAt > SESSION_TTL_MS) _sessions.delete(t); }
}, 60 * 60 * 1000);

function authMiddleware(req, res, next) {
  if (req.path === "/login" || req.path === "/api/login" || req.path === "/api/health" || req.path === "/login.js") return next();
  // Allow safe static assets — CSS, images, fonts only. All JS (including nodes-data.js) requires auth.
  // B-SEC-04: Exclude /api/ paths — a path like /api/nodes.css must not bypass auth.
  if (!req.path.startsWith('/api/') && /\.(css|svg|ico|png|webp|woff2?)$/.test(req.path)) return next();
  const cookie = req.headers.cookie || "";
  const match = cookie.split(";").map(c => c.trim()).find(c => c.startsWith(AUTH_COOKIE + "="));
  const eqIdx = match ? match.indexOf("=") : -1;
  const token = eqIdx !== -1 ? match.slice(eqIdx + 1) : null;
  if (_isValidSession(token)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  res.redirect("/login");
}

// Viewer-role guard — blocks all mutating API calls for viewer sessions
const VIEWER_BLOCKED_PATHS = ['/api/scan', '/api/nodes', '/api/database', '/api/scheduler', '/api/backfill', '/api/status/check', '/api/archive'];
const VIEWER_BLOCKED_GET_PATHS = ['/api/backup/db'];
function viewerGuard(req, res, next) {
  const cookie = req.headers.cookie || "";
  const match = cookie.split(";").map(c => c.trim()).find(c => c.startsWith(AUTH_COOKIE + "="));
  const eqIdx = match ? match.indexOf("=") : -1;
  const token = eqIdx !== -1 ? match.slice(eqIdx + 1) : null;
  if (_getSessionRole(token) === 'viewer') {
    if (VIEWER_BLOCKED_GET_PATHS.some(p => req.path.startsWith(p))) {
      return res.status(403).json({ error: "Viewer access — action not permitted" });
    }
    if (['POST','PUT','DELETE','PATCH'].includes(req.method) && VIEWER_BLOCKED_PATHS.some(p => req.path.startsWith(p))) {
      return res.status(403).json({ error: "Viewer access — action not permitted" });
    }
  }
  return next();
}

function csrfMiddleware(req, res, next) {
  const MUTATING = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (!MUTATING.includes(req.method)) return next();
  // Pre-auth endpoints don't have a session yet — skip CSRF check
  if (req.path === '/api/login' || req.path === '/api/operators/login') return next();
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map(c => c.trim()).find(c => c.startsWith(AUTH_COOKIE + '='));
  const eqIdx = match ? match.indexOf('=') : -1;
  const sessionToken = eqIdx !== -1 ? match.slice(eqIdx + 1) : null;
  const session = _sessions.get(sessionToken);
  const provided = req.headers['x-csrf-token'];
  if (!session || !provided) return res.status(403).json({ error: 'Invalid CSRF token' });
  const providedBuf = Buffer.from(provided);
  const csrfBuf = Buffer.from(session.csrf);
  if (providedBuf.length !== csrfBuf.length ||
      !crypto.timingSafeEqual(providedBuf, csrfBuf)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

if (process.env.TRUST_PROXY) {
  const v = Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY;
  app.set('trust proxy', v);
  console.log(`[Config] Trust proxy set to: ${v}`);
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[Security] TRUST_PROXY is not set. Rate limiting will be ineffective if running behind a reverse proxy (Nginx/Caddy). Set TRUST_PROXY=1 in .env.');
}

// Security headers (X-Frame-Options, X-Content-Type-Options, etc.)
// hsts: false — app runs on plain HTTP; sending HSTS would cause browsers to
// permanently force HTTPS and block access until the max-age expires.
app.use(helmet({
  hsts: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://fonts.googleapis.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);
app.use(viewerGuard);
app.use(csrfMiddleware);
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    // Cache static assets for 1 hour; HTML is always re-validated
    if (/\.(css|js|svg|ico|woff2?)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'private, max-age=3600');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// Serve all frontend JS as a single bundle (built once at startup).
// Reduces 11 HTTP requests → 1, with ETag-based cache validation.
const _jsBundleFiles = [
  'nodes-data.js',
  'js/core.js', 'js/dashboard.js', 'js/nodes.js', 'js/scanner.js',
  'js/reports.js', 'js/analytics.js', 'js/status.js', 'js/database.js',
  'js/events.js',
].map(f => path.join(__dirname, 'public', f));

let _bundleCache = null;
let _bundleEtag  = null;
const _isDev = process.env.NODE_ENV !== 'production';

function buildFrontendBundle() {
  const bundle = _jsBundleFiles.map(f => {
    try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
  }).join('\n;\n');
  _bundleEtag  = '"' + crypto.createHash('sha1').update(bundle).digest('hex').slice(0, 16) + '"';
  _bundleCache = bundle;
}

// In dev mode, watch JS files and auto-rebuild bundle on any change.
if (_isDev) {
  let _rebuildTimer = null;
  _jsBundleFiles.forEach(f => {
    try {
      fs.watch(f, () => {
        clearTimeout(_rebuildTimer);
        _rebuildTimer = setTimeout(() => {
          buildFrontendBundle();
          console.log('[Dev] Bundle rebuilt —', path.basename(f), 'changed. Refresh browser.');
        }, 120);
      });
    } catch { /* file may not exist yet */ }
  });
}

app.get('/js/bundle.js', (req, res) => {
  if (!_bundleCache) buildFrontendBundle();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', _isDev ? 'no-store' : 'public, max-age=3600');
  res.setHeader('ETag', _bundleEtag);
  if (!_isDev && req.headers['if-none-match'] === _bundleEtag) return res.status(304).end();
  res.send(_bundleCache);
});

app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

app.get("/api/health", (_req, res) => {
  try {
    db.getNodeCount();
    res.json({ ok: true, db: true, time: new Date().toISOString() });
  } catch (e) {
    console.error("[Health]", e && e.stack ? e.stack : e);
    res.status(503).json({ ok: false, db: false, time: new Date().toISOString() });
  }
});

app.post("/api/login", loginLimiter, (req, res) => {
  const { password } = req.body;
  const securePart = process.env.NODE_ENV === "production" ? "; Secure" : "";
  let role = null;
  if (verifyPassword(password || "", _adminPasswordHash)) {
    role = 'admin';
  } else if (_viewerPasswordHash && verifyPassword(password || "", _viewerPasswordHash)) {
    role = 'viewer';
  }
  if (role) {
    const sessionToken = _createSession(role);
    res.setHeader("Set-Cookie", [
      `${AUTH_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${securePart}`,
      `${ROLE_COOKIE}=${role}; Path=/; SameSite=Strict; Max-Age=43200${securePart}`
    ]);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});

app.get("/api/me", (req, res) => {
  const cookie = req.headers.cookie || "";
  const match = cookie.split(";").map(c => c.trim()).find(c => c.startsWith(AUTH_COOKIE + "="));
  const eqIdx = match ? match.indexOf("=") : -1;
  const token = eqIdx !== -1 ? match.slice(eqIdx + 1) : null;
  res.json({ role: _getSessionRole(token) || 'admin' });
});

app.post("/api/logout", (req, res) => {
  const cookie = req.headers.cookie || "";
  const match = cookie.split(";").map(c => c.trim()).find(c => c.startsWith(AUTH_COOKIE + "="));
  const eqIdx = match ? match.indexOf("=") : -1;
  if (eqIdx !== -1) _sessions.delete(match.slice(eqIdx + 1));
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly`);
  res.json({ ok: true });
});

app.get("/api/csrf-token", (req, res) => {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map(c => c.trim()).find(c => c.startsWith(AUTH_COOKIE + '='));
  const eqIdx = match ? match.indexOf('=') : -1;
  const sessionToken = eqIdx !== -1 ? match.slice(eqIdx + 1) : null;
  const session = _sessions.get(sessionToken);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ token: session.csrf });
});

db.initDb();
buildFrontendBundle();

// Bootstrap admin scrypt hash — generate once, store in DB, auto-refresh if .env password changes.
(function _bootstrapAdminHash() {
  const stored = db.getSetting('admin_password_hash');
  if (stored && verifyPassword(process.env.ADMIN_PASSWORD, stored)) {
    _adminPasswordHash = stored;
  } else {
    // First run OR password changed in .env — regenerate
    _adminPasswordHash = hashPassword(process.env.ADMIN_PASSWORD);
    db.setSetting('admin_password_hash', _adminPasswordHash);
  }
})();

// ── Register route modules ────────────────────────────────
registerNodes(app);
registerReports(app);
registerAnalytics(app);
registerDatabase(app);
registerOperators(app);

// ─── Network Stats Cache ──────────────────────────────────
// One background refresh every 60s. Every endpoint reads from cache — instant.
let _cachedStats = null;

async function refreshNetworkStats() {
  try {
    const stats = await scanner.getNetworkStats();
    if (stats) { _cachedStats = stats; }
  } catch (e) { /* keep stale cache on failure */ }
}

refreshNetworkStats(); // fetch once on startup
setInterval(refreshNetworkStats, 60000);

// ─── Network Stats ────────────────────────────────────────
app.get("/api/network-stats", (_req, res) => {
  // Served from cache — responds instantly, no external HTTP call
  res.json(_cachedStats || {});
});

// ─── Scan ─────────────────────────────────────────────────
let activeScan = null;
let _scanLock = false;          // atomic guard against concurrent scan starts
let _lastScanCancelled = false; // true only when a scan was cancelled before finishing
let _scanTimeoutId = null;      // overall scan timeout (4h) — cleared on normal completion

app.post("/api/scan", async (req, res) => {
  const { date, fromDate, toDate, startHeight: sh, endHeight: eh, resume } = req.body;

  if (_scanLock || (activeScan && activeScan.running)) {
    return res.json({ started: false, message: "Scan already running" });
  }
  // B-SEC-01: No await between the _scanLock check above and this assignment — consecutive
  // synchronous statements. Node.js single-thread guarantees no TOCTOU race here.
  _scanLock = true; // set immediately — before any validation that could yield the event loop

  const nodes = db.getAllNodes();
  if (!nodes.length) {
    _scanLock = false;
    return res.json({ started: false, message: "No nodes registered. Add nodes first." });
  }

  // fix #8: validate date fields — format and future-date guard
  const todayStr = new Date().toISOString().slice(0, 10);
  if (date !== undefined) {
    if (!isValidDate(date)) {
      _scanLock = false;
      activeScan = { running: false, progress: 0, total: 0, found: 0, log: ["Error: Invalid date format. Expected YYYY-MM-DD."], cancelled: false };
      return res.json({ started: false, message: "Invalid date format" });
    }
    if (date > todayStr) {
      _scanLock = false;
      activeScan = { running: false, progress: 0, total: 0, found: 0, log: ["Error: Cannot scan a future date."], cancelled: false };
      return res.json({ started: false, message: "Date is in the future" });
    }
  }
  if (fromDate !== undefined || toDate !== undefined) {
    if (!isValidDate(fromDate) || !isValidDate(toDate)) {
      _scanLock = false;
      activeScan = { running: false, progress: 0, total: 0, found: 0, log: ["Error: Invalid date format. Expected YYYY-MM-DD."], cancelled: false };
      return res.json({ started: false, message: "Invalid date format" });
    }
    if (fromDate > todayStr) {
      _scanLock = false;
      activeScan = { running: false, progress: 0, total: 0, found: 0, log: ["Error: fromDate cannot be in the future."], cancelled: false };
      return res.json({ started: false, message: "fromDate is in the future" });
    }
  }
  if (sh !== undefined || eh !== undefined) {
    const startH = Number.parseInt(sh, 10);
    const endH = Number.parseInt(eh, 10);
    if (!Number.isInteger(startH) || !Number.isInteger(endH) || startH < 1 || endH < startH) {
      _scanLock = false;
      return res.json({ started: false, message: "Invalid block range" });
    }
    if (endH - startH + 1 > MAX_MANUAL_SCAN_BLOCKS) {
      _scanLock = false;
      return res.json({ started: false, message: `Block range too large. Maximum ${MAX_MANUAL_SCAN_BLOCKS.toLocaleString()} blocks per scan.` });
    }
  }
  _lastScanCancelled = false; // new scan starting — clear any previous cancellation
  // B-BUG-03: Set activeScan state BEFORE responding so the client can start polling
  // immediately without racing against the state update.
  activeScan = { running: true, progress: 0, total: 0, found: 0, log: [], cancelled: false };
  res.json({ started: true });

  // Safety valve: if the scan is still running after 4 hours (e.g. sustained API outage),
  // cancel it so activeScan.running never stays true indefinitely.
  _scanTimeoutId = setTimeout(() => {
    if (activeScan && activeScan.running) {
      activeScan.cancelled = true;
      activeScan.log.push('Error: Scan timed out after 4 hours — cancelled automatically.');
    }
  }, 4 * 60 * 60 * 1000);

  try {
    const pubkeys = nodes.map(n => n.pubkey);

    let startH, endH;

    if (sh != null && eh != null) {
      // Manual block range — already validated before res.json, just parse with consistent radix
      startH = Number.parseInt(sh, 10);
      endH = Number.parseInt(eh, 10);
    } else {
      // Use cached stats — already refreshed every 60s in background
      activeScan.log.push("Reading network stats...");
      const stats = _cachedStats || await scanner.getNetworkStats();
      if (!stats) {
        activeScan.log.push("Error: Could not connect to explorer.beldex.io. Check your internet connection.");
        activeScan.running = false;
        return;
      }
      const currentHeight = stats.height;
      // Use wall-clock as the authoritative reference timestamp.
      // stats.last_timestamp can be stale (60s cache) or not match the top block's
      // actual timestamp, which throws off the estimate for historical dates.
      // Wall-clock is always accurate; we just need height↔time to be consistent.
      const currentTs = Math.floor(Date.now() / 1000);
      const todayStr = new Date().toISOString().slice(0, 10);

      // Calibrate actual block time once — avoids the hardcoded 120s assumption
      const avgBlockTime = await scanner.calibrateBlockTime(currentHeight, currentTs);
      activeScan.log.push(`Block time calibrated: ~${avgBlockTime.toFixed(1)}s/block`);

      if (fromDate && toDate) {
        // Date range scan
        activeScan.log.push(`Finding block range for ${fromDate} → ${toDate}...`);
        startH = await scanner.findStartHeightForDate(fromDate, currentHeight, currentTs, avgBlockTime);
        endH = toDate >= todayStr ? currentHeight : await scanner.findEndHeightForDate(toDate, currentHeight, currentTs, avgBlockTime);
      } else {
        // Single date scan
        const targetDate = date || todayStr;
        activeScan.log.push(`Finding block range for ${targetDate}...`);
        startH = await scanner.findStartHeightForDate(targetDate, currentHeight, currentTs, avgBlockTime);
        endH = targetDate === todayStr ? currentHeight : await scanner.findEndHeightForDate(targetDate, currentHeight, currentTs, avgBlockTime);
      }

      // Validate that date lookup succeeded
      if (startH == null || endH == null || isNaN(startH) || isNaN(endH) || startH > endH) {
        activeScan.log.push("Error: Could not determine block range for the given date. Try using Block Range mode instead.");
        activeScan.running = false;
        return;
      }
    }

    // Capture original range before resume may shift startH
    const originalStartH = startH;

    // Resume: if user clicked Resume, start from last saved height instead of startH
    if (resume) {
      const lastInfo = db.getLastScanInfo();
      const contextMatches = lastInfo &&
        lastInfo.start_height === originalStartH &&
        lastInfo.end_height === endH;
      if (contextMatches && lastInfo.last_scanned_height > originalStartH && lastInfo.last_scanned_height < endH) {
        const resumeFrom = lastInfo.last_scanned_height + 1;
        activeScan.log.push(`Resuming from block ${resumeFrom.toLocaleString()} (skipping already scanned blocks).`);
        startH = resumeFrom;
      } else if (lastInfo && !contextMatches) {
        activeScan.log.push("Previous scan was for a different range — starting from beginning.");
      } else {
        activeScan.log.push("No previous scan to resume — starting from beginning.");
      }
    }

    activeScan.total = endH - startH + 1;
    activeScan._startH = startH; activeScan._endH = endH;
    activeScan._startTime = Date.now();
    activeScan._dateFrom = fromDate || date || null;
    activeScan._dateTo = toDate || date || null;
    activeScan._scanType = (sh != null && eh != null) ? "block_range" : (fromDate && toDate ? "date_range" : "date");
    activeScan.log.push(`Scanning ${activeScan.total.toLocaleString()} blocks: ${startH.toLocaleString()} → ${endH.toLocaleString()}`);
    activeScan.log.push(`Using ${scanner.PARALLEL} parallel fetches — estimated time: ~${Math.ceil(activeScan.total / scanner.PARALLEL / 10 / 60)} min`);

    const scanResult = await scanner.scanBlocksForRewards(
      startH, endH, pubkeys,
      (scanned, total) => {
        if (!activeScan) return;
        activeScan.progress = scanned;
        activeScan.total = total;
      },
      () => !activeScan || activeScan.cancelled,
      (batch) => {
        if (!activeScan) return 0;
        let inserted = 0;
        if (batch.length > 0) {
          inserted = db.insertRewardsBatch(batch);
          activeScan.found = (activeScan.found || 0) + inserted;
        }
        // progress is already updated before save (see scanner.js ordering)
        // subtract 1: progress is a block count, last completed height is startH + progress - 1
        const lastScannedH = startH + activeScan.progress - 1;
        if (lastScannedH >= startH) db.setLastScannedHeight(lastScannedH, {
          startH: originalStartH, endH,
          scanType: activeScan._scanType,
          dateFrom: activeScan._dateFrom,
          dateTo: activeScan._dateTo
        });
        if (activeScan.log.length > 200) activeScan.log.splice(0, activeScan.log.length - 150);
        return inserted;
      }
    );

    // activeScan may be null if force-reset fired while the worker was running
    if (!activeScan) { _scanLock = false; return; }

    const durationSec = Math.round((Date.now() - (activeScan._startTime || Date.now())) / 1000);
    if (scanResult && scanResult.missed > 0) {
      activeScan.log.push(`⚠ ${scanResult.missed.toLocaleString()} block(s) could not be fetched after retries — those blocks were skipped and may contain undetected rewards.`);
    }
    if (activeScan.cancelled) {
      // progress is the real scanned count (not total) because scanner.js no longer fires progressCallback(total,total) on cancel
      activeScan.log.push(`Scan cancelled at block ${(startH + activeScan.progress - 1).toLocaleString()}. Found ${activeScan.found} rewards so far. You can resume later.`);
    } else {
      db.setLastScannedHeight(endH, {
        startH: originalStartH, endH,
        scanType: activeScan._scanType,
        dateFrom: activeScan._dateFrom,
        dateTo: activeScan._dateTo
      });
      // Boundary verification for date-based scans: confirm start/end blocks actually fall in target date
      if (activeScan._dateFrom && activeScan._dateTo) {
        try {
          const [bStart, bEnd] = await Promise.all([
            scanner.getBlock(startH),
            scanner.getBlock(endH)
          ]);
          const fmt = ts => ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '?';
          const startDateActual = fmt(bStart?.timestamp);
          const endDateActual = fmt(bEnd?.timestamp);
          if (startDateActual !== activeScan._dateFrom) {
            activeScan.log.push(`⚠ Boundary drift: start block ${startH} is ${startDateActual}, expected ${activeScan._dateFrom}`);
          }
          if (endDateActual !== activeScan._dateTo) {
            activeScan.log.push(`⚠ Boundary drift: end block ${endH} is ${endDateActual}, expected ${activeScan._dateTo}`);
          }
        } catch (_) { /* non-fatal — skip if API unreachable */ }
      }
      activeScan.log.push(`Done! Found ${activeScan.found} rewards. Scan complete.`);
      try {
        db.insertScanHistory(activeScan._scanType || "date", activeScan._dateFrom, activeScan._dateTo, startH, endH, activeScan.found, durationSec, scanResult ? scanResult.missed : 0);
      } catch (histErr) {
        console.error('[Scan] Failed to record scan history:', histErr.message);
      }
      clearReportCache();
    }
  } catch (e) {
    if (activeScan) {
      const safeMsg = String(e.message).split('\n')[0].slice(0, 200);
      activeScan.log.push('Error: ' + safeMsg);
    }
  } finally {
    clearTimeout(_scanTimeoutId);
    _scanTimeoutId = null;
    if (activeScan) activeScan.running = false;
    _scanLock = false;
  }
});

app.get("/api/scan/progress", (req, res) => {
  res.json(activeScan || { running: false, progress: 0, total: 0, found: 0, log: [] });
});

app.post("/api/scan/reset", (req, res) => {
  const force = req.query.force === 'true';
  if (!force && activeScan && activeScan.running) {
    return res.status(409).json({ error: "Cannot reset while scan is still running. Cancel it first, then reset." });
  }
  if (activeScan) { activeScan.cancelled = true; activeScan.running = false; }
  activeScan = null;
  clearTimeout(_scanTimeoutId);
  _scanTimeoutId = null;
  _scanLock = false;
  res.json({ ok: true });
});

app.post("/api/scan/cancel", (req, res) => {
  if (!activeScan) return res.json({ ok: true });
  // Capture local reference immediately — a concurrent force-reset could null activeScan
  // between the guard above and the property assignments below, causing a TypeError.
  const scan = activeScan;
  // Signal cancellation — the worker checks activeScan.cancelled and stops naturally.
  // Do NOT set scan.running = false here; the worker's finally block does that.
  scan.cancelled = true;
  _lastScanCancelled = true; // remember that this scan was cancelled — Resume becomes valid
  res.json({ ok: true });
});

// Explorer connectivity check (uses same path as the scanner itself)
app.get("/api/explorer/status", async (_req, res) => {
  const start = Date.now();
  try {
    const stats = await scanner.getNetworkStats();
    const latency = Date.now() - start;
    if (!stats) return res.json({ ok: false, latency, status: "offline" });
    res.json({ ok: true, latency, slow: latency > 3000, status: latency > 3000 ? "slow" : "ok", height: stats.height });
  } catch (e) {
    console.error('[Explorer status]', e && e.message ? e.message : e);
    res.json({ ok: false, latency: Date.now() - start, status: "offline", error: 'Explorer unreachable' });
  }
});

// Scan coverage calendar — returns which dates in the last N days were scanned
app.get("/api/scan/coverage", (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 180);
    const to   = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const scanned = db.getScannedDatesInRange(from, to);
    res.json({ from, to, scanned: [...scanned] });
  } catch (e) { sendInternalError(res, e); }
});


// Resume info — tells UI whether a resumable scan exists
app.get("/api/scan/resume-info", (req, res) => {
  const info = db.getLastScanInfo();
  res.json(info ? { height: info.last_scanned_height, lastScanTime: info.last_scan_time } : { height: null, lastScanTime: null });
});

// ─── Excel export helpers ────────────────────────────────
function buildDateRange(from, to) {
  const dates = [];
  const cur = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function buildFilledDailySeries(from, to, rows) {
  const rowMap = new Map((rows || []).map(r => [r.reward_date || r.date, r]));
  return buildDateRange(from, to).map(date => {
    const row = rowMap.get(date);
    const rewardCount = Number(row?.reward_count ?? row?.count ?? 0);
    const totalAmount = Number(row?.total_amount ?? row?.amount ?? 0);
    return {
      date,
      reward_date: date,
      count: rewardCount,
      reward_count: rewardCount,
      amount: totalAmount,
      total_amount: totalAmount
    };
  });
}

function buildMatrixReportData(from, to, tz = 'utc') {
  const rows = db.getMatrixData(from, to, tz);
  const walletSet = new Set();
  (db.getWalletGroups() || []).forEach(g => { if (g.wallet_name) walletSet.add(g.wallet_name); });
  rows.forEach(r => walletSet.add(r.wallet_name || "Ungrouped"));
  const wallets = [...walletSet].sort();
  const dates = buildDateRange(from, to);
  const cells = {};
  const counts = {};
  const walletTotals = {};
  const walletCounts = {};
  wallets.forEach(w => { walletTotals[w] = 0; walletCounts[w] = 0; });
  rows.forEach(r => {
    const date = r.reward_date;
    const wallet = r.wallet_name || "Ungrouped";
    const amount = Number(r.total_bdx || 0);
    const cnt = Number(r.reward_count || 0);
    if (!cells[date]) cells[date] = {};
    if (!counts[date]) counts[date] = {};
    cells[date][wallet] = amount;
    counts[date][wallet] = cnt;
    walletTotals[wallet] = (walletTotals[wallet] || 0) + amount;
    walletCounts[wallet] = (walletCounts[wallet] || 0) + cnt;
  });
  const scannedDateSet = db.getScannedDatesInRange(from, to);
  return {
    wallets,
    dates,
    cells,
    counts,
    walletTotals,
    walletCounts,
    scannedDates: [...scannedDateSet],
    scannedDays: scannedDateSet.size,
    rewardedDays: Object.keys(cells).length,
    totalDays: dates.length
  };
}


// ─── Status Check ─────────────────────────────────────────
let activeStatus = null;

app.post("/api/status/check", async (req, res) => {
  if (activeStatus && activeStatus.running) {
    return res.json({ started: false, message: "Status check already running" });
  }
  // B-RACE-02: No await exists between the activeStatus.running check above and the
  // assignment below — db.getAllNodes() and res.json() are synchronous. Node.js
  // single-thread guarantees no concurrent entry can occur between them; no lock needed.
  const nodes = db.getAllNodes();
  if (!nodes.length) {
    return res.json({ started: false, message: 'No nodes registered.' });
  }
  activeStatus = { running: true, checked: 0, total: nodes.length, results: [], cancelled: false };
  res.json({ started: true });

  (async () => {
    try {
      const pubkeys = nodes.map(n => n.pubkey);
      const nodeMap = new Map(nodes.map(n => [n.pubkey, n]));

      const statusMap = await scanner.getAllNodeStatuses(
        pubkeys,
        (checked) => { activeStatus.checked = checked; },
        () => activeStatus.cancelled
      );

      for (const [pubkey, result] of statusMap) {
        const node = nodeMap.get(pubkey);
        db.saveNodeStatus(pubkey, result.status, result.last_uptime_proof, result.version);
        activeStatus.results.push({ ...result, pubkey, label: node?.label, walletName: node?.wallet_name });
      }
    } catch (e) {
      console.error("[Status] Error during status check:", e.message);
      for (const node of nodes) {
        if (!activeStatus.results.find(r => r.pubkey === node.pubkey)) {
          activeStatus.results.push({ status: "unknown", last_uptime_proof: null, version: "API error", pubkey: node.pubkey, label: node.label, walletName: node.wallet_name });
          activeStatus.checked++;
        }
      }
    } finally {
      try { db.pruneNodeStatus(NODE_STATUS_RETENTION_DAYS); }
      catch (e) { console.error("[Status] prune failed:", e.message); }
      activeStatus.running = false;
    }
  })();
});

app.post("/api/status/cancel", (req, res) => {
  if (activeStatus) { activeStatus.cancelled = true; }
  res.json({ ok: true });
});

app.get("/api/status/progress", (req, res) => {
  res.json(activeStatus || { running: false, checked: 0, total: 0, results: [] });
});

app.get("/api/status/latest", (req, res) => {
  res.json(db.getLatestNodeStatus());
});

// ─── Excel Export — matches page format exactly ───────────
app.get("/api/export/excel", destructiveLimiter, async (req, res) => {
  const { type, date, year, month, from, to } = req.query;
  // B-SEC-05: Sanitise type before using it in Content-Disposition filename — prevents header injection.
  const safeType = String(type || '').replace(/[^a-z0-9\-_]/gi, '').slice(0, 32) || 'export';
  const tz = req.query.tz === 'ist' ? 'ist' : 'utc';

  // B-SCALE-01: Hard cap — prevent OOM from excessively large date-range exports.
  if (from && to && isValidDate(from) && isValidDate(to)) {
    const daysDiff = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000);
    if (daysDiff > 366) {
      return res.status(400).json({ error: 'Excel export is limited to 366 days. Use a narrower date range.' });
    }
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Beldex Masternode Monitor";
  wb.created = new Date();

  // ── Style helpers ──────────────────────────────────────
  const HDR = { font: { bold: true, color: { argb: "FFFFFFFF" }, size: 11 }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D1B69" } }, alignment: { horizontal: "center", vertical: "middle" }, border: { bottom: { style: "medium", color: { argb: "FF8B5CF6" } } } };
  const ALT = {};
  const TOTAL = { font: { bold: true, size: 11 } };
  const TITLE = { font: { bold: true, size: 13 } };
  const SUMMARY = { font: { bold: true, size: 11 } };

  function setupSheet(sheet, cols, rowH = 20) {
    sheet.columns = cols;
    const hdrRow = sheet.getRow(1);
    hdrRow.height = rowH;
    hdrRow.eachCell(cell => {
      cell.font = HDR.font; cell.fill = HDR.fill;
      cell.alignment = HDR.alignment; cell.border = HDR.border;
    });
  }

  function addSummaryBlock(sheet, startRow, label, value) {
    const r = sheet.getRow(startRow);
    r.getCell(1).value = label; r.getCell(1).font = SUMMARY.font;
    r.getCell(2).value = value; r.getCell(2).font = SUMMARY.font;
    r.height = 22;
  }

  const shortPk = pk => pk && pk.length > 20 ? pk.slice(0, 12) + '...' + pk.slice(-6) : (pk || '-');
  const priceCache = db.getLatestPrice();
  const bdxUsd = priceCache ? priceCache.bdx_usd : null;
  const bdxInr = priceCache ? priceCache.bdx_inr : null;

  // ── Fetch reward data based on report type ─────────────
  let rewardRows = [], dailyRows = [], perKeyRows = [], sheetTitle = "Rewards", periodLabel = "";

  if (type === "per-key") {
    const fromDate = from || new Date().toISOString().slice(0, 10);
    const toDate = to || fromDate;
    if (validateDateRange(res, fromDate, toDate)) return;
    perKeyRows = db.getPerKeyReport(fromDate, toDate, tz);
    sheetTitle = `PerKey_${fromDate}_to_${toDate}`;
    periodLabel = `Per-Key Report: ${fromDate} → ${toDate}`;
  } else if (type === "daily" && date) {
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date' });
    rewardRows = db.getDailySummary(date, tz);
    sheetTitle = `Daily_${date}`;
    periodLabel = `Date: ${date}`;
  } else if (type === "monthly" && year && month) {
    const y = parseInt(year), m = parseInt(month);
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12 || y < 2020 || y > 2100) return res.status(400).json({ error: 'Invalid year or month' });
    rewardRows = db.getMonthlySummary(parseInt(year), parseInt(month), tz);
    const monthFrom = `${year}-${String(month).padStart(2,'0')}-01`;
    const monthTo = new Date(Date.UTC(parseInt(year), parseInt(month), 0)).toISOString().slice(0, 10);
    dailyRows = buildFilledDailySeries(monthFrom, monthTo, db.getDateRangeDailyTotals(monthFrom, monthTo, tz));
    sheetTitle = `Monthly_${year}-${String(month).padStart(2,'0')}`;
    periodLabel = `Month: ${year}-${String(month).padStart(2,'0')}`;
  } else if (type === "range" && from && to) {
    if (validateDateRange(res, from, to)) return;
    rewardRows = db.getDateRangeSummary(from, to, tz);
    dailyRows = buildFilledDailySeries(from, to, db.getDateRangeDailyTotals(from, to, tz));
    sheetTitle = `Range_${from}_to_${to}`;
    periodLabel = `Range: ${from} → ${to}`;
  }

  const totalBdx = type === "per-key"
    ? perKeyRows.reduce((s, r) => s + (r.total_amount || 0), 0)
    : rewardRows.reduce((s, r) => s + (r.total_amount || 0), 0);
  const totalEvents = type === "per-key"
    ? perKeyRows.reduce((s, r) => s + (r.reward_count || 0), 0)
    : rewardRows.reduce((s, r) => s + (r.reward_count || 0), 0);
  const nodesEarned = type === "per-key"
    ? perKeyRows.filter(r => r.reward_count > 0).length
    : rewardRows.filter(r => r.reward_count > 0).length;

  // ── Handle By Wallet export ────────────────────────────
  if (type === "grouped" && from && to) {
    if (validateDateRange(res, from, to)) return;
    try {
      const groups = db.getWalletGroupReport(from, to, tz);
      const gsht = wb.addWorksheet("By Wallet");
      setupSheet(gsht, [
        { header: "Wallet / Hub", key: "wallet_name", width: 22 },
        { header: "Nodes", key: "node_count", width: 10 },
        { header: "Rewards", key: "reward_count", width: 12 },
        { header: "Total BDX", key: "total_bdx", width: 18 },
      ], 22);
      const gTotal = groups.reduce((s, g) => s + (g.total_bdx || 0), 0);
      groups.forEach((g, i) => {
        const row = gsht.addRow({ wallet_name: g.wallet_name || "Ungrouped", node_count: g.node_count, reward_count: g.reward_count, total_bdx: parseFloat((g.total_bdx || 0).toFixed(4)) });
        row.height = 20;
      });
      const totRow = gsht.addRow({ wallet_name: "TOTAL", node_count: groups.reduce((s,g)=>s+(g.node_count||0),0), reward_count: groups.reduce((s,g)=>s+(g.reward_count||0),0), total_bdx: parseFloat(gTotal.toFixed(4)) });
      totRow.height = 22; totRow.eachCell(c => { c.font = TOTAL.font; });
      const filename = `beldex_by_wallet_${from}_to_${to}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      await wb.xlsx.write(res); return res.end();
    } catch(e) { return sendInternalError(res, e); }
  }

  // ── Handle Matrix export ───────────────────────────────
  if (type === "matrix" && from && to) {
    if (validateDateRange(res, from, to)) return;
    try {
      const { wallets, dates, cells, walletTotals } = buildMatrixReportData(from, to, tz);
      const msht = wb.addWorksheet("Matrix");
      const mcols = [{ header: "Date", key: "date", width: 14 }, ...wallets.map(w => ({ header: w, key: w, width: 14 })), { header: "Day Total", key: "total", width: 14 }];
      setupSheet(msht, mcols, 22);
      // Wallet totals row
      const wtRow = msht.addRow({ date: "WALLET TOTAL", ...Object.fromEntries(wallets.map(w => [w, parseFloat((walletTotals[w]||0).toFixed(4))])), total: parseFloat(wallets.reduce((s,w)=>s+(walletTotals[w]||0),0).toFixed(4)) });
      wtRow.height = 20; wtRow.eachCell(c => { c.font = { bold: true }; });
      dates.forEach((date, i) => {
        const dayTotal = wallets.reduce((s,w) => s + (cells[date]?.[w] || 0), 0);
        const rowData = { date, ...Object.fromEntries(wallets.map(w => [w, cells[date]?.[w] ? parseFloat(cells[date][w].toFixed(4)) : ''])), total: parseFloat(dayTotal.toFixed(4)) };
        const row = msht.addRow(rowData);
        row.height = 18;
        row.getCell('total').font = { bold: true };
      });
      const filename = `beldex_matrix_${from}_to_${to}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      await wb.xlsx.write(res); return res.end();
    } catch(e) { return sendInternalError(res, e); }
  }

  // ── SHEET 1: Summary — exact match to UI summary cards ──
  const sumSht = wb.addWorksheet("Summary");
  sumSht.columns = [{ width: 22 }, { width: 20 }];
  const titleRow = sumSht.getRow(1);
  titleRow.getCell(1).value = `Beldex Masternode Monitor — ${type ? type.charAt(0).toUpperCase()+type.slice(1) : 'Report'}`;
  titleRow.getCell(1).font = TITLE.font;
  titleRow.getCell(2).value = periodLabel;
  titleRow.getCell(2).font = { italic: true };
  titleRow.height = 28;
  sumSht.getRow(2).height = 8;
  addSummaryBlock(sumSht, 3, "Total Nodes", db.getAllNodes().length);
  addSummaryBlock(sumSht, 4, "Nodes Earned", nodesEarned);
  addSummaryBlock(sumSht, 5, "Reward Events", totalEvents);
  addSummaryBlock(sumSht, 6, "Total BDX", parseFloat(totalBdx.toFixed(4)));

  // ── SHEET 2: Per-Key Report (pubkey + wallet_address) ──
  if (type === "per-key" && perKeyRows.length) {
    const pkcols = [
      { header: "#", key: "idx", width: 5 },
      { header: "Label", key: "label", width: 16 },
      { header: "Hub / Group", key: "wallet_name", width: 16 },
      { header: "Public Key", key: "pubkey", width: 30 },
      { header: "Wallet Address", key: "wallet_address", width: 30 },
      { header: "Rewards", key: "reward_count", width: 10 },
      { header: "Total BDX", key: "total_bdx", width: 16 },
      { header: "Avg / Reward", key: "avg_bdx", width: 14 },
      { header: "First Reward", key: "first_reward_date", width: 14 },
      { header: "Last Reward", key: "last_reward_date", width: 14 },
    ];
    if (bdxUsd) pkcols.push({ header: "USD Value", key: "usd", width: 14 });
    if (bdxInr) pkcols.push({ header: "INR Value", key: "inr", width: 16 });

    const pksht = wb.addWorksheet("Per-Key Rewards");
    setupSheet(pksht, pkcols, 22);
    perKeyRows.forEach((r, i) => {
      const avg = r.reward_count > 0 ? r.total_amount / r.reward_count : 0;
      const rowData = {
        idx: i + 1, label: r.label || "-", wallet_name: r.wallet_name || "-",
        pubkey: r.pubkey || "-", wallet_address: r.wallet_address || "-",
        reward_count: r.reward_count,
        total_bdx: parseFloat(r.total_amount.toFixed(4)),
        avg_bdx: parseFloat(avg.toFixed(4)),
        first_reward_date: r.first_reward_date || "-",
        last_reward_date: r.last_reward_date || "-",
      };
      if (bdxUsd) rowData.usd = `$${(r.total_amount * bdxUsd).toFixed(2)}`;
      if (bdxInr) rowData.inr = `₹${Math.round(r.total_amount * bdxInr).toLocaleString()}`;
      const row = pksht.addRow(rowData);
      row.height = 18;
      row.getCell('pubkey').font = { name: "Courier New", size: 9 };
      row.getCell('wallet_address').font = { name: "Courier New", size: 9 };
    });
    const totData = { idx: "", label: "TOTAL", wallet_name: "", pubkey: "", wallet_address: "", reward_count: totalEvents, total_bdx: parseFloat(totalBdx.toFixed(4)), avg_bdx: "", first_reward_date: "", last_reward_date: "" };
    if (bdxUsd) totData.usd = `$${(totalBdx * bdxUsd).toFixed(2)}`;
    if (bdxInr) totData.inr = `₹${Math.round(totalBdx * bdxInr).toLocaleString()}`;
    const totRow = pksht.addRow(totData);
    totRow.height = 22;
    totRow.eachCell(c => { c.font = TOTAL.font; });
  }

  // ── SHEET 2: Node Rewards — exactly matches UI table ──────
  // UI shows: Label | Wallet | Rewards | Total BDX
  if (type !== "per-key" && rewardRows.length) {
    const rsht = wb.addWorksheet("Rewards");
    setupSheet(rsht, [
      { header: "Label", key: "label", width: 20 },
      { header: "Wallet", key: "wallet_name", width: 20 },
      { header: "Rewards", key: "reward_count", width: 12 },
      { header: "Total BDX", key: "total_bdx", width: 18 },
    ], 22);
    rewardRows.forEach((r, i) => {
      const row = rsht.addRow({ label: r.label || "-", wallet_name: r.wallet_name || "-", reward_count: r.reward_count, total_bdx: parseFloat(r.total_amount.toFixed(4)) });
      row.height = 18;
    });
    const totRow = rsht.addRow({ label: "TOTAL", wallet_name: "", reward_count: totalEvents, total_bdx: parseFloat(totalBdx.toFixed(4)) });
    totRow.height = 22; totRow.eachCell(c => { c.font = TOTAL.font; });
  }

  // ── SHEET 3: Daily Breakdown (monthly + range) ─────────
  // UI shows: Date | Events | BDX
  if (dailyRows.length) {
    const dsht = wb.addWorksheet("Daily");
    setupSheet(dsht, [
      { header: "Date", key: "reward_date", width: 14 },
      { header: "Events", key: "reward_count", width: 12 },
      { header: "Total BDX", key: "total_amount", width: 18 },
    ], 22);
    dailyRows.forEach((d, i) => {
      const row = dsht.addRow({ reward_date: d.reward_date, reward_count: d.reward_count, total_amount: parseFloat(d.total_amount.toFixed(4)) });
      row.height = 18;
    });
  }

  const safeSheetTitle = sheetTitle.replace(/[^a-z0-9\-_]/gi, '_').slice(0, 64) || safeType;
  const filename = `beldex_${safeSheetTitle}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

// ─── Scan last height / resume info ──────────────────────
app.get("/api/scan/last-height", (req, res) => {
  const info = db.getLastScanInfo();
  res.json(info
    ? { height: info.last_scanned_height, lastScanTime: info.last_scan_time, cancelled: _lastScanCancelled }
    : { height: null, lastScanTime: null, cancelled: false });
});

app.get("/api/scan/quality", (req, res) => {
  try {
    res.json(db.getDataQuality());
  } catch (e) {
    sendInternalError(res, e);
  }
});

app.get("/api/scan/gaps", (req, res) => {
  try {
    const threshold = Math.min(Math.max(1, parseInt(req.query.threshold) || 300), 100000);
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from_date || "")
      ? req.query.from_date : null;
    const gaps = db.findScanGaps(threshold, fromDate);
    res.json({ gaps, threshold, from_date: fromDate });
  } catch (e) {
    sendInternalError(res, e);
  }
});

// ─── Auto-Scan Scheduler ─────────────────────────────────
let _schedulerTimer = null;
let _schedulerConfig = schedulerCfg.loadConfig();

function runAutoScan() {
  if (_scanLock || (activeScan && activeScan.running)) {
    console.log("[Scheduler] Skipping auto-scan — scan in progress");
    return;
  }
  const nodes = db.getAllNodes();
  if (!nodes.length) {
    console.log("[Scheduler] Skipping auto-scan — no nodes registered");
    return;
  }
  _scanLock = true;
  _lastScanCancelled = false;

  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // dateFrom for scan history: day after last completed date, or yesterday if never run
  let dateFrom;
  if (_schedulerConfig.lastAutoScanDate) {
    const d = new Date(_schedulerConfig.lastAutoScanDate + 'T00:00:00Z');
    dateFrom = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
  } else {
    dateFrom = yesterdayStr;
  }

  console.log(`[Scheduler] Auto-scan triggered. Covering ${dateFrom} → ${todayStr}`);
  activeScan = { running: true, progress: 0, total: 0, found: 0, log: [`[Auto] Covering ${dateFrom} → ${todayStr}`], cancelled: false };
  const pubkeys = nodes.map(n => n.pubkey);
  const _autoScanStartTs = Date.now();

  (async () => {
    let startH, endH;
    try {
      const stats = await scanner.getNetworkStats();
      if (!stats) { activeScan.log.push("[Auto] Error: Could not reach explorer."); activeScan.running = false; _scanLock = false; return; }
      const currentHeight = stats.height;
      const currentTs = Math.floor(Date.now() / 1000);

      // Use own height tracker — independent of manual scans
      if (_schedulerConfig.lastAutoScanHeight) {
        startH = _schedulerConfig.lastAutoScanHeight + 1;
      } else {
        const avgBlockTime = await scanner.calibrateBlockTime(currentHeight, currentTs);
        startH = await scanner.findStartHeightForDate(yesterdayStr, currentHeight, currentTs, avgBlockTime);
      }

      endH = currentHeight;

      if (!startH || isNaN(startH)) { activeScan.log.push("[Auto] Error: Could not find start block."); activeScan.running = false; _scanLock = false; return; }

      // Nothing new to scan
      if (startH > endH) {
        activeScan.log.push("[Auto] Already up to date — nothing to scan.");
        console.log("[Scheduler] Already up to date, skipping.");
        activeScan.running = false; _scanLock = false; return;
      }

      activeScan.total = endH - startH + 1;
      activeScan.log.push(`[Auto] Scanning ${activeScan.total.toLocaleString()} blocks: ${startH.toLocaleString()} → ${endH.toLocaleString()}`);

      await scanner.scanBlocksForRewards(startH, endH, pubkeys,
        (scanned, total) => { activeScan.progress = scanned; activeScan.total = total; },
        () => !activeScan || activeScan.cancelled,
        (batch) => {
          if (!activeScan) return 0;
          let inserted = 0;
          if (batch.length > 0) { inserted = db.insertRewardsBatch(batch); activeScan.found = (activeScan.found || 0) + inserted; }
          const cur = startH + activeScan.progress - 1;
          if (cur > startH) db.setLastScannedHeight(cur, { startH, endH, scanType: 'auto', dateFrom, dateTo: todayStr });
          return inserted;
        }
      );

      // If scan was cancelled, do not record completion
      if (!activeScan || activeScan.cancelled) {
        console.log("[Scheduler] Auto-scan cancelled — completion not recorded.");
        return;
      }

      db.setLastScannedHeight(endH, { startH, endH, scanType: 'auto', dateFrom, dateTo: todayStr });
      activeScan.log.push(`[Auto] Done! Found ${activeScan.found} rewards.`);
      console.log(`[Scheduler] Auto-scan complete. Found ${activeScan.found} rewards.`);
      const durationSec = Math.round((Date.now() - _autoScanStartTs) / 1000);
      db.insertScanHistory("auto", dateFrom, todayStr, startH, endH, activeScan.found, durationSec);
      clearReportCache();

      // Save completion state — only on success, never on error or cancel
      _schedulerConfig.lastAutoScanHeight = endH;
      _schedulerConfig.lastAutoScanDate = todayStr;
      _schedulerConfig.lastAutoScan = new Date().toISOString();
      schedulerCfg.saveConfig(_schedulerConfig);

    } catch (e) {
      const safeMsg = String(e.message).split('\n')[0].slice(0, 200);
      if (activeScan) activeScan.log.push('[Auto] Error: ' + safeMsg);
      // Intentionally NOT saving config — next run will retry from lastAutoScanHeight
    } finally {
      if (activeScan) activeScan.running = false;
      _scanLock = false;
    }
  })();
}

function applyScheduler() {
  if (_schedulerTimer) { clearInterval(_schedulerTimer); _schedulerTimer = null; }
  if (_schedulerConfig.enabled && _schedulerConfig.intervalHours > 0) {
    const ms = _schedulerConfig.intervalHours * 60 * 60 * 1000;
    _schedulerTimer = setInterval(runAutoScan, ms);
    console.log(`[Scheduler] Auto-scan enabled every ${_schedulerConfig.intervalHours}h`);
    // Startup catchup: if last scan was more than one interval ago, run now
    if (_schedulerConfig.lastAutoScan) {
      const elapsed = Date.now() - new Date(_schedulerConfig.lastAutoScan).getTime();
      if (elapsed > ms) {
        console.log(`[Scheduler] Overdue by ${Math.round(elapsed / 3600000)}h — running catchup scan`);
        setTimeout(runAutoScan, 8000); // small delay so server fully starts first
      }
    } else {
      // Never run before — run initial scan shortly after startup
      console.log('[Scheduler] Never run yet — running initial scan after startup');
      setTimeout(runAutoScan, 8000);
    }
  }
}

// GET scheduler config
app.get("/api/scheduler", (_req, res) => {
  res.json(_schedulerConfig);
});

// POST to update scheduler config
app.post("/api/scheduler", (req, res) => {
  const { enabled, intervalHours } = req.body;
  if (typeof enabled === "boolean") _schedulerConfig.enabled = enabled;
  if ([1, 4, 12, 24].includes(Number(intervalHours))) _schedulerConfig.intervalHours = Number(intervalHours);
  schedulerCfg.saveConfig(_schedulerConfig);
  applyScheduler();
  res.json(_schedulerConfig);
});


// ─── Targeted Block Scan ──────────────────────────────────

app.post("/api/scan/targeted", destructiveLimiter, async (req, res) => {
  if (_scanLock || (activeScan && activeScan.running))
    return res.status(409).json({ error: 'A scan is already running — wait for it to finish' });
  const { block_heights } = req.body || {};
  if (!Array.isArray(block_heights) || !block_heights.length)
    return res.status(400).json({ error: 'block_heights must be a non-empty array' });
  if (block_heights.length > 2000)
    return res.status(400).json({ error: 'Maximum 2000 block heights per request' });
  const heights = [...new Set(block_heights.filter(h => Number.isInteger(h) && h > 0))];
  if (!heights.length) return res.status(400).json({ error: 'No valid block heights provided' });

  const allNodes = db.getAllNodes();
  const pubkeys = allNodes.map(n => n.pubkey);
  if (!pubkeys.length) return res.status(400).json({ error: 'No tracked nodes found' });

  const existingSet = db.getExistingBlockHeightsForNodes(pubkeys, heights);
  const newHeights = heights.filter(h => !existingSet.has(h));
  const alreadyHad = heights.length - newHeights.length;

  if (!newHeights.length)
    return res.json({ found: 0, scanned: 0, already_had: alreadyHad, missed: 0, message: 'All blocks already in database' });

  try {
    const { rewards, missed } = await scanner.scanSpecificBlocks(newHeights, pubkeys);
    const inserted = rewards.length ? db.insertRewardsBatch(rewards) : 0;
    res.json({ found: inserted, scanned: newHeights.length, already_had: alreadyHad, missed });
  } catch (e) { sendInternalError(res, e); }
});

// ─── Smart Backfill ───────────────────────────────────────

let _backfillState = { running: false, progress: 0, total: 0, log: [] };

app.get("/api/backfill/gaps", (req, res) => {
  try {
    const { from, to } = req.query;
    const gaps = (from && to && isValidDate(from) && isValidDate(to))
      ? db.detectRewardGapsInRange(from, to, 1)
      : db.detectRewardGaps();
    res.json({ gaps, count: gaps.length });
  } catch (e) { sendInternalError(res, e); }
});

app.get("/api/backfill/status", (_req, res) => {
  res.json(_backfillState);
});

app.post("/api/backfill/trigger", async (req, res) => {
  if (_backfillState.running) return res.json({ ok: false, message: "Backfill already running" });
  if (activeScan && activeScan.running) return res.json({ ok: false, message: "Manual scan in progress — wait for it to finish" });
  const { from_date, to_date } = req.body || {};
  const useRange = from_date && to_date && isValidDate(from_date) && isValidDate(to_date);
  // B-RACE-01: No await exists between the _backfillState.running check above and this
  // assignment — Node.js single-thread guarantees no concurrent entry between them.
  // No _backfillLock is needed.
  _backfillState = { running: true, progress: 0, total: 0, log: [], found: 0, cancelled: false };
  res.json({ ok: true, message: "Backfill started" });

  (async () => {
    try {
      const gaps = useRange
        ? db.detectRewardGapsInRange(from_date, to_date, 1)
        : db.detectRewardGaps();
      if (!gaps.length) { _backfillState.log.push("No gaps detected — database looks complete."); return; }

      // Save gaps to DB for tracking
      db.clearBackfillGaps();
      for (const g of gaps) db.saveBackfillGap(g.pubkey, g.gap_from, g.gap_to);

      _backfillState.log.push(`Detected ${gaps.length} gaps across ${new Set(gaps.map(g => g.pubkey)).size} nodes.`);
      _backfillState.total = gaps.length;

      const stats = _cachedStats || await scanner.getNetworkStats();
      if (!stats) { _backfillState.log.push("Error: Cannot reach explorer"); return; }

      const currentHeight = stats.height;
      const currentTs = stats.last_timestamp || Math.floor(Date.now() / 1000);
      const avgBlockTime = await scanner.calibrateBlockTime(currentHeight, currentTs);
      _backfillState.log.push(`Block time: ~${avgBlockTime.toFixed(1)}s/block`);

      const allNodes = db.getAllNodes();
      const pubkeyMap = new Map(allNodes.map(n => [n.pubkey, n]));

      for (let i = 0; i < gaps.length; i++) {
        const gap = gaps[i];
        _backfillState.progress = i + 1;
        const node = pubkeyMap.get(gap.pubkey);
        _backfillState.log.push(`Gap ${i + 1}/${gaps.length}: ${node?.label || gap.pubkey.slice(0, 12)}... ${gap.gap_from} → ${gap.gap_to} (${gap.days}d)`);

        try {
          const startH = await scanner.findStartHeightForDate(gap.gap_from, currentHeight, currentTs, avgBlockTime);
          const endH = await scanner.findEndHeightForDate(gap.gap_to, currentHeight, currentTs, avgBlockTime);
          if (!startH || !endH) { _backfillState.log.push(`  Could not find block range — skipping`); continue; }

          let gapFound = 0;
          await scanner.scanBlocksForRewards(
            startH, endH, [gap.pubkey],
            () => {},
            () => _backfillState.cancelled,
            (batch) => {
              if (batch.length > 0) {
                const ins = db.insertRewardsBatch(batch);
                gapFound += ins;
                _backfillState.found = (_backfillState.found || 0) + ins;
              }
              return batch.length;
            }
          );
          _backfillState.log.push(`  Found ${gapFound} rewards in gap.`);
        } catch (e) {
          _backfillState.log.push(`  Error: ${e.message}`);
        }

        if (_backfillState.log.length > 300) _backfillState.log.splice(0, 100);
        if (_backfillState.cancelled) break;
      }
      _backfillState.log.push(`Backfill complete. Total found: ${_backfillState.found} rewards.`);
    } catch (e) {
      _backfillState.log.push(`Fatal error: ${e.message}`);
    } finally {
      _backfillState.running = false;
    }
  })();
});

app.post("/api/backfill/cancel", (_req, res) => {
  _backfillState.cancelled = true;
  res.json({ ok: true });
});

// ─── Background jobs ──────────────────────────────────────

// Daily uptime snapshot: prune old history + record today's status from latest node_status
function recordDailyUptimeSnapshot() {
  const latest = db.getLatestNodeStatus();
  for (const s of latest) {
    let proofAge = null;
    if (s.last_uptime_proof && s.last_uptime_proof !== "Not Received") {
      const parts = String(s.last_uptime_proof).split(":");
      proofAge = parseFloat(parts[0]) || null;
    }
    db.saveUptimeSnapshot(s.pubkey, s.status, proofAge);
  }
  db.pruneUptimeHistory(90);
}

// Hourly background network stats snapshot
async function recordNetworkStatsSnapshot() {
  try {
    const [stats, mnStats] = await Promise.all([
      Promise.resolve(_cachedStats || scanner.getNetworkStats()).catch(() => null),
      scanner.getMasterNodeStats().catch(() => null),
    ]);
    const total = mnStats?.funded;
    const active = mnStats?.active;
    if (typeof total === 'number' && typeof active === 'number') db.saveNetworkStats(total, active);
  } catch (e) { /* silent */ }
}

// Run daily at 00:05 UTC. Also fires once on startup so a mid-day restart doesn't skip today's snapshot.
function scheduleDailyJobs() {
  recordDailyUptimeSnapshot(); // capture on startup in case server restarted after 00:05 UTC
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0));
  const msUntil = next - now;
  setTimeout(() => {
    recordDailyUptimeSnapshot();
    setInterval(recordDailyUptimeSnapshot, 24 * 60 * 60 * 1000);
  }, msUntil);
}

// Record network stats every hour
setInterval(recordNetworkStatsSnapshot, 60 * 60 * 1000);
// Run once on startup (delayed 10s)
setTimeout(recordNetworkStatsSnapshot, 10000);

// ─── Graceful shutdown ────────────────────────────────────
let _shutdownInProgress = false;
function gracefulShutdown(signal) {
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;
  console.log(`\n[${signal}] Shutting down...`);
  if (_schedulerTimer) clearInterval(_schedulerTimer);
  const hadWorker =
    (activeScan && activeScan.running) ||
    (activeStatus && activeStatus.running) ||
    (_backfillState && _backfillState.running);
  if (activeScan && activeScan.running) activeScan.cancelled = true;
  if (activeStatus && activeStatus.running) activeStatus.cancelled = true;
  if (_backfillState && _backfillState.running) _backfillState.cancelled = true;
  setTimeout(() => {
    db.closeDb();
    process.exit(0);
  }, hadWorker ? 1500 : 0);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ─── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Beldex Monitor running at http://localhost:${PORT}\n`);
  db.ensureAdminExists(_adminPasswordHash);

  // Warn about operator accounts still using legacy SHA-256 password hashes.
  // SHA-256 has no work factor and is trivially GPU-crackable if the DB is exposed.
  // These accounts auto-upgrade to scrypt on next successful login.
  try {
    const legacy = db.getLegacyHashOperators();
    if (legacy.length) {
      console.warn(`[Security] ${legacy.length} operator account(s) still use legacy SHA-256 password hashes: ${legacy.map(o => o.username).join(', ')}. They will be upgraded to scrypt automatically on next login. Ask these operators to log in soon.`);
    }
  } catch (e) { /* non-fatal */ }

  applyScheduler();
  scheduleDailyJobs();
});
