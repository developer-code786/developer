'use strict';
// Deployment settings only. Business routes and the built interface are unchanged.
const path = require('path');
const production = process.env.NODE_ENV === 'production';
let publicOrigin = null;
function configure() {
  if (!production) return;
  const address = process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (!address) throw new Error('Set PUBLIC_APP_URL to the permanent HTTPS app address.');
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_APP_URL must be an HTTPS origin, without credentials, a path, or a query.');
  }
  if (!process.env.ALKARIM_DATA || !path.isAbsolute(process.env.ALKARIM_DATA)) {
    throw new Error('Set ALKARIM_DATA to the absolute path of a persistent disk.');
  }
  publicOrigin = url.origin;
}
function initializeAdmin() {
  if (!production) return;
  const { get, insert, now } = require('./db');
  if (get('SELECT COUNT(*) n FROM users').n !== 0) return;
  const username = process.env.INITIAL_ADMIN_USERNAME || 'admin';
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!/^[a-z0-9._-]{3,40}$/i.test(username) || !password || password.length < 8 || password.length > 200) {
    throw new Error('First deployment requires INITIAL_ADMIN_PASSWORD (8–200 characters) and a valid INITIAL_ADMIN_USERNAME.');
  }
  insert('users', { name: 'Administrator', username, password_hash: require('./auth').hashPassword(password), role: 'admin', active: 1, created_at: now() });
  // No sample staff or sample business records are created on the shared server.
}
function protectRequests(req, res, next) {
  if (!production) return next();
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if ((origin && origin !== publicOrigin) || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Please use the company app to make changes.' });
    }
    if (req.path === '/api/auth/setup') {
      return res.status(409).json({ error: 'The administrator account is configured on the server. Sign in instead.' });
    }
  }
  next();
}
module.exports = { configure, initializeAdmin, protectRequests };
