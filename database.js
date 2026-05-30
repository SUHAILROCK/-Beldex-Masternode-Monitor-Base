'use strict';
/**
 * routes/database.js — DB backup, stats, vacuum, archive, prune, and archive log.
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../db');
const { sendInternalError, destructiveLimiter, isValidDate, NODE_STATUS_RETENTION_DAYS } = require('../lib/shared');

const DB_PATH = process.env.BDX_DB_PATH || path.join(__dirname, '..', 'beldex_monitor.db');

module.exports = function registerDatabase(app) {
  // Hot backup — uses better-sqlite3 WAL-aware backup API
  app.get('/api/backup/db', async (_req, res) => {
    const stamp   = new Date().toISOString().slice(0, 10);
    const tmpPath = path.join(__dirname, '..', `beldex_backup_tmp_${Date.now()}.db`);
    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };
    try {
      await db.hotBackup(tmpPath);
      res.setHeader('Content-Disposition', `attachment; filename="beldex_monitor_backup_${stamp}.db"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      const stream = fs.createReadStream(tmpPath);
      res.on('finish', cleanup);
      res.on('close', cleanup);
      stream.pipe(res);
    } catch (e) { cleanup(); sendInternalError(res, e); }
  });

  app.get('/api/db-stats', (_req, res) => {
    try {
      const stat    = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
      const sizeMb  = stat ? (stat.size / 1048576).toFixed(2) : 0;
      const nodes   = db.getAllNodes().length;
      const allStats = db.getAllTimeStats();
      res.json({
        size_mb:          parseFloat(sizeMb),
        nodes,
        total_rewards:    allStats.total_reward_events || 0,
        total_bdx:        parseFloat((allStats.total_bdx_earned || 0).toFixed(4)),
        first_reward_date: allStats.first_reward_date || null,
        last_reward_date:  allStats.last_reward_date  || null,
        rewarded_nodes:    allStats.rewarded_nodes    || 0,
      });
    } catch (e) { sendInternalError(res, e); }
  });

  app.get('/api/db/detailed-stats', (_req, res) => {
    try {
      const s       = fs.statSync(DB_PATH);
      const walStat = fs.existsSync(DB_PATH + '-wal') ? fs.statSync(DB_PATH + '-wal') : null;
      const detail  = db.getDbDetailedStats();
      res.json({
        db_size_mb:    parseFloat((s.size / 1048576).toFixed(2)),
        wal_size_mb:   walStat ? parseFloat((walStat.size / 1048576).toFixed(2)) : 0,
        total_size_mb: parseFloat(((s.size + (walStat?.size || 0)) / 1048576).toFixed(2)),
        ...detail,
        archive_log: db.getArchiveLog().slice(0, 10),
      });
    } catch (e) { sendInternalError(res, e); }
  });

  app.post('/api/db/vacuum', destructiveLimiter, (req, res) => {
    console.log(`[AUDIT] VACUUM requested from ${req.ip}`);
    try {
      db.runVacuumAndCheckpoint();
      res.json({ ok: true, message: 'VACUUM and WAL checkpoint complete' });
    } catch (e) { sendInternalError(res, e); }
  });

  app.post('/api/db/archive', destructiveLimiter, (req, res) => {
    const keep     = Math.max(1, parseInt(req.body.months_to_keep) || 12);
    const cutoff   = new Date();
    cutoff.setMonth(cutoff.getMonth() - keep);
    const beforeDate = cutoff.toISOString().slice(0, 10);
    const stamp      = new Date().toISOString().slice(0, 10);
    const archivePath = path.join(__dirname, '..', 'archives', `rewards_before_${beforeDate}_${stamp}.json.gz`);
    console.log(`[AUDIT] ARCHIVE requested from ${req.ip} — before_date=${beforeDate}`);
    try {
      const result = db.archiveAndPruneRewards(beforeDate, archivePath);
      if (result.archived === 0)
        return res.json({ ok: true, archived: 0, message: `No rewards before ${beforeDate} to archive` });
      console.log(`[AUDIT] ARCHIVE complete — ${result.archived} rows archived to ${result.path}`);
      res.json({ ok: true, archived: result.archived, path: result.path, before_date: beforeDate });
    } catch (e) { sendInternalError(res, e); }
  });

  app.post('/api/db/prune', destructiveLimiter, (req, res) => {
    const { before_date } = req.body;
    if (!isValidDate(before_date))
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    console.log(`[AUDIT] PRUNE requested from ${req.ip} — before_date=${before_date}`);
    try {
      const deleted = db.pruneRewardsBefore(before_date);
      console.log(`[AUDIT] PRUNE complete — ${deleted} rewards deleted before ${before_date}`);
      res.json({ ok: true, deleted, before_date });
    } catch (e) { sendInternalError(res, e); }
  });

  app.post('/api/db/prune-status', destructiveLimiter, (req, res) => {
    console.log(`[AUDIT] PRUNE-STATUS requested from ${req.ip}`);
    try {
      const deleted = db.pruneNodeStatus(NODE_STATUS_RETENTION_DAYS);
      res.json({ ok: true, deleted, retention_days: NODE_STATUS_RETENTION_DAYS });
    } catch (e) { sendInternalError(res, e); }
  });

  app.get('/api/db/archives', (_req, res) => {
    try {
      const archiveDir = path.join(__dirname, '..', 'archives');
      const files = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter(f => f.endsWith('.json.gz')) : [];
      const log   = db.getArchiveLog();
      res.json({ archives: log, files });
    } catch (e) { sendInternalError(res, e); }
  });
};
