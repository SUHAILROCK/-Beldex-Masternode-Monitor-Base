'use strict';
/**
 * routes/reports.js — Daily, monthly, range, per-key, chart, grouped, matrix,
 *                     scan history, BDX price, and CSV export.
 */

const db      = require('../db');
const scanner = require('../scanner');
const { sendInternalError, isValidDate, validateDateRange, destructiveLimiter } = require('../lib/shared');

// ── Report cache (60-second TTL) ─────────────────────────
const _reportCache = new Map();
const REPORT_TTL = 60 * 1000;
const MAX_CACHE_SIZE = 200;
function cacheGet(key) {
  const entry = _reportCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { _reportCache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  _reportCache.set(key, { exp: Date.now() + REPORT_TTL, data });
  if (_reportCache.size > MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of _reportCache) {
      if (now > v.exp) _reportCache.delete(k);
    }
    if (_reportCache.size > MAX_CACHE_SIZE) {
      const toDelete = _reportCache.size - 150;
      let deleted = 0;
      for (const k of _reportCache.keys()) {
        if (deleted >= toDelete) break;
        _reportCache.delete(k);
        deleted++;
      }
    }
  }
}
function cacheClear() { _reportCache.clear(); }

// ── Date/matrix helper functions ─────────────────────────

function buildDateRange(from, to) {
  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to   + 'T00:00:00Z');
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
    const rewardCount  = Number(row?.reward_count ?? row?.count  ?? 0);
    const totalAmount  = Number(row?.total_amount ?? row?.amount ?? 0);
    return { date, reward_date: date, count: rewardCount, reward_count: rewardCount, amount: totalAmount, total_amount: totalAmount };
  });
}

function buildMatrixReportData(from, to, tz = 'utc') {
  const rows      = db.getMatrixData(from, to, tz);
  const walletSet = new Set();
  (db.getWalletGroups() || []).forEach(g => { if (g.wallet_name) walletSet.add(g.wallet_name); });
  rows.forEach(r => walletSet.add(r.wallet_name || 'Ungrouped'));
  const wallets = [...walletSet].sort();
  const dates   = buildDateRange(from, to);
  const cells = {}, counts = {}, walletTotals = {}, walletCounts = {};
  wallets.forEach(w => { walletTotals[w] = 0; walletCounts[w] = 0; });
  rows.forEach(r => {
    const date   = r.reward_date;
    const wallet = r.wallet_name || 'Ungrouped';
    const amount = Number(r.total_bdx || 0);
    const cnt    = Number(r.reward_count || 0);
    if (!cells[date])  cells[date]  = {};
    if (!counts[date]) counts[date] = {};
    cells[date][wallet]  = amount;
    counts[date][wallet] = cnt;
    walletTotals[wallet] = (walletTotals[wallet] || 0) + amount;
    walletCounts[wallet] = (walletCounts[wallet] || 0) + cnt;
  });
  const scannedDateSet = db.getScannedDatesInRange(from, to);
  return { wallets, dates, cells, counts, walletTotals, walletCounts, scannedDates: [...scannedDateSet], scannedDays: scannedDateSet.size, rewardedDays: Object.keys(cells).length, totalDays: dates.length };
}

const PRICE_TTL = 15 * 60 * 1000;

function registerReports(app) {
  app.get('/api/report/daily', (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const tz   = req.query.tz === 'ist' ? 'ist' : 'utc';
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date' });
    const key = 'daily:' + date + ':' + tz;
    const hit = cacheGet(key);
    if (hit) return res.json(hit);
    const summary  = db.getDailySummary(date, tz);
    const allNodes = db.getAllNodes();
    const rewardedPks = new Set(summary.map(r => r.pubkey));
    const noReward    = allNodes.filter(n => !rewardedPks.has(n.pubkey));
    const totalBdx    = summary.reduce((s, r) => s + r.total_amount, 0);
    const payload = { date, summary, noReward, totalBdx, totalNodes: allNodes.length };
    cacheSet(key, payload);
    res.json(payload);
  });

  app.get('/api/report/monthly', (req, res) => {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    const tz    = req.query.tz === 'ist' ? 'ist' : 'utc';
    if (year < 2020 || year > 2100 || month < 1 || month > 12) return res.status(400).json({ error: 'Invalid year or month' });
    const key = 'monthly:' + year + ':' + month + ':' + tz;
    const hit = cacheGet(key);
    if (hit) return res.json(hit);
    const summary   = db.getMonthlySummary(year, month, tz);
    const monthFrom = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthTo   = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const dailyRaw  = db.getDateRangeDailyTotals(monthFrom, monthTo, tz);
    const allNodes  = db.getAllNodes();
    const rewardedPks = new Set(summary.map(r => r.pubkey));
    const noReward    = allNodes.filter(n => !rewardedPks.has(n.pubkey));
    const totalBdx    = summary.reduce((s, r) => s + r.total_amount, 0);
    const daily       = buildFilledDailySeries(monthFrom, monthTo, dailyRaw);
    const payload = { year, month, summary, daily, noReward, totalBdx, totalNodes: allNodes.length };
    cacheSet(key, payload);
    res.json(payload);
  });

  app.get('/api/report/range', (req, res) => {
    const { from, to } = req.query;
    const tz = req.query.tz === 'ist' ? 'ist' : 'utc';
    if (validateDateRange(res, from, to)) return;
    const key = `range:${from}:${to}:${tz}`;
    const hit = cacheGet(key);
    if (hit) return res.json(hit);
    const summary  = db.getDateRangeSummary(from, to, tz);
    const daily    = buildFilledDailySeries(from, to, db.getDateRangeDailyTotals(from, to, tz));
    const allNodes = db.getAllNodes();
    const totalBdx = summary.reduce((s, r) => s + r.total_amount, 0);
    const payload = { from, to, summary, daily, totalBdx, totalNodes: allNodes.length };
    cacheSet(key, payload);
    res.json(payload);
  });

  app.get('/api/report/per-key', (req, res) => {
    const { from, to } = req.query;
    const fromDate = from || new Date().toISOString().slice(0, 10);
    const toDate   = to || fromDate;
    const tz       = req.query.tz === 'ist' ? 'ist' : 'utc';
    if (validateDateRange(res, fromDate, toDate)) return;
    try {
      const key = `perkey:${fromDate}:${toDate}:${tz}`;
      const hit = cacheGet(key);
      if (hit) return res.json(hit);
      const rows     = db.getPerKeyReport(fromDate, toDate, tz);
      const totalBdx = rows.reduce((s, r) => s + r.total_amount, 0);
      const totalNodes = db.getAllNodes().length;
      const payload = { from: fromDate, to: toDate, rows, totalBdx, totalNodes };
      cacheSet(key, payload);
      res.json(payload);
    } catch (e) { sendInternalError(res, e); }
  });

  app.get('/api/report/chart', (req, res) => {
    const days = Math.max(1, Math.min(parseInt(req.query.days) || 30, 90));
    try { res.json(db.getDailyChartData(days)); }
    catch (e) { sendInternalError(res, e); }
  });

  app.get('/api/report/chart/monthly', (req, res) => {
    const months = Math.max(1, Math.min(parseInt(req.query.months) || 12, 24));
    try { res.json(db.getMonthlyChartData(months)); }
    catch (e) { sendInternalError(res, e); }
  });

  app.get('/api/report/grouped', (req, res) => {
    const { from, to } = req.query;
    const tz = req.query.tz === 'ist' ? 'ist' : 'utc';
    if (validateDateRange(res, from, to)) return;
    try {
      const key = `grouped:${from}:${to}:${tz}`;
      const hit = cacheGet(key);
      if (hit) return res.json(hit);
      const payload = db.getWalletGroupReport(from, to, tz);
      cacheSet(key, payload);
      res.json(payload);
    } catch (e) { sendInternalError(res, e); }
  });

  app.get('/api/report/matrix', (req, res) => {
    const { from, to } = req.query;
    const tz = req.query.tz === 'ist' ? 'ist' : 'utc';
    if (validateDateRange(res, from, to)) return;
    try {
      const key = `matrix:${from}:${to}:${tz}`;
      const hit = cacheGet(key);
      if (hit) return res.json(hit);
      const payload = buildMatrixReportData(from, to, tz);
      cacheSet(key, payload);
      res.json(payload);
    } catch (e) { sendInternalError(res, e); }
  });

  app.get('/api/report/matrix/cell', (req, res) => {
    const { date, wallet } = req.query;
    if (!date || !wallet) return res.status(400).json({ error: 'date and wallet required' });
    if (!isValidDate(date))  return res.status(400).json({ error: 'Invalid date format' });
    const tz = req.query.tz === 'ist' ? 'ist' : 'utc';
    try {
      const rows  = db.getMatrixCellDetail(date, wallet, tz);
      const total = rows.reduce((s, r) => s + Number(r.reward_amount || 0), 0);
      res.json({ date, wallet, rows, total });
    } catch (e) { sendInternalError(res, e); }
  });

  app.get('/api/scan-history', (_req, res) => {
    try { res.json(db.getScanHistory()); }
    catch (e) { sendInternalError(res, e); }
  });

  // BDX price — USD + INR, cached 15 min in DB
  app.get('/api/price/bdx', async (_req, res) => {
    try {
      const cached = db.getLatestPrice();
      if (cached && Date.now() - cached.fetched_at < PRICE_TTL) {
        res.setHeader('Cache-Control', 'public, max-age=600');
        return res.json({ usd: cached.bdx_usd, inr: cached.bdx_inr, cached: true });
      }
      const fresh = await scanner.fetchBdxPrice();
      if (fresh && (fresh.usd !== null || fresh.inr !== null)) {
        db.savePriceCache(fresh.usd, fresh.inr);
        res.setHeader('Cache-Control', 'public, max-age=600');
        return res.json({ usd: fresh.usd, inr: fresh.inr, cached: false });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ usd: cached?.bdx_usd ?? null, inr: cached?.bdx_inr ?? null, cached: true, stale: true });
    } catch (e) {
      console.error('[Price]', e && e.stack ? e.stack : e);
      res.json({ usd: null, inr: null, error: 'Price fetch failed' });
    }
  });

  // CSV export
  app.get('/api/export/csv', destructiveLimiter, (req, res) => {
    const { type, date, year, month, from, to } = req.query;
    const tz = req.query.tz === 'ist' ? 'ist' : 'utc';
    let rows = [], filename = 'beldex_export', headers = [];

    if (type === 'daily' && date) {
      if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date' });
      rows = db.getDailySummary(date, tz);
      filename = `beldex_daily_${date}`;
      headers = ['pubkey', 'label', 'wallet_name', 'reward_count', 'total_amount'];
    } else if (type === 'monthly' && year && month) {
      const y = parseInt(year), m = parseInt(month);
      if (y < 2020 || y > 2100 || m < 1 || m > 12) return res.status(400).json({ error: 'Invalid month' });
      rows = db.getMonthlySummary(y, m, tz);
      filename = `beldex_monthly_${year}-${String(month).padStart(2, '0')}`;
      headers = ['pubkey', 'label', 'wallet_name', 'reward_count', 'total_amount'];
    } else if (type === 'range' && from && to) {
      if (validateDateRange(res, from, to)) return;
      rows = db.getDateRangeSummary(from, to, tz);
      filename = `beldex_range_${from}_to_${to}`;
      headers = ['pubkey', 'label', 'wallet_name', 'reward_count', 'total_amount'];
    } else if (type === 'status') {
      rows = db.getLatestNodeStatus();
      filename = 'beldex_node_status';
      headers = ['pubkey', 'label', 'wallet_name', 'status', 'version', 'last_uptime_proof', 'checked_at'];
    } else if (type === 'nodes') {
      rows = db.getAllNodes();
      filename = 'beldex_all_nodes';
      headers = ['pubkey', 'label', 'wallet_name', 'wallet_address', 'added_date'];
    } else if (type === 'matrix' && from && to) {
      if (validateDateRange(res, from, to)) return;
      const { wallets, dates, cells, walletTotals } = buildMatrixReportData(from, to, tz);
      // Escape a CSV cell: quote if it contains special chars or starts with a formula character
      const csvCell = v => {
        const s = v === null || v === undefined ? '' : String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r') || /^[=+\-@\t]/.test(s)) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };
      const grandTotal = wallets.reduce((s, w) => s + (walletTotals[w] || 0), 0).toFixed(4);
      let csv2 = ['Date', ...wallets.map(csvCell), 'Day Total'].join(',') + '\n';
      csv2 += [csvCell('WALLET TOTAL'), ...wallets.map(w => walletTotals[w].toFixed(4)), grandTotal].join(',') + '\n';
      dates.forEach(d => {
        const dayTotal = wallets.reduce((s, w) => s + (cells[d]?.[w] || 0), 0);
        csv2 += [csvCell(d), ...wallets.map(w => csvCell((cells[d]?.[w] || '').toString())), csvCell(dayTotal.toFixed(4))].join(',') + '\n';
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="beldex_matrix_${from}_to_${to}.csv"`);
      return res.send(csv2);
    } else {
      return res.status(400).json({ error: 'Unknown export type' });
    }

    const escape = v => {
      const s = v === null || v === undefined ? '' : String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r') || /^[=+\-@\t]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    let csv = headers.join(',') + '\n';
    for (const row of rows) csv += headers.map(h => escape(row[h])).join(',') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.send(csv);
  });

  // Risk summary: nodes whose status is non-active or have stale uptime proof
  app.get('/api/risk/summary', (_req, res) => {
    try {
      const statuses = db.getLatestNodeStatus();
      const atRisk = statuses.filter(s => {
        if (s.status !== 'active') return true;
        if (!s.last_uptime_proof || s.last_uptime_proof === 'Not Received') return true;
        const parts = String(s.last_uptime_proof).split(':');
        if (parts.length >= 1 && parseFloat(parts[0]) >= 2) return true;
        return false;
      });
      res.json({ total: statuses.length, at_risk: atRisk.length, nodes: atRisk });
    } catch (e) { sendInternalError(res, e); }
  });

  // ROI: projected yield based on last 30 days average earnings
  app.get('/api/roi', (req, res) => {
    try {
      const tz         = req.query.tz === 'ist' ? 'ist' : 'utc';
      const nodes      = db.getAllNodes();
      const nodeCount  = nodes.length;
      const stats      = db.getAllTimeStats();
      const BDX_STAKE_PER_NODE = 10000;
      const totalStaked = nodeCount * BDX_STAKE_PER_NODE;
      const totalEarned = stats.total_bdx_earned || 0;
      const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const fromDate = thirtyDaysAgo.toISOString().slice(0, 10);
      const toDate   = new Date().toISOString().slice(0, 10);
      const recent   = db.getDateRangeDailyTotals(fromDate, toDate, tz);
      const totalBdx         = recent.reduce((s, r) => s + r.total_amount, 0);
      const avgDailyBdx      = recent.length > 0 ? totalBdx / 30 : 0;
      const yearlyBdx        = avgDailyBdx * 365;
      const roiPercent       = totalStaked > 0 ? (yearlyBdx / totalStaked) * 100 : 0;
      const breakEvenDays    = avgDailyBdx > 0 ? Math.ceil(totalStaked / avgDailyBdx) : null;
      const perNodeDailyBdx  = nodeCount > 0 ? avgDailyBdx / nodeCount : 0;
      const perNodeBreakEven = perNodeDailyBdx > 0 ? Math.ceil(BDX_STAKE_PER_NODE / perNodeDailyBdx) : null;
      const priceCache    = db.getLatestPrice();
      res.json({
        node_count: nodeCount, total_staked_bdx: totalStaked,
        total_earned_bdx: parseFloat(totalEarned.toFixed(4)),
        avg_daily_bdx: parseFloat(avgDailyBdx.toFixed(4)),
        yearly_projected_bdx: parseFloat(yearlyBdx.toFixed(4)),
        roi_percent: parseFloat(roiPercent.toFixed(2)),
        break_even_days: breakEvenDays,
        per_node_daily_bdx: parseFloat(perNodeDailyBdx.toFixed(4)),
        per_node_break_even_days: perNodeBreakEven,
        first_reward_date: stats.first_reward_date, last_reward_date: stats.last_reward_date,
        total_reward_events: stats.total_reward_events,
        bdx_usd: priceCache?.bdx_usd ?? null, bdx_inr: priceCache?.bdx_inr ?? null,
      });
    } catch (e) { sendInternalError(res, e); }
  });
}

module.exports = { register: registerReports, clearReportCache: cacheClear };
