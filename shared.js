'use strict';
/**
 * Shared constants, utilities, and rate limiters used across route modules and server.js.
 */

const rateLimit = require('express-rate-limit');

// ── Constants ─────────────────────────────────────────────
const MAX_BULK_NODES            = 1000;
const NODE_STATUS_RETENTION_DAYS = 30;
const MAX_REPORT_RANGE_DAYS     = 366;
const MAX_MANUAL_SCAN_BLOCKS    = 100000;
// ── Error helper ──────────────────────────────────────────
function sendInternalError(res, err, publicMessage = 'Internal server error') {
  console.error('[API]', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: publicMessage });
}

// ── Date validation & helpers ─────────────────────────────
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  try {
    return new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  } catch {
    return false;
  }
}

function daySpanInclusive(from, to) {
  return Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
}

/** Returns null if valid, or sends a 400 and returns a truthy value if invalid. */
function validateDateRange(res, from, to, maxDays = MAX_REPORT_RANGE_DAYS) {
  if (!isValidDate(from) || !isValidDate(to))
    return res.status(400).json({ error: 'Invalid date format. Expected YYYY-MM-DD' });
  if (from > to)
    return res.status(400).json({ error: 'fromDate must be on or before toDate' });
  if (daySpanInclusive(from, to) > maxDays)
    return res.status(400).json({ error: `Date range exceeds ${maxDays} day limit` });
  return null;
}

// ── Rate limiters ─────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const destructiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many destructive requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  MAX_BULK_NODES,
  NODE_STATUS_RETENTION_DAYS,
  MAX_REPORT_RANGE_DAYS,
  MAX_MANUAL_SCAN_BLOCKS,
  sendInternalError,
  isValidDate,
  daySpanInclusive,
  validateDateRange,
  loginLimiter,
  destructiveLimiter,
};
