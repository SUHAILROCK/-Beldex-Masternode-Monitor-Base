'use strict';
/**
 * lib/auth.js — Password hashing helpers (scrypt) shared by server.js and routes/operators.js.
 */

const crypto = require('crypto');

// hashPassword: returns "salt:hash" using scrypt with a random per-password salt
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// verifyPassword: handles scrypt ("salt:hash") and legacy unsalted SHA-256 (64-char hex).
// Legacy path is only exercised until the operator re-logs in and gets auto-migrated.
function verifyPassword(password, stored) {
  if (!stored) return false;
  if (stored.includes(':')) {
    const [salt, hash] = stored.split(':');
    if (!salt || typeof hash !== 'string' || hash.length !== 128) return false;
    const computed = crypto.scryptSync(password, salt, 64).toString('hex');
    return computed.length === hash.length &&
      crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
  }
  // Legacy SHA-256 path
  const computed = crypto.createHash('sha256').update(password).digest('hex');
  return computed.length === stored.length &&
    crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(stored, 'hex'));
}

module.exports = { hashPassword, verifyPassword };
