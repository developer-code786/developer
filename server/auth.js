'use strict';
const crypto = require('crypto');
const { get, run, all, now, getSetting } = require('./db');

const MODULES = [
  ['dashboard', 'Dashboard'], ['parties', 'Customers & suppliers'], ['products', 'Packaging products'],
  ['quotations', 'Quotations'], ['orders', 'Orders'], ['production', 'Production'], ['inventory', 'Inventory & purchases'],
  ['deliveries', 'Deliveries'], ['invoices', 'Invoices'], ['payments', 'Payments'], ['expenses', 'Expenses'],
  ['reports', 'Reports'], ['activity', 'Activity history'], ['settings', 'Settings'], ['users', 'Staff & permissions'],
  ['backup', 'Backup & data'],
];
const ACTIONS = ['view', 'create', 'edit', 'delete'];
const ROLES = [
  ['admin', 'Administrator'], ['sales', 'Sales'], ['production', 'Production'], ['inventory', 'Inventory'], ['accounts', 'Accounts'],
];

const V = ['view'], VC = ['view', 'create'], VCE = ['view', 'create', 'edit'], ALL = ACTIONS;
const DEFAULT_PERMISSIONS = {
  sales: {
    dashboard: V, parties: VCE, products: VCE, quotations: ALL, orders: VCE, production: V, inventory: V,
    deliveries: V, invoices: V, payments: V, expenses: [], reports: V, activity: V, settings: [], users: [], backup: [],
  },
  production: {
    dashboard: V, parties: V, products: V, quotations: V, orders: ['view', 'edit'], production: VCE, inventory: VC,
    deliveries: V, invoices: [], payments: [], expenses: [], reports: V, activity: V, settings: [], users: [], backup: [],
  },
  inventory: {
    dashboard: V, parties: VCE, products: ['view', 'edit'], quotations: V, orders: V, production: V, inventory: ALL,
    deliveries: VCE, invoices: [], payments: [], expenses: [], reports: V, activity: V, settings: [], users: [], backup: [],
  },
  accounts: {
    dashboard: V, parties: VCE, products: V, quotations: V, orders: V, production: V, inventory: V,
    deliveries: V, invoices: ALL, payments: ALL, expenses: ALL, reports: V, activity: V, settings: [], users: [], backup: ['view'],
  },
};

function permissionsFor(role) {
  if (role === 'admin') return Object.fromEntries(MODULES.map(([m]) => [m, ACTIONS.slice()]));
  const matrix = getSetting('permissions', DEFAULT_PERMISSIONS);
  const p = (matrix && matrix[role]) || DEFAULT_PERMISSIONS[role] || {};
  return Object.fromEntries(MODULES.map(([m]) => [m, Array.isArray(p[m]) ? p[m] : []]));
}
function can(user, module, action = 'view') {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const p = permissionsFor(user.role);
  return (p[module] || []).includes(action);
}

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

// ---------- sessions ----------
const COOKIE = 'ak_session';
const SESSION_DAYS = 14;
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', token, userId, now(), exp);
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  return token;
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = get(`SELECT u.id, u.name, u.username, u.role, u.email, u.active, s.expires_at, s.token
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
  if (!row || !row.active || row.expires_at < now()) return null;
  return row;
}
function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

// ---------- middleware ----------
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
  req.user = user;
  next();
}
function requirePerm(module, action = 'view') {
  return (req, res, next) => {
    if (!can(req.user, module, action)) {
      const mod = (MODULES.find((m) => m[0] === module) || [module, module])[1];
      return res.status(403).json({ error: `Your role (${req.user.role}) cannot ${action} ${mod.toLowerCase()}. Ask an administrator for access.` });
    }
    next();
  };
}

// Simple login throttle: 8 failed attempts per username+IP per 10 minutes.
const attempts = new Map();
function throttleKey(req, username) { return `${req.ip}|${String(username || '').toLowerCase()}`; }
function checkThrottle(req, username) {
  const k = throttleKey(req, username);
  const a = attempts.get(k);
  if (a && a.count >= 8 && Date.now() - a.first < 10 * 60e3) {
    throw new HttpError(429, 'Too many failed sign-in attempts. Wait 10 minutes and try again.');
  }
}
function recordFail(req, username) {
  const k = throttleKey(req, username);
  const a = attempts.get(k);
  if (!a || Date.now() - a.first > 10 * 60e3) attempts.set(k, { count: 1, first: Date.now() });
  else a.count++;
}
function clearFails(req, username) { attempts.delete(throttleKey(req, username)); }

function userCount() { return get('SELECT COUNT(*) AS n FROM users').n; }
function listUsers() {
  return all('SELECT id, name, username, role, email, phone, active, is_sample, created_at, last_login FROM users ORDER BY name');
}

module.exports = {
  MODULES, ACTIONS, ROLES, DEFAULT_PERMISSIONS, permissionsFor, can, hashPassword, verifyPassword,
  createSession, sessionUser, setCookie, clearCookie, requireAuth, requirePerm, HttpError,
  checkThrottle, recordFail, clearFails, userCount, listUsers, parseCookies, COOKIE,
};
