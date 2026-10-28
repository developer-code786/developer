'use strict';
// Auth, first-run setup, settings, staff, activity, search, notifications, backup/restore, sample data.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, all, get, run, insert, update, tx, now, today, round4, getSetting, setSetting, DATA_DIR } = require('../db');
const A = require('../auth');
const { validate, bad, notFound, conflict, log, h, allSettings, DEFAULT_SETTINGS, ensureDefaults } = require('../util');
const { recomputeInvoice, recomputePurchase, recomputeOrderStatus, syncLineProduction } = require('../logic');

const pub = express.Router(); // no auth
const r = express.Router(); // requires auth

// ======================= AUTH & SETUP =======================
pub.get('/auth/status', h((req, res) => {
  const user = A.sessionUser(req);
  res.json({ needsSetup: A.userCount() === 0, signedIn: !!user, company: getSetting('company', {}).name || 'Alkarim Packages' });
}));
pub.post('/auth/setup', h((req, res) => {
  if (A.userCount() > 0) throw conflict('Setup has already been completed. Sign in instead.');
  const d = validate(req.body, {
    company: { type: 'text', required: true, maxLen: 120, label: 'Company name' },
    name: { type: 'text', required: true, maxLen: 80, label: 'Your name' },
    username: { type: 'text', required: true, maxLen: 40, label: 'Username' },
    password: { type: 'text', required: true, maxLen: 200, label: 'Password' },
    load_sample: { type: 'bool', default: 1 },
  });
  if (!/^[a-z0-9._-]{3,40}$/i.test(d.username)) throw bad('Username: 3–40 letters, numbers, dots, dashes or underscores.', { username: 'Invalid username' });
  if (d.password.length < 8) throw bad('Password must be at least 8 characters.', { password: 'At least 8 characters' });
  const id = tx(() => {
    setSetting('company', { ...getSetting('company', DEFAULT_SETTINGS.company), name: d.company });
    return insert('users', { name: d.name, username: d.username, password_hash: A.hashPassword(d.password), role: 'admin', active: 1, created_at: now() });
  });
  if (d.load_sample) require('../seed').seed(id);
  const token = A.createSession(id);
  A.setCookie(res, token);
  log({ user: { id, name: d.name } }, 'completed setup', 'system', null, d.company, { sample_data: !!d.load_sample });
  res.json({ ok: true });
}));
pub.post('/auth/login', h((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw bad('Enter your username and password.');
  A.checkThrottle(req, username);
  const u = get('SELECT * FROM users WHERE username = ?', String(username).trim());
  if (!u || !A.verifyPassword(String(password), u.password_hash)) {
    A.recordFail(req, username);
    throw new A.HttpError(401, 'Incorrect username or password.');
  }
  if (!u.active) throw new A.HttpError(403, 'This account is deactivated. Ask an administrator to reactivate it.');
  A.clearFails(req, username);
  run('UPDATE users SET last_login = ? WHERE id = ?', now(), u.id);
  A.setCookie(res, A.createSession(u.id));
  log({ user: u }, 'signed in', 'user', u.id, u.name);
  res.json({ ok: true });
}));
pub.post('/auth/logout', h((req, res) => {
  const token = A.parseCookies(req.headers.cookie)[A.COOKIE];
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  A.clearCookie(res);
  res.json({ ok: true });
}));

r.post('/auth/password', h((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!A.verifyPassword(String(req.body.current || ''), u.password_hash)) throw bad('Current password is incorrect.', { current: 'Incorrect' });
  const next = String(req.body.next || '');
  if (next.length < 8) throw bad('New password must be at least 8 characters.', { next: 'At least 8 characters' });
  run('UPDATE users SET password_hash = ? WHERE id = ?', A.hashPassword(next), u.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, req.user.token);
  log(req, 'changed password', 'user', u.id, u.name);
  res.json({ ok: true });
}));

// ======================= META / SETTINGS =======================
function sampleCounts() {
  const tables = ['parties', 'products', 'materials', 'quotations', 'orders', 'invoices', 'payments', 'deliveries', 'purchases', 'expenses', 'users'];
  const counts = {};
  let total = 0;
  for (const t of tables) { counts[t] = get(`SELECT COUNT(*) n FROM ${t} WHERE is_sample = 1`).n; total += counts[t]; }
  return { total, counts };
}
r.get('/meta', h((req, res) => {
  res.json({
    user: { id: req.user.id, name: req.user.name, username: req.user.username, role: req.user.role, email: req.user.email },
    permissions: A.permissionsFor(req.user.role),
    settings: allSettings(),
    roles: A.ROLES.map(([key, label]) => ({ key, label })),
    modules: A.MODULES.map(([key, label]) => ({ key, label })),
    staff: all('SELECT id, name, role, active FROM users ORDER BY name'),
    sample: sampleCounts(),
    today: today(),
  });
}));
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
function checkSetting(key, v) {
  const fail = (m) => { throw bad(m, { [key]: m }); };
  if (key === 'company') {
    if (!v || !String(v.name || '').trim()) fail('Company name is required');
    if (v.logo && !/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(v.logo)) fail('Logo must be a PNG, JPG, WEBP or SVG image');
    if (v.logo && v.logo.length > 1_500_000) fail('Logo image is too large (keep it under 1 MB)');
  }
  if (key === 'currency') {
    if (!/^[A-Z]{3}$/.test(String(v.code || ''))) fail('Currency code must be 3 capital letters, e.g. PKR');
    if (!String(v.symbol || '').trim()) fail('Currency symbol is required');
    if (![0, 1, 2, 3].includes(Number(v.decimals)) || ![0, 1, 2, 3, 4].includes(Number(v.priceDecimals))) fail('Decimals must be between 0 and 3 (prices up to 4)');
    v.decimals = Number(v.decimals); v.priceDecimals = Number(v.priceDecimals);
  }
  if (key === 'taxes') {
    if (!Array.isArray(v)) fail('Taxes must be a list');
    const ids = new Set();
    v.forEach((t) => {
      if (!String(t.name || '').trim()) fail('Each tax needs a name');
      const rate = Number(t.rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) fail(`Tax rate for ${t.name} must be between 0 and 100`);
      t.rate = rate; t.id = String(t.id || `tax_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      if (ids.has(t.id)) fail('Duplicate tax id'); ids.add(t.id);
    });
  }
  if (key === 'productionStages') {
    if (!Array.isArray(v) || v.length < 3) fail('Keep at least three production stages');
    const keys = v.map((s) => s.key);
    for (const k of ['queued', 'qc', 'completed']) if (!keys.includes(k)) fail(`The "${k}" stage is required (you can rename it)`);
    v.forEach((s) => { if (!/^[a-z0-9_]{2,30}$/.test(s.key) || !String(s.label || '').trim()) fail('Each stage needs a key and a label'); });
    if (new Set(keys).size !== keys.length) fail('Stage keys must be unique');
  }
  if (Array.isArray(DEFAULT_SETTINGS[key]) && key !== 'taxes' && key !== 'productionStages') {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) fail('List items must be non-empty text');
  }
  if (key === 'defaults') {
    for (const [k, n] of Object.entries(v)) if (!Number.isFinite(Number(n)) || Number(n) < 0) fail(`${k} must be 0 or more`);
  }
  return v;
}
r.put('/settings', A.requirePerm('settings', 'edit'), h((req, res) => {
  const body = req.body || {};
  const changed = [];
  tx(() => {
    for (const key of Object.keys(body)) {
      if (!SETTING_KEYS.includes(key)) continue;
      const v = checkSetting(key, body[key]);
      if (key === 'defaultTaxId' && v && !(getSetting('taxes', []).concat(body.taxes || [])).some((t) => String(t.id) === String(v))) throw bad('Default tax not found');
      setSetting(key, v);
      changed.push(key);
    }
  });
  log(req, 'updated settings', 'settings', null, changed.join(', '));
  res.json({ ok: true, settings: allSettings() });
}));
r.get('/permissions', A.requirePerm('users'), h((req, res) => {
  const out = {};
  for (const [role] of A.ROLES) out[role] = A.permissionsFor(role);
  res.json({ matrix: out, modules: A.MODULES.map(([key, label]) => ({ key, label })), actions: A.ACTIONS, roles: A.ROLES.map(([key, label]) => ({ key, label })) });
}));
r.put('/permissions', A.requirePerm('users', 'edit'), h((req, res) => {
  const m = req.body.matrix || {};
  const clean = {};
  for (const [role] of A.ROLES) {
    if (role === 'admin') continue;
    clean[role] = {};
    for (const [mod] of A.MODULES) {
      const acts = Array.isArray(m[role] && m[role][mod]) ? m[role][mod].filter((a) => A.ACTIONS.includes(a)) : [];
      if (acts.length && !acts.includes('view')) acts.unshift('view'); // any action implies view
      clean[role][mod] = acts;
    }
  }
  setSetting('permissions', clean);
  log(req, 'updated permissions', 'settings', null, 'Role permissions');
  res.json({ ok: true });
}));

// ======================= USERS =======================
r.get('/users', A.requirePerm('users'), h((req, res) => res.json(A.listUsers())));
const userSpec = {
  name: { type: 'text', required: true, maxLen: 80, label: 'Name' },
  username: { type: 'text', required: true, maxLen: 40, label: 'Username' },
  role: { type: 'text', required: true, enum: A.ROLES.map((x) => x[0]), label: 'Role' },
  email: { type: 'email', label: 'Email' }, phone: { type: 'text', maxLen: 40, label: 'Phone' },
  active: { type: 'bool', default: 1 }, password: { type: 'text', maxLen: 200, label: 'Password' },
};
r.post('/users', A.requirePerm('users', 'create'), h((req, res) => {
  const d = validate(req.body, userSpec);
  if (!/^[a-z0-9._-]{3,40}$/i.test(d.username)) throw bad('Username: 3–40 letters, numbers, dots, dashes or underscores.', { username: 'Invalid' });
  if (!d.password || d.password.length < 8) throw bad('Password must be at least 8 characters.', { password: 'At least 8 characters' });
  if (get('SELECT id FROM users WHERE username = ?', d.username)) throw conflict('That username is taken.', { fields: { username: 'Taken' } });
  const { password, ...rest } = d;
  const id = insert('users', { ...rest, password_hash: A.hashPassword(password), created_at: now() });
  log(req, 'created', 'user', id, `${d.name} (${d.role})`);
  res.status(201).json({ id });
}));
r.put('/users/:id', A.requirePerm('users', 'edit'), h((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) throw notFound('Staff member');
  const d = validate(req.body, userSpec);
  if (get('SELECT id FROM users WHERE username = ? AND id != ?', d.username, u.id)) throw conflict('That username is taken.', { fields: { username: 'Taken' } });
  const admins = get("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id != ?", u.id).n;
  if (u.role === 'admin' && (d.role !== 'admin' || !d.active) && admins === 0) throw conflict('Keep at least one active administrator.');
  if (u.id === req.user.id && !d.active) throw conflict("You can't deactivate your own account.");
  const { password, ...rest } = d;
  const upd = { ...rest };
  if (password) {
    if (password.length < 8) throw bad('Password must be at least 8 characters.', { password: 'At least 8 characters' });
    upd.password_hash = A.hashPassword(password);
  }
  tx(() => {
    update('users', u.id, upd);
    if (password || !d.active || d.role !== u.role) run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, req.user.token);
  });
  log(req, 'updated', 'user', u.id, d.name, {
    ...(u.role !== d.role ? { role: { from: u.role, to: d.role } } : {}), ...(u.active !== d.active ? { active: { from: !!u.active, to: !!d.active } } : {}),
    ...(password ? { password: 'reset' } : {}),
  });
  res.json({ ok: true });
}));

// ======================= ACTIVITY =======================
r.get('/activity', A.requirePerm('activity'), h((req, res) => {
  const where = [];
  const p = [];
  if (req.query.entity) { where.push('entity = ?'); p.push(req.query.entity); }
  if (req.query.user_id) { where.push('user_id = ?'); p.push(req.query.user_id); }
  if (req.query.from) { where.push('substr(ts,1,10) >= ?'); p.push(req.query.from); }
  if (req.query.to) { where.push('substr(ts,1,10) <= ?'); p.push(req.query.to); }
  if (req.query.q) { where.push('(label LIKE ? OR action LIKE ? OR user_name LIKE ?)'); const q = `%${req.query.q}%`; p.push(q, q, q); }
  res.json(all(`SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 1000`, ...p));
}));

// ======================= SEARCH =======================
r.get('/search', h((req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const out = [];
  const add = (mod, type, sql, ...p) => { if (A.can(req.user, mod)) all(sql, ...p).forEach((x) => out.push({ type, ...x })); };
  add('parties', 'party', `SELECT id, company AS title, TRIM(COALESCE(contact_name,'') || ' ' || COALESCE(phone,'') || ' ' || COALESCE(city,'')) AS sub, kind AS tag FROM parties
    WHERE company LIKE ? OR contact_name LIKE ? OR phone LIKE ? OR email LIKE ? OR tax_id LIKE ? LIMIT 6`, like, like, like, like, like);
  add('products', 'product', `SELECT id, code || ' · ' || name AS title, type AS sub, NULL AS tag FROM products WHERE code LIKE ? OR name LIKE ? LIMIT 6`, like, like);
  add('quotations', 'quotation', `SELECT q.id, q.number || ' · ' || q.title AS title, c.company AS sub, q.status AS tag FROM quotations q JOIN parties c ON c.id = q.customer_id
    WHERE q.number LIKE ? OR q.title LIKE ? OR c.company LIKE ? ORDER BY q.id DESC LIMIT 6`, like, like, like);
  add('orders', 'order', `SELECT o.id, o.number AS title, c.company || COALESCE(' · PO ' || o.po_number,'') AS sub, o.status AS tag FROM orders o JOIN parties c ON c.id = o.customer_id
    WHERE o.number LIKE ? OR o.po_number LIKE ? OR c.company LIKE ? ORDER BY o.id DESC LIMIT 6`, like, like, like);
  add('production', 'job', `SELECT j.id, j.number || ' · ' || COALESCE(j.title,'') AS title, o.number AS sub, j.stage AS tag FROM production_jobs j JOIN orders o ON o.id = j.order_id
    WHERE j.number LIKE ? OR j.title LIKE ? OR o.number LIKE ? ORDER BY j.id DESC LIMIT 6`, like, like, like);
  add('inventory', 'material', `SELECT id, code || ' · ' || name AS title, category AS sub, NULL AS tag FROM materials WHERE code LIKE ? OR name LIKE ? LIMIT 6`, like, like);
  add('deliveries', 'delivery', `SELECT d.id, d.number AS title, c.company AS sub, d.status AS tag FROM deliveries d JOIN parties c ON c.id = d.customer_id
    WHERE d.number LIKE ? OR c.company LIKE ? OR d.vehicle LIKE ? ORDER BY d.id DESC LIMIT 6`, like, like, like);
  add('invoices', 'invoice', `SELECT i.id, i.number AS title, c.company AS sub, i.status AS tag FROM invoices i JOIN parties c ON c.id = i.customer_id
    WHERE i.number LIKE ? OR c.company LIKE ? ORDER BY i.id DESC LIMIT 6`, like, like);
  add('payments', 'payment', `SELECT y.id, y.number AS title, p.company || ' · ' || y.method AS sub, y.direction AS tag FROM payments y JOIN parties p ON p.id = y.party_id
    WHERE y.number LIKE ? OR y.reference LIKE ? OR p.company LIKE ? ORDER BY y.id DESC LIMIT 6`, like, like, like);
  res.json(out);
}));

// ======================= NOTIFICATIONS =======================
function buildNotifications(user) {
  const t = today();
  const soon = new Date(Date.parse(t) + 3 * 864e5).toISOString().slice(0, 10);
  const n = [];
  if (A.can(user, 'inventory')) {
    all('SELECT id, code, name, unit, stock_qty, reorder_level FROM materials WHERE active = 1 AND reorder_level > 0 AND stock_qty <= reorder_level').forEach((m) => n.push({
      key: `low:m:${m.id}:${round4(m.stock_qty)}`, level: m.stock_qty <= 0 ? 'danger' : 'warn', type: 'material', id: m.id,
      title: `Low stock: ${m.code}`, body: `${m.name} at ${round4(m.stock_qty)} ${m.unit} (reorder at ${m.reorder_level})`,
    }));
  }
  if (A.can(user, 'invoices')) {
    all(`SELECT i.id, i.number, i.due_date, ROUND(i.total - i.paid_amount,2) bal, c.company FROM invoices i JOIN parties c ON c.id = i.customer_id
      WHERE i.status IN ('unpaid','partial') AND i.due_date < ? ORDER BY i.due_date LIMIT 20`, t).forEach((i) => n.push({
      key: `overdue:i:${i.id}:${i.bal}`, level: 'danger', type: 'invoice', id: i.id, title: `Overdue: ${i.number}`, body: `${i.company} · balance ${i.bal} · due ${i.due_date}`, money: i.bal,
    }));
  }
  if (A.can(user, 'orders')) {
    all(`SELECT o.id, o.number, o.due_date, c.company FROM orders o JOIN parties c ON c.id = o.customer_id
      WHERE o.status NOT IN ('delivered','cancelled') AND o.due_date IS NOT NULL AND o.due_date <= ? ORDER BY o.due_date LIMIT 20`, soon).forEach((o) => n.push({
      key: `due:o:${o.id}:${o.due_date}`, level: o.due_date < t ? 'danger' : 'warn', type: 'order', id: o.id,
      title: o.due_date < t ? `Late order: ${o.number}` : `Due soon: ${o.number}`, body: `${o.company} · deadline ${o.due_date}`,
    }));
  }
  if (A.can(user, 'quotations')) {
    all(`SELECT q.id, q.number, q.valid_until, c.company FROM quotations q JOIN parties c ON c.id = q.customer_id
      WHERE q.status IN ('sent','approved') AND q.valid_until IS NOT NULL AND q.valid_until BETWEEN ? AND ? LIMIT 10`, t, soon).forEach((q) => n.push({
      key: `qexp:${q.id}:${q.valid_until}`, level: 'info', type: 'quotation', id: q.id, title: `Quote expiring: ${q.number}`, body: `${q.company} · valid until ${q.valid_until}`,
    }));
  }
  if (A.can(user, 'production')) {
    all(`SELECT j.id, j.number, j.due_date, j.stage FROM production_jobs j WHERE j.status = 'open' AND j.due_date IS NOT NULL AND j.due_date < ? LIMIT 10`, t).forEach((j) => n.push({
      key: `jlate:${j.id}:${j.due_date}`, level: 'warn', type: 'job', id: j.id, title: `Job behind schedule: ${j.number}`, body: `Due ${j.due_date} · stage ${j.stage}`,
    }));
  }
  const reads = new Set(all('SELECT key FROM notif_reads WHERE user_id = ?', user.id).map((x) => x.key));
  n.forEach((x) => { x.read = reads.has(x.key); });
  return n;
}
r.get('/notifications', h((req, res) => {
  const list = buildNotifications(req.user);
  res.json({ items: list, unread: list.filter((x) => !x.read).length });
}));
r.post('/notifications/read', h((req, res) => {
  const keys = Array.isArray(req.body.keys) ? req.body.keys : buildNotifications(req.user).map((x) => x.key);
  tx(() => keys.forEach((k) => run('INSERT OR IGNORE INTO notif_reads (user_id, key) VALUES (?, ?)', req.user.id, String(k).slice(0, 200))));
  res.json({ ok: true });
}));

// ======================= DERIVED DATA REBUILD =======================
function rebuildDerived() {
  // Stock from the movement ledger.
  run("UPDATE materials SET stock_qty = ROUND(COALESCE((SELECT SUM(qty) FROM stock_movements WHERE item_kind = 'material' AND item_id = materials.id),0),4)");
  run("UPDATE products SET stock_qty = ROUND(COALESCE((SELECT SUM(qty) FROM stock_movements WHERE item_kind = 'product' AND item_id = products.id),0),4)");
  run(`UPDATE order_lines SET delivered_qty = ROUND(COALESCE((SELECT SUM(qty) FROM delivery_lines WHERE order_line_id = order_lines.id),0),4),
    invoiced_qty = ROUND(COALESCE((SELECT SUM(il.qty) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.order_line_id = order_lines.id AND i.status != 'void'),0),4)`);
  all('SELECT id FROM order_lines').forEach((l) => syncLineProduction(l.id));
  run("DELETE FROM payment_allocations WHERE target_type = 'invoice' AND target_id NOT IN (SELECT id FROM invoices)");
  run("DELETE FROM payment_allocations WHERE target_type = 'purchase' AND target_id NOT IN (SELECT id FROM purchases)");
  all('SELECT id FROM invoices').forEach((i) => recomputeInvoice(i.id));
  all('SELECT id FROM purchases').forEach((p) => recomputePurchase(p.id));
  all('SELECT id FROM orders').forEach((o) => recomputeOrderStatus(o.id));
}

// Restart document numbering after the highest number still in use (e.g. after sample data is removed).
function resetSequences() {
  const max = {};
  const scan = (sql) => all(sql).forEach(({ n }) => {
    const m = /^(.*-\d{4})-(\d+)$/.exec(n || '');
    if (m) max[m[1]] = Math.max(max[m[1]] || 0, Number(m[2]));
  });
  for (const t of ['quotations', 'orders', 'production_jobs', 'deliveries', 'invoices', 'payments', 'purchases', 'expenses']) scan(`SELECT number AS n FROM ${t}`);
  scan('SELECT code AS n FROM products');
  run('DELETE FROM sequences');
  for (const [k, v] of Object.entries(max)) run('INSERT INTO sequences (key, next) VALUES (?, ?)', k, v + 1);
}

// ======================= SAMPLE DATA =======================
r.get('/sample', A.requirePerm('backup'), h((req, res) => res.json(sampleCounts())));
r.post('/sample/load', A.requirePerm('backup', 'edit'), h((req, res) => {
  if (sampleCounts().total > 0) throw conflict('Sample data is already loaded.');
  require('../seed').seed(req.user.id);
  log(req, 'loaded sample data', 'system', null, 'Sample data');
  res.json({ ok: true, ...sampleCounts() });
}));
// Mark real records that depend on sample records; returns how many were marked.
const SPREAD = [
  "UPDATE quotations SET is_sample = 1 WHERE is_sample = 0 AND customer_id IN (SELECT id FROM parties WHERE is_sample = 1)",
  "UPDATE orders SET is_sample = 1 WHERE is_sample = 0 AND (customer_id IN (SELECT id FROM parties WHERE is_sample = 1) OR id IN (SELECT order_id FROM order_lines WHERE product_id IN (SELECT id FROM products WHERE is_sample = 1)))",
  "UPDATE production_jobs SET is_sample = 1 WHERE is_sample = 0 AND (order_id IN (SELECT id FROM orders WHERE is_sample = 1) OR product_id IN (SELECT id FROM products WHERE is_sample = 1) OR id IN (SELECT job_id FROM production_logs WHERE material_id IN (SELECT id FROM materials WHERE is_sample = 1)))",
  "UPDATE deliveries SET is_sample = 1 WHERE is_sample = 0 AND (customer_id IN (SELECT id FROM parties WHERE is_sample = 1) OR order_id IN (SELECT id FROM orders WHERE is_sample = 1))",
  "UPDATE invoices SET is_sample = 1 WHERE is_sample = 0 AND (customer_id IN (SELECT id FROM parties WHERE is_sample = 1) OR order_id IN (SELECT id FROM orders WHERE is_sample = 1) OR delivery_id IN (SELECT id FROM deliveries WHERE is_sample = 1) OR id IN (SELECT invoice_id FROM invoice_lines WHERE product_id IN (SELECT id FROM products WHERE is_sample = 1)))",
  "UPDATE purchases SET is_sample = 1 WHERE is_sample = 0 AND (supplier_id IN (SELECT id FROM parties WHERE is_sample = 1) OR id IN (SELECT purchase_id FROM purchase_lines WHERE material_id IN (SELECT id FROM materials WHERE is_sample = 1)))",
  `UPDATE payments SET is_sample = 1 WHERE is_sample = 0 AND (party_id IN (SELECT id FROM parties WHERE is_sample = 1) OR order_id IN (SELECT id FROM orders WHERE is_sample = 1)
    OR id IN (SELECT payment_id FROM payment_allocations a WHERE (a.target_type = 'invoice' AND a.target_id IN (SELECT id FROM invoices WHERE is_sample = 1)) OR (a.target_type = 'purchase' AND a.target_id IN (SELECT id FROM purchases WHERE is_sample = 1))))`,
];
function spreadSample() {
  let marked = 0;
  for (let i = 0; i < 10; i++) {
    let changed = 0;
    for (const sql of SPREAD) changed += Number(db.prepare(sql).run().changes);
    marked += changed;
    if (!changed) break;
  }
  return marked;
}
r.post('/sample/remove', A.requirePerm('backup', 'delete'), h((req, res) => {
  const before = sampleCounts();
  if (!before.total) throw conflict('There is no sample data to remove.');
  const force = !!req.body.force;
  // Dry run to find real records that depend on sample ones.
  db.exec('BEGIN IMMEDIATE');
  let linked = 0;
  try { linked = spreadSample(); } finally { db.exec('ROLLBACK'); }
  if (linked && !force) {
    throw conflict(`${linked} of your own record(s) are linked to sample data (for example an order for a sample customer). Remove them too, or keep the sample data.`, { linked });
  }
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(() => {
      spreadSample();
      const S = (t) => `(SELECT id FROM ${t} WHERE is_sample = 1)`;
      run(`UPDATE products SET customer_id = NULL WHERE is_sample = 0 AND customer_id IN ${S('parties')}`);
      run(`UPDATE products SET material_id = NULL WHERE is_sample = 0 AND material_id IN ${S('materials')}`);
      run(`UPDATE materials SET supplier_id = NULL WHERE is_sample = 0 AND supplier_id IN ${S('parties')}`);
      run(`UPDATE expenses SET party_id = NULL WHERE is_sample = 0 AND party_id IN ${S('parties')}`);
      run(`UPDATE quotations SET product_id = NULL WHERE is_sample = 0 AND product_id IN ${S('products')}`);
      run(`UPDATE orders SET quotation_id = NULL WHERE is_sample = 0 AND quotation_id IN ${S('quotations')}`);
      // keep the person removing data, even if their account was sample
      run('UPDATE users SET is_sample = 0 WHERE id = ?', req.user.id);
      for (const [t, c] of [['quotations', 'prepared_by'], ['orders', 'assigned_to'], ['production_jobs', 'assigned_to'], ['production_logs', 'user_id'], ['stock_movements', 'user_id'], ['payments', 'user_id'], ['expenses', 'user_id']]) {
        run(`UPDATE ${t} SET ${c} = NULL WHERE ${c} IN ${S('users')}`);
      }
      run(`DELETE FROM payment_allocations WHERE payment_id IN ${S('payments')} OR (target_type = 'invoice' AND target_id IN ${S('invoices')}) OR (target_type = 'purchase' AND target_id IN ${S('purchases')})`);
      run(`DELETE FROM payments WHERE is_sample = 1`);
      run(`DELETE FROM invoice_lines WHERE invoice_id IN ${S('invoices')}`); run('DELETE FROM invoices WHERE is_sample = 1');
      run(`DELETE FROM delivery_lines WHERE delivery_id IN ${S('deliveries')}`); run('DELETE FROM deliveries WHERE is_sample = 1');
      run(`DELETE FROM production_logs WHERE job_id IN ${S('production_jobs')}`); run('DELETE FROM production_jobs WHERE is_sample = 1');
      run(`DELETE FROM order_lines WHERE order_id IN ${S('orders')}`); run('DELETE FROM orders WHERE is_sample = 1');
      run('DELETE FROM quotations WHERE is_sample = 1');
      run(`DELETE FROM purchase_lines WHERE purchase_id IN ${S('purchases')}`); run('DELETE FROM purchases WHERE is_sample = 1');
      run(`DELETE FROM stock_movements WHERE is_sample = 1 OR (item_kind = 'material' AND item_id IN ${S('materials')}) OR (item_kind = 'product' AND item_id IN ${S('products')})`);
      run('DELETE FROM expenses WHERE is_sample = 1');
      run('DELETE FROM products WHERE is_sample = 1');
      run('DELETE FROM materials WHERE is_sample = 1');
      run('DELETE FROM parties WHERE is_sample = 1');
      run(`DELETE FROM sessions WHERE user_id IN ${S('users')}`);
      run('DELETE FROM users WHERE is_sample = 1');
      rebuildDerived();
      resetSequences();
    });
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
  log(req, 'removed sample data', 'system', null, 'Sample data', { removed: before.counts, linked_records_removed: linked });
  res.json({ ok: true, removed: before.total, linked });
}));

// ======================= BACKUP / RESTORE =======================
const BACKUP_TABLES = ['settings', 'sequences', 'users', 'parties', 'materials', 'products', 'quotations', 'orders', 'order_lines', 'production_jobs',
  'production_logs', 'purchases', 'purchase_lines', 'stock_movements', 'deliveries', 'delivery_lines', 'invoices', 'invoice_lines', 'payments',
  'payment_allocations', 'expenses', 'activity'];
r.get('/backup/json', A.requirePerm('backup'), h((req, res) => {
  const data = { app: 'alkarim-ops', version: 1, exported_at: now(), tables: {} };
  for (const t of BACKUP_TABLES) data.tables[t] = all(`SELECT * FROM ${t}`);
  log(req, 'downloaded backup', 'system', null, 'JSON backup');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="alkarim-backup-${today()}.json"`);
  res.end(JSON.stringify(data));
}));
r.get('/backup/db', A.requirePerm('backup'), h((req, res) => {
  const tmp = path.join(DATA_DIR, `export-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  log(req, 'downloaded backup', 'system', null, 'Database file');
  res.download(tmp, `alkarim-${today()}.db`, () => fs.unlink(tmp, () => {}));
}));
r.post('/backup/restore', A.requirePerm('backup', 'edit'), h((req, res) => {
  if (req.user.role !== 'admin') throw new A.HttpError(403, 'Only administrators can restore a backup.');
  const data = req.body;
  if (!data || data.app !== 'alkarim-ops' || !data.tables || typeof data.tables !== 'object') throw bad('This file is not an Alkarim Ops backup.');
  if (!Array.isArray(data.tables.users) || !data.tables.users.some((u) => u.role === 'admin' && u.active)) throw bad('The backup has no active administrator account, so it cannot be restored.');
  // Safety copy of the current database before replacing anything.
  const safety = path.join(DATA_DIR, `before-restore-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${safety.replace(/'/g, "''")}'`);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(() => {
      run('DELETE FROM sessions');
      run('DELETE FROM notif_reads');
      for (const t of BACKUP_TABLES.slice().reverse()) run(`DELETE FROM ${t}`);
      for (const t of BACKUP_TABLES) {
        const rows = Array.isArray(data.tables[t]) ? data.tables[t] : [];
        const cols = new Set(all(`PRAGMA table_info(${t})`).map((c) => c.name));
        for (const row of rows) {
          const keys = Object.keys(row).filter((k) => cols.has(k));
          if (!keys.length) continue;
          db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
        }
      }
      const fk = all('PRAGMA foreign_key_check');
      if (fk.length) throw bad(`Backup has ${fk.length} broken link(s) between records (first in table ${fk[0].table}). Nothing was changed.`);
    });
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
  ensureDefaults();
  rebuildDerived();
  A.clearCookie(res);
  log(null, 'restored backup', 'system', null, `Backup from ${data.exported_at || 'unknown date'}`, { safety_copy: path.basename(safety) });
  res.json({ ok: true, safety_copy: path.basename(safety) });
}));

module.exports = { pub, r, rebuildDerived };
