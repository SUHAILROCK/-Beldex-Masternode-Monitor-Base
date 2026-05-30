'use strict';
/**
 * routes/operators.js — Multi-user operator management.
 * Operator cookies are HMAC-SHA256 signed to prevent forgery.
 */

const crypto = require('crypto');
const db     = require('../db');
const { hashPassword, verifyPassword } = require('../lib/auth');
const { sendInternalError, loginLimiter, destructiveLimiter } = require('../lib/shared');

const OP_COOKIE_SECRET = process.env.OP_COOKIE_SECRET ||
  crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD || '').digest('hex');

if (!process.env.OP_COOKIE_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] OP_COOKIE_SECRET must be set in production. Operator tokens fall back to a derivation of ADMIN_PASSWORD — knowing the admin password allows forging operator cookies. Set a separate random value in .env. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  } else {
    console.warn('[Security] OP_COOKIE_SECRET not set — operator tokens use a derived secret. Set a separate random value in .env before VPS launch.');
  }
}

// In-memory revocation set — populated when operator privileges are changed or
// the operator is deleted. Prevents a downgraded operator from using their old
// cookie (which carries stale is_admin/hub_access) for up to 12 hours.
const _revokedOperatorIds = new Set();

function signOperatorPayload(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig  = crypto.createHmac('sha256', OP_COOKIE_SECRET).update(data).digest('hex');
  return `${data}.${sig}`;
}

function verifyOperatorCookie(raw) {
  if (!raw) return null;
  const dot  = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const data = raw.slice(0, dot);
  const sig  = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', OP_COOKIE_SECRET).update(data).digest('hex');
  const sigBuf = Buffer.from(sig,      'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try { return JSON.parse(Buffer.from(data, 'base64').toString()); } catch { return null; }
}

function getOperatorFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('bdx_op='));
  const eqIdx  = match ? match.indexOf('=') : -1;
  if (eqIdx === -1) return null;
  const payload = verifyOperatorCookie(match.slice(eqIdx + 1));
  if (!payload) return null;
  if (_revokedOperatorIds.has(payload.id)) return null;
  return payload;
}

module.exports = function registerOperators(app) {
  app.get('/api/operators', (req, res) => {
    const op = getOperatorFromRequest(req);
    if (!op || !op.is_admin) return res.status(403).json({ error: 'Admin only' });
    try { res.json(db.getOperators()); }
    catch (e) { sendInternalError(res, e); }
  });

  app.post('/api/operators', (req, res) => {
    const op = getOperatorFromRequest(req);
    if (!op || !op.is_admin) return res.status(403).json({ error: 'Admin only' });
    const { username, password, hub_access, is_admin } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const hash = hashPassword(password);
    const ok   = db.createOperator(username, hash, hub_access || [], is_admin ? 1 : 0);
    res.json({ ok, duplicate: !ok });
  });

  app.put('/api/operators/:id', (req, res) => {
    const op = getOperatorFromRequest(req);
    if (!op || !op.is_admin) return res.status(403).json({ error: 'Admin only' });
    const { hub_access, is_admin, password } = req.body;
    const id = parseInt(req.params.id);
    if (password) {
      if (password.trim().length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      db.updateOperatorPassword(id, hashPassword(password.trim()));
    }
    const ok = db.updateOperator(id, hub_access || [], is_admin ? 1 : 0);
    // Revoke any live cookie for this operator — their privileges may have changed.
    _revokedOperatorIds.add(id);
    res.json({ ok });
  });

  app.delete('/api/operators/:id', destructiveLimiter, (req, res) => {
    const op = getOperatorFromRequest(req);
    if (!op || !op.is_admin) return res.status(403).json({ error: 'Admin only' });
    const id = parseInt(req.params.id);
    // Revoke live cookie immediately so the deleted operator cannot keep using the app.
    _revokedOperatorIds.add(id);
    const ok = db.deleteOperator(id);
    res.json({ ok });
  });

  // Operator login — issues a signed bdx_op cookie
  app.post('/api/operators/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const record = db.getOperatorByUsername(username);
    if (!record) return res.status(401).json({ error: 'Invalid credentials' });
    if (!verifyPassword(password, record.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    // Transparent scrypt upgrade on first login with legacy SHA-256 hash
    if (!record.password_hash.includes(':'))
      db.updateOperatorPassword(record.id, hashPassword(password));
    // Clear any prior revocation — operator is actively logging in with valid credentials.
    _revokedOperatorIds.delete(record.id);
    const payload = { id: record.id, username: record.username, is_admin: record.is_admin, hub_access: record.hub_access };
    const token   = signOperatorPayload(payload);
    const secure  = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `bdx_op=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
    res.json({ ok: true, operator: payload });
  });

  app.post('/api/operators/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'bdx_op=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly');
    res.json({ ok: true });
  });

  app.get('/api/operators/me', (req, res) => {
    const op = getOperatorFromRequest(req);
    if (!op) return res.status(401).json({ error: 'Not logged in' });
    res.json(op);
  });
};
