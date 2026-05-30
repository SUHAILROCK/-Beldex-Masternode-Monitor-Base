'use strict';
/**
 * routes/nodes.js — Node CRUD and group/streak endpoints.
 */

const db = require('../db');
const { sendInternalError, destructiveLimiter, MAX_BULK_NODES } = require('../lib/shared');

module.exports = function registerNodes(app) {
  app.get('/api/nodes', (req, res) => {
    try { res.json(db.getAllNodes()); }
    catch (e) { sendInternalError(res, e); }
  });

  app.post('/api/nodes', (req, res) => {
    const { pubkey, label, walletName, walletAddress } = req.body;
    if (!pubkey) return res.status(400).json({ error: 'pubkey required' });
    const clean = pubkey.trim().replace(/^:/, '').trim();
    if (!/^[0-9a-f]{64}$/.test(clean))
      return res.status(400).json({ error: 'Invalid pubkey: must be 64 lowercase hex characters' });
    const ok = db.addNode(clean, label || null, walletName || null, walletAddress || null);
    res.json({ success: ok, duplicate: !ok });
  });

  // Bulk import wrapped in a single DB transaction for speed
  app.post('/api/nodes/bulk', (req, res) => {
    const { nodes } = req.body;
    if (!Array.isArray(nodes)) return res.status(400).json({ error: 'nodes array required' });
    if (nodes.length > MAX_BULK_NODES)
      return res.status(400).json({ error: `Max ${MAX_BULK_NODES} nodes per import` });
    const clean = nodes
      .map(n => ({ ...n, pubkey: (n.pubkey || '').trim().replace(/^:/, '').trim() }))
      .filter(n => /^[0-9a-f]{64}$/.test(n.pubkey));
    const skippedInvalid = nodes.length - clean.length;
    const { added, skipped, conflicts } = db.bulkAddNodes(clean);
    res.json({ added, skipped: skipped + skippedInvalid, conflicts });
  });

  app.put('/api/nodes/:pubkey', (req, res) => {
    if (!/^[0-9a-f]{64}$/.test(req.params.pubkey))
      return res.status(400).json({ error: 'Invalid pubkey' });
    const { label, walletName, walletAddress } = req.body;
    const ok = db.updateNode(req.params.pubkey, label || null, walletName || null, walletAddress || null);
    res.json({ success: ok });
  });

  app.delete('/api/nodes/:pubkey', destructiveLimiter, (req, res) => {
    if (!/^[0-9a-f]{64}$/.test(req.params.pubkey))
      return res.status(400).json({ error: 'Invalid pubkey' });
    console.log(`[AUDIT] DELETE node ${req.params.pubkey} from ${req.ip}`);
    const ok = db.removeNode(req.params.pubkey);
    res.json({ success: ok });
  });

  app.delete('/api/nodes', destructiveLimiter, (req, res) => {
    console.log(`[AUDIT] DELETE ALL nodes from ${req.ip}`);
    const removed = db.removeAllNodes();
    res.json({ removed });
  });

  app.get('/api/nodes/groups', (_req, res) => {
    try { res.json(db.getWalletGroups()); }
    catch (e) { sendInternalError(res, e); }
  });

  // Streaks — registered before /:pubkey so Express matches correctly
  app.get('/api/nodes/streaks', (_req, res) => {
    try { res.json(db.getAllNodeStreaks()); }
    catch (e) { sendInternalError(res, e); }
  });

  app.get('/api/nodes/last-rewards', (_req, res) => {
    try { res.json(db.getLastRewardDatePerNode()); }
    catch (e) { sendInternalError(res, e); }
  });

  // Per-node detail (history + lifetime stats + streak)
  app.get('/api/nodes/:pubkey/detail', (req, res) => {
    try {
      const node = db.getNodeByPubkey(req.params.pubkey);
      if (!node) return res.status(404).json({ error: 'Node not found' });
      const stats = db.getNodeLifetimeStats(req.params.pubkey);
      const history = db.getNodeRewardHistory(req.params.pubkey, 300);
      const streak = db.getNodeStreak(req.params.pubkey);
      res.json({ node, stats, history, streak });
    } catch (e) { sendInternalError(res, e); }
  });
};
