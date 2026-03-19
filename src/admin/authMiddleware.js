'use strict';

const ADMIN_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD || 'admin123';

function authMiddleware(req, res, next) {
  // Allow preflight
  if (req.method === 'OPTIONS') return next();

  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (token === ADMIN_PASSWORD) return next();

  // Also accept from query param (for easy browser testing)
  if (req.query.token === ADMIN_PASSWORD) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { authMiddleware };
