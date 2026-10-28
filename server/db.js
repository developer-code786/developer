'use strict';
// SQLite storage using Node's built-in node:sqlite module (no native build step needed on Windows).
const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('\n[Alkarim Ops] This app needs Node.js 22.13 or newer (built-in SQLite).');
  console.error('Download the current LTS from https://nodejs.org and run "npm start" again.\n');
  process.exit(1);
}

const DATA_DIR = process.env.ALKARIM_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, process.env.ALKARIM_DB || 'alkarim.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sequences (key TEXT PRIMARY KEY, next INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL, email TEXT, phone TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'customer', company TEXT NOT NULL,
  contact_name TEXT, phone TEXT, email TEXT, address TEXT, city TEXT, tax_id TEXT,
  contacts TEXT NOT NULL DEFAULT '[]', opening_balance REAL NOT NULL DEFAULT 0,
  credit_limit REAL, payment_terms_days INTEGER, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Paper & Board', unit TEXT NOT NULL DEFAULT 'kg',
  gsm REAL, thickness TEXT, size TEXT, stock_qty REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0, reorder_qty REAL, unit_cost REAL NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES parties(id), location TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  customer_id INTEGER REFERENCES parties(id), type TEXT NOT NULL DEFAULT 'Folding carton',
  photo TEXT, length REAL, width REAL, height REAL, dim_unit TEXT NOT NULL DEFAULT 'mm',
  material_id INTEGER REFERENCES materials(id), material_desc TEXT,
  thickness_value REAL, thickness_unit TEXT NOT NULL DEFAULT 'gsm', ply INTEGER,
  print_method TEXT, print_colors TEXT, print_sides TEXT, print_notes TEXT,
  finishes TEXT NOT NULL DEFAULT '[]', price_tiers TEXT NOT NULL DEFAULT '[]',
  base_price REAL NOT NULL DEFAULT 0, cost_price REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'pcs', stock_qty REAL NOT NULL DEFAULT 0, reorder_level REAL NOT NULL DEFAULT 0,
  notes TEXT, active INTEGER NOT NULL DEFAULT 1, is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, customer_id INTEGER NOT NULL REFERENCES parties(id),
  product_id INTEGER REFERENCES products(id), title TEXT NOT NULL, date TEXT NOT NULL, valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'draft', specs TEXT NOT NULL DEFAULT '{}', costing TEXT NOT NULL DEFAULT '{}',
  tiers TEXT NOT NULL DEFAULT '[]', tax_id TEXT, tax_name TEXT, tax_rate REAL NOT NULL DEFAULT 0,
  notes TEXT, terms TEXT, prepared_by INTEGER REFERENCES users(id), order_id INTEGER,
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, customer_id INTEGER NOT NULL REFERENCES parties(id),
  quotation_id INTEGER REFERENCES quotations(id), po_number TEXT, order_date TEXT NOT NULL, due_date TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', hold_status TEXT, priority TEXT NOT NULL DEFAULT 'normal',
  assigned_to INTEGER REFERENCES users(id), tax_id TEXT, tax_name TEXT, tax_rate REAL NOT NULL DEFAULT 0,
  delivery_address TEXT, specs TEXT, notes TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), description TEXT, specs TEXT,
  qty REAL NOT NULL, unit_price REAL NOT NULL DEFAULT 0, unit_cost_est REAL NOT NULL DEFAULT 0,
  produced_qty REAL NOT NULL DEFAULT 0, passed_qty REAL NOT NULL DEFAULT 0,
  delivered_qty REAL NOT NULL DEFAULT 0, invoiced_qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS production_jobs (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, order_id INTEGER NOT NULL REFERENCES orders(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id), product_id INTEGER REFERENCES products(id),
  title TEXT, qty_target REAL NOT NULL, qty_produced REAL NOT NULL DEFAULT 0,
  qty_passed REAL NOT NULL DEFAULT 0, qty_rejected REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'queued', status TEXT NOT NULL DEFAULT 'open',
  assigned_to INTEGER REFERENCES users(id), machine TEXT, start_date TEXT, due_date TEXT,
  specs TEXT, notes TEXT, is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS production_logs (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES production_jobs(id) ON DELETE CASCADE,
  ts TEXT NOT NULL, user_id INTEGER REFERENCES users(id), kind TEXT NOT NULL, stage TEXT,
  qty_produced REAL, qty_passed REAL, qty_rejected REAL, material_id INTEGER REFERENCES materials(id),
  material_qty REAL, note TEXT
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, supplier_id INTEGER NOT NULL REFERENCES parties(id),
  date TEXT NOT NULL, supplier_ref TEXT, subtotal REAL NOT NULL DEFAULT 0, tax_name TEXT,
  tax_rate REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'unpaid', notes TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchase_lines (
  id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id), qty REAL NOT NULL, unit_cost REAL NOT NULL, amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, date TEXT NOT NULL, item_kind TEXT NOT NULL, item_id INTEGER NOT NULL,
  qty REAL NOT NULL, balance_after REAL, type TEXT NOT NULL, unit_cost REAL, ref_type TEXT, ref_id INTEGER,
  note TEXT, user_id INTEGER REFERENCES users(id), is_sample INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, order_id INTEGER NOT NULL REFERENCES orders(id),
  customer_id INTEGER NOT NULL REFERENCES parties(id), date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'dispatched',
  vehicle TEXT, driver TEXT, receiver_name TEXT, received_date TEXT, address TEXT, notes TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_lines (
  id INTEGER PRIMARY KEY, delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id), product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL, packages TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, customer_id INTEGER NOT NULL REFERENCES parties(id),
  order_id INTEGER REFERENCES orders(id), delivery_id INTEGER REFERENCES deliveries(id),
  date TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'unpaid',
  subtotal REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, tax_id TEXT, tax_name TEXT,
  tax_rate REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0, notes TEXT, void_reason TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_line_id INTEGER REFERENCES order_lines(id), product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL, qty REAL NOT NULL, unit_price REAL NOT NULL, amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, party_id INTEGER NOT NULL REFERENCES parties(id),
  direction TEXT NOT NULL DEFAULT 'in', date TEXT NOT NULL, amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'Bank transfer', reference TEXT, order_id INTEGER REFERENCES orders(id),
  notes TEXT, user_id INTEGER REFERENCES users(id), is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL, target_id INTEGER NOT NULL, amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, date TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT NOT NULL, amount REAL NOT NULL, method TEXT, party_id INTEGER REFERENCES parties(id),
  reference TEXT, notes TEXT, user_id INTEGER REFERENCES users(id),
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, user_id INTEGER, user_name TEXT, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id INTEGER, label TEXT, details TEXT
);
CREATE TABLE IF NOT EXISTS notif_reads (user_id INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (user_id, key));

CREATE INDEX IF NOT EXISTS ix_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS ix_lines_order ON order_lines(order_id);
CREATE INDEX IF NOT EXISTS ix_jobs_order ON production_jobs(order_id);
CREATE INDEX IF NOT EXISTS ix_inv_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS ix_inv_order ON invoices(order_id);
CREATE INDEX IF NOT EXISTS ix_pay_party ON payments(party_id);
CREATE INDEX IF NOT EXISTS ix_alloc_target ON payment_allocations(target_type, target_id);
CREATE INDEX IF NOT EXISTS ix_moves_item ON stock_movements(item_kind, item_id);
CREATE INDEX IF NOT EXISTS ix_activity_entity ON activity(entity, entity_id);
CREATE INDEX IF NOT EXISTS ix_del_order ON deliveries(order_id);
`;
db.exec(SCHEMA);

// ---------- helpers ----------
const now = () => new Date().toISOString();
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

function all(sql, ...params) { return db.prepare(sql).all(...params); }
function get(sql, ...params) { return db.prepare(sql).get(...params); }
function run(sql, ...params) { return db.prepare(sql).run(...params); }

function insert(table, obj) {
  const keys = Object.keys(obj);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const r = run(sql, ...keys.map((k) => norm(obj[k])));
  return Number(r.lastInsertRowid);
}
function update(table, id, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => norm(obj[k])), id);
}
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

let txDepth = 0;
function tx(fn) {
  const sp = `sp${txDepth}`;
  if (txDepth === 0) db.exec('BEGIN IMMEDIATE'); else db.exec(`SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const r = fn();
    txDepth--;
    if (txDepth === 0) db.exec('COMMIT'); else db.exec(`RELEASE ${sp}`);
    return r;
  } catch (e) {
    txDepth--;
    if (txDepth === 0) db.exec('ROLLBACK'); else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

function getSetting(key, fallback) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}
function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

// Document numbering, e.g. QT-2026-0007. Prefixes come from settings.numbering.
function nextNumber(kind, date) {
  const numbering = getSetting('numbering', {});
  const prefix = (numbering[kind] && numbering[kind].trim()) || kind;
  const year = String(date || today()).slice(0, 4);
  const key = `${prefix}-${year}`;
  const row = get('SELECT next FROM sequences WHERE key = ?', key);
  const n = row ? row.next : 1;
  if (row) run('UPDATE sequences SET next = ? WHERE key = ?', n + 1, key);
  else run('INSERT INTO sequences (key, next) VALUES (?, ?)', key, n + 1);
  return `${key}-${String(n).padStart(4, '0')}`;
}

const JSON_COLS = new Set(['contacts', 'finishes', 'price_tiers', 'specs_json', 'costing', 'tiers', 'details']);
function parseRow(row, extra = []) {
  if (!row) return row;
  for (const k of Object.keys(row)) {
    if ((JSON_COLS.has(k) || extra.includes(k)) && typeof row[k] === 'string') {
      try { row[k] = JSON.parse(row[k]); } catch { /* keep string */ }
    }
  }
  return row;
}

module.exports = {
  db, DB_FILE, DATA_DIR, all, get, run, insert, update, tx, now, today, round2, round4,
  getSetting, setSetting, nextNumber, parseRow,
};
