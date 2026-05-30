'use strict';
/**
 * routes/analytics.js — Heatmap, hub leaderboard, velocity, anomalies,
 *                        network-history, and top-earners.
 */

const db = require('../db');
const { sendInternalError, isValidDate, validateDateRange } = require('../lib/shared');

module.exports = function registerAnalytics(app) {
  // Heatmap: rewards plus scan coverage so zero days are not misleading.
  app.get('/api/analytics/heatmap', (req, res) => {
    const year = Math.min(Math.max(parseInt(req.query.year) || new Date().getFullYear(), 2020), 2100);
    const yearStr = String(year);
    try {
      res.json({
        rewards: db.getHeatmapData(yearStr),
        scannedDates: [...db.getScannedDatesInRange(`${yearStr}-01-01`, `${yearStr}-12-31`)],
        year: yearStr
      });
    }
    catch (e) { sendInternalError(res, e); }
  });

  // Hub leaderboard
  app.get('/api/analytics/hub-leaderboard', (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    if (validateDateRange(res, from, to)) return;
    try { res.json(db.getHubLeaderboard(from, to)); }
    catch (e) { sendInternalError(res, e); }
  });

  // Velocity trend: rewards per week
  app.get('/api/analytics/velocity', (req, res) => {
    const weeks = Math.min(parseInt(req.query.weeks) || 12, 52);
    try { res.json(db.getVelocityData(weeks)); }
    catch (e) { sendInternalError(res, e); }
  });

  // Anomaly detection: nodes overdue vs their personal baseline
  app.get('/api/analytics/anomalies', (req, res) => {
    const threshold = parseFloat(req.query.threshold) || 1.5;
    try {
      const anomalies       = db.getAnomalousNodes(threshold);
      const allNodes        = db.getAllNodes();
      const latestRewardDate = db.getLatestRewardDate();
      const daysSinceData   = latestRewardDate
        ? Math.floor((Date.now() - new Date(latestRewardDate + 'T00:00:00Z').getTime()) / 86400000)
        : null;
      const flagRatio    = allNodes.length > 0 ? anomalies.length / allNodes.length : 0;
      const likelyScanGap = daysSinceData !== null && daysSinceData >= 2 && flagRatio > 0.25;
      res.json({ anomalies, total_nodes: allNodes.length, days_since_data: daysSinceData, latest_reward_date: latestRewardDate, likely_scan_gap: likelyScanGap });
    } catch (e) { sendInternalError(res, e); }
  });

  // Network stats history (for MN count trend)
  app.get('/api/analytics/network-history', (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    try { res.json(db.getNetworkStatsHistory(days)); }
    catch (e) { sendInternalError(res, e); }
  });

  // Top earners for a given date (among tracked nodes)
  app.get('/api/analytics/top-earners', (req, res) => {
    const { date } = req.query;
    if (!date || !isValidDate(date)) return res.status(400).json({ error: 'Valid date required' });
    try { res.json(db.getTopEarners(date, 20)); }
    catch (e) { sendInternalError(res, e); }
  });

  // 30-day uptime summary per node: [{ pubkey, total_30d, active_30d }]
  app.get('/api/analytics/uptime-summary', (_req, res) => {
    try { res.json(db.getUptimeSummary()); }
    catch (e) { sendInternalError(res, e); }
  });

  // Nodes overdue vs their personal avg reward interval: { nodes: [...] }
  app.get('/api/analytics/network-overdue', (req, res) => {
    const threshold = parseFloat(req.query.threshold) || 1.0;
    try { res.json({ nodes: db.getNetworkOverdueNodes(threshold) }); }
    catch (e) { sendInternalError(res, e); }
  });
};
