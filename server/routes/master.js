'use strict';
// Customers & suppliers, packaging products, raw materials, expenses.
const express = require('express');
const { all, get, run, insert, update, tx, now, today, round2, parseRow, nextNumber } = require('../db');
const { requirePerm } = require('../auth');
const { validate, notFound, conflict, bad, log, h, diff } = require('../util');
const { partyBalances, moveStock } = require('../logic');

const r = express.Router();

// ======================= PARTIES =======================
const partySpec = {
  kind: { type: 'text', enum: ['customer', 'supplier', 'both'], default: 'customer', label: 'Type' },
  company: { type: 'text', required: true, maxLen: 160, label: 'Company name' },
  contact_name: { type: 'text', maxLen: 120, label: 'Contact person' },
  phone: { type: 'text', maxLen: 60, label: 'Phone' },
  email: { type: 'email', label: 'Email' },
  address: { type: 'text', maxLen: 400, label: 'Address' },
  city: { type: 'text', maxLen: 80, label: 'City' },
  tax_id: { type: 'text', maxLen: 60, label: 'NTN / tax ID' },
  contacts: { type: 'json', jsonDefault: [], label: 'Contacts' },
  opening_balance: { type: 'num', default: 0, label: 'Opening balance' },
  credit_limit: { type: 'num', min: 0, label: 'Credit limit' },
  payment_terms_days: { type: 'int', min: 0, max: 365, label: 'Payment terms' },
  notes: { type: 'text', maxLen: 4000, label: 'Notes' },
  active: { type: 'bool', default: 1 },
};
const PARTY_LIST_SQL = `
SELECT p.*,
  ROUND((CASE WHEN p.kind = 'supplier' THEN 0 ELSE p.opening_balance END)
    + COALESCE((SELECT SUM(total) FROM invoices i WHERE i.customer_id = p.id AND i.status != 'void'),0)
    - COALESCE((SELECT SUM(amount) FROM payments y WHERE y.party_id = p.id AND y.direction = 'in'),0), 2) AS receivable,
  ROUND((CASE WHEN p.kind = 'supplier' THEN p.opening_balance ELSE 0 END)
    + COALESCE((SELECT SUM(total) FROM purchases u WHERE u.supplier_id = p.id),0)
    - COALESCE((SELECT SUM(amount) FROM payments y WHERE y.party_id = p.id AND y.direction = 'out'),0), 2) AS payable,
  (SELECT COUNT(*) FROM orders o WHERE o.customer_id = p.id) AS order_count,
  (SELECT MAX(date) FROM (SELECT date FROM invoices WHERE customer_id = p.id UNION ALL SELECT date FROM payments WHERE party_id = p.id
     UNION ALL SELECT order_date AS date FROM orders WHERE customer_id = p.id UNION ALL SELECT date FROM purchases WHERE supplier_id = p.id)) AS last_activity
FROM parties p`;

r.get('/parties', requirePerm('parties'), h((req, res) => {
  const where = [];
  const params = [];
  if (req.query.kind === 'customer') where.push("p.kind IN ('customer','both')");
  if (req.query.kind === 'supplier') where.push("p.kind IN ('supplier','both')");
  if (req.query.active === '1') where.push('p.active = 1');
  const rows = all(`${PARTY_LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.company COLLATE NOCASE`, ...params);
  res.json(rows.map((x) => parseRow(x)));
}));

r.get('/parties/:id', requirePerm('parties'), h((req, res) => {
  const p = parseRow(get(`${PARTY_LIST_SQL} WHERE p.id = ?`, req.params.id));
  if (!p) throw notFound('Customer or supplier');
  const id = p.id;
  const history = all(`
    SELECT 'quotation' AS type, id, number, date, status, NULL AS amount, title AS label FROM quotations WHERE customer_id = ?
    UNION ALL SELECT 'order', o.id, o.number, o.order_date, o.status,
      (SELECT ROUND(SUM(qty*unit_price)*(1+o.tax_rate/100.0),2) FROM order_lines WHERE order_id = o.id), o.po_number FROM orders o WHERE o.customer_id = ?
    UNION ALL SELECT 'delivery', id, number, date, status, NULL, vehicle FROM deliveries WHERE customer_id = ?
    UNION ALL SELECT 'invoice', id, number, date, status, total, NULL FROM invoices WHERE customer_id = ?
    UNION ALL SELECT 'payment', id, number, date, direction, amount, method FROM payments WHERE party_id = ?
    UNION ALL SELECT 'purchase', id, number, date, status, total, supplier_ref FROM purchases WHERE supplier_id = ?
    UNION ALL SELECT 'expense', id, number, date, category, amount, description FROM expenses WHERE party_id = ?
    ORDER BY date DESC, number DESC LIMIT 300`, id, id, id, id, id, id, id);
  // Ledger (customer side): opening, invoices (debit), receipts (credit); supplier side: purchases (credit), payments out (debit).
  const entries = [];
  const isSupplier = p.kind === 'supplier';
  if (p.opening_balance) entries.push({ date: '', ref: 'Opening balance', debit: isSupplier ? 0 : p.opening_balance, credit: isSupplier ? p.opening_balance : 0 });
  all("SELECT date, number, total FROM invoices WHERE customer_id = ? AND status != 'void'", id).forEach((x) => entries.push({ date: x.date, ref: x.number, kind: 'invoice', debit: x.total, credit: 0 }));
  all("SELECT date, number, amount, direction, method FROM payments WHERE party_id = ?", id).forEach((x) => entries.push({
    date: x.date, ref: `${x.number} · ${x.method}`, kind: 'payment', debit: x.direction === 'out' ? x.amount : 0, credit: x.direction === 'in' ? x.amount : 0,
  }));
  all('SELECT date, number, total FROM purchases WHERE supplier_id = ?', id).forEach((x) => entries.push({ date: x.date, ref: x.number, kind: 'purchase', debit: 0, credit: x.total }));
  entries.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let bal = 0;
  entries.forEach((e) => { bal = round2(bal + e.debit - e.credit); e.balance = bal; });
  const activity = all("SELECT * FROM activity WHERE entity = 'party' AND entity_id = ? ORDER BY id DESC LIMIT 50", id);
  res.json({ ...p, balances: partyBalances(id), history, ledger: entries, activity });
}));

r.post('/parties', requirePerm('parties', 'create'), h((req, res) => {
  const d = validate(req.body, partySpec);
  const dup = get('SELECT id FROM parties WHERE company = ? COLLATE NOCASE AND kind = ?', d.company, d.kind);
  if (dup) throw conflict(`A ${d.kind} named "${d.company}" already exists.`, { fields: { company: 'Name already in use' } });
  const id = insert('parties', { ...d, created_at: now(), updated_at: now() });
  log(req, 'created', 'party', id, d.company);
  res.status(201).json(get('SELECT * FROM parties WHERE id = ?', id));
}));

r.put('/parties/:id', requirePerm('parties', 'edit'), h((req, res) => {
  const before = get('SELECT * FROM parties WHERE id = ?', req.params.id);
  if (!before) throw notFound('Customer or supplier');
  const d = validate(req.body, partySpec);
  update('parties', before.id, { ...d, updated_at: now() });
  const changes = diff(parseRow({ ...before }), d, ['company', 'kind', 'phone', 'email', 'address', 'opening_balance', 'credit_limit', 'active']);
  log(req, 'updated', 'party', before.id, d.company, changes);
  res.json(get('SELECT * FROM parties WHERE id = ?', before.id));
}));

r.delete('/parties/:id', requirePerm('parties', 'delete'), h((req, res) => {
  const p = get('SELECT * FROM parties WHERE id = ?', req.params.id);
  if (!p) throw notFound('Customer or supplier');
  const refs = get(`SELECT (SELECT COUNT(*) FROM quotations WHERE customer_id = ?) + (SELECT COUNT(*) FROM orders WHERE customer_id = ?)
    + (SELECT COUNT(*) FROM invoices WHERE customer_id = ?) + (SELECT COUNT(*) FROM payments WHERE party_id = ?)
    + (SELECT COUNT(*) FROM purchases WHERE supplier_id = ?) AS n`, p.id, p.id, p.id, p.id, p.id).n;
  if (refs > 0) throw conflict(`${p.company} has ${refs} linked transaction(s), so it can't be deleted. Mark it inactive instead.`);
  tx(() => {
    run('UPDATE products SET customer_id = NULL WHERE customer_id = ?', p.id);
    run('UPDATE materials SET supplier_id = NULL WHERE supplier_id = ?', p.id);
    run('UPDATE expenses SET party_id = NULL WHERE party_id = ?', p.id);
    run('DELETE FROM parties WHERE id = ?', p.id);
  });
  log(req, 'deleted', 'party', p.id, p.company);
  res.json({ ok: true });
}));

// ======================= PRODUCTS =======================
const productSpec = {
  code: { type: 'text', required: true, maxLen: 40, label: 'Product code' },
  name: { type: 'text', required: true, maxLen: 160, label: 'Product name' },
  customer_id: { type: 'int', label: 'Customer' },
  type: { type: 'text', required: true, maxLen: 60, label: 'Packaging type' },
  photo: { type: 'text', maxLen: 3_000_000, label: 'Photo' },
  length: { type: 'num', min: 0, label: 'Length' },
  width: { type: 'num', min: 0, label: 'Width' },
  height: { type: 'num', min: 0, label: 'Height / gusset' },
  dim_unit: { type: 'text', default: 'mm', maxLen: 10, label: 'Dimension unit' },
  material_id: { type: 'int', label: 'Material' },
  material_desc: { type: 'text', maxLen: 200, label: 'Material description' },
  thickness_value: { type: 'num', min: 0, label: 'Thickness / GSM' },
  thickness_unit: { type: 'text', default: 'gsm', maxLen: 10, label: 'Thickness unit' },
  ply: { type: 'int', min: 1, max: 15, label: 'Ply' },
  print_method: { type: 'text', maxLen: 40, label: 'Printing method' },
  print_colors: { type: 'text', maxLen: 80, label: 'Colours' },
  print_sides: { type: 'text', maxLen: 40, label: 'Printed sides' },
  print_notes: { type: 'text', maxLen: 1000, label: 'Printing notes' },
  finishes: { type: 'json', jsonDefault: [], label: 'Finishes' },
  price_tiers: { type: 'json', jsonDefault: [], label: 'Price tiers' },
  base_price: { type: 'num', min: 0, default: 0, label: 'Base price' },
  cost_price: { type: 'num', min: 0, default: 0, label: 'Estimated cost' },
  unit: { type: 'text', default: 'pcs', maxLen: 12, label: 'Sales unit' },
  reorder_level: { type: 'num', min: 0, default: 0, label: 'Reorder level' },
  notes: { type: 'text', maxLen: 4000, label: 'Notes' },
  active: { type: 'bool', default: 1 },
};
function cleanTiers(tiers) {
  if (!Array.isArray(tiers)) return [];
  const out = tiers.filter((t) => Number(t.min_qty) > 0 && Number(t.unit_price) >= 0)
    .map((t) => ({ min_qty: Number(t.min_qty), unit_price: Number(t.unit_price) }))
    .sort((a, b) => a.min_qty - b.min_qty);
  const seen = new Set();
  for (const t of out) { if (seen.has(t.min_qty)) throw bad('Each price tier needs a different minimum quantity.', { price_tiers: 'Duplicate quantity' }); seen.add(t.min_qty); }
  return out;
}
const PRODUCT_COLS = `p.id, p.code, p.name, p.customer_id, p.type, (p.photo IS NOT NULL AND p.photo != '') AS has_photo, p.length, p.width, p.height,
  p.dim_unit, p.material_id, p.material_desc, p.thickness_value, p.thickness_unit, p.ply, p.print_method, p.print_colors, p.print_sides,
  p.print_notes, p.finishes, p.price_tiers, p.base_price, p.cost_price, p.unit, p.stock_qty, p.reorder_level, p.notes, p.active,
  p.is_sample, p.created_at, p.updated_at, c.company AS customer_name, m.name AS material_name, m.code AS material_code`;

r.get('/products', requirePerm('products'), h((req, res) => {
  const rows = all(`SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN parties c ON c.id = p.customer_id
    LEFT JOIN materials m ON m.id = p.material_id ORDER BY p.code COLLATE NOCASE`);
  res.json(rows.map((x) => parseRow(x)));
}));
r.get('/products/:id', requirePerm('products'), h((req, res) => {
  const p = parseRow(get(`SELECT ${PRODUCT_COLS}, p.photo FROM products p LEFT JOIN parties c ON c.id = p.customer_id
    LEFT JOIN materials m ON m.id = p.material_id WHERE p.id = ?`, req.params.id));
  if (!p) throw notFound('Product');
  p.orders = all(`SELECT o.id, o.number, o.order_date, o.status, l.qty, l.unit_price, c.company FROM order_lines l
    JOIN orders o ON o.id = l.order_id JOIN parties c ON c.id = o.customer_id WHERE l.product_id = ? ORDER BY o.order_date DESC LIMIT 50`, p.id);
  p.movements = all("SELECT * FROM stock_movements WHERE item_kind = 'product' AND item_id = ? ORDER BY id DESC LIMIT 50", p.id);
  p.activity = all("SELECT * FROM activity WHERE entity = 'product' AND entity_id = ? ORDER BY id DESC LIMIT 30", p.id);
  res.json(p);
}));
r.get('/products/:id/photo', requirePerm('products'), h((req, res) => {
  const p = get('SELECT photo FROM products WHERE id = ?', req.params.id);
  const m = p && p.photo && /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(p.photo);
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m[1]);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.end(Buffer.from(m[2], 'base64'));
}));
function checkPhoto(photo) {
  if (photo && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(photo)) throw bad('Photo must be a PNG, JPG, WEBP or GIF image.', { photo: 'Unsupported image' });
}
r.post('/products', requirePerm('products', 'create'), h((req, res) => {
  const d = validate(req.body, productSpec);
  d.price_tiers = cleanTiers(d.price_tiers);
  d.finishes = Array.isArray(d.finishes) ? d.finishes.map(String) : [];
  checkPhoto(d.photo);
  if (get('SELECT id FROM products WHERE code = ?', d.code)) throw conflict(`Product code ${d.code} is already used.`, { fields: { code: 'Code already in use' } });
  const opening = Number(req.body.opening_stock) || 0;
  const id = tx(() => {
    const nid = insert('products', { ...d, stock_qty: 0, created_at: now(), updated_at: now() });
    if (opening > 0) moveStock({ kind: 'product', id: nid, qty: opening, type: 'opening', note: 'Opening stock', userId: req.user.id });
    return nid;
  });
  log(req, 'created', 'product', id, `${d.code} · ${d.name}`);
  res.status(201).json(get('SELECT id, code, name FROM products WHERE id = ?', id));
}));
r.put('/products/:id', requirePerm('products', 'edit'), h((req, res) => {
  const before = get('SELECT * FROM products WHERE id = ?', req.params.id);
  if (!before) throw notFound('Product');
  const d = validate(req.body, productSpec);
  d.price_tiers = cleanTiers(d.price_tiers);
  d.finishes = Array.isArray(d.finishes) ? d.finishes.map(String) : [];
  checkPhoto(d.photo);
  const dup = get('SELECT id FROM products WHERE code = ? AND id != ?', d.code, before.id);
  if (dup) throw conflict(`Product code ${d.code} is already used.`, { fields: { code: 'Code already in use' } });
  update('products', before.id, { ...d, updated_at: now() });
  const changes = diff(parseRow({ ...before }), d, ['code', 'name', 'type', 'base_price', 'cost_price', 'price_tiers', 'thickness_value', 'print_method', 'finishes', 'active']);
  if (before.photo !== d.photo) changes.photo = { from: before.photo ? 'image' : null, to: d.photo ? 'image' : null };
  log(req, 'updated', 'product', before.id, `${d.code} · ${d.name}`, changes);
  res.json({ ok: true });
}));
r.delete('/products/:id', requirePerm('products', 'delete'), h((req, res) => {
  const p = get('SELECT id, code, name FROM products WHERE id = ?', req.params.id);
  if (!p) throw notFound('Product');
  const refs = get(`SELECT (SELECT COUNT(*) FROM order_lines WHERE product_id = ?) + (SELECT COUNT(*) FROM quotations WHERE product_id = ?)
    + (SELECT COUNT(*) FROM invoice_lines WHERE product_id = ?) AS n`, p.id, p.id, p.id).n;
  if (refs) throw conflict(`${p.code} is used on ${refs} quotation/order/invoice line(s). Mark it inactive instead.`);
  tx(() => {
    run("DELETE FROM stock_movements WHERE item_kind = 'product' AND item_id = ?", p.id);
    run('DELETE FROM products WHERE id = ?', p.id);
  });
  log(req, 'deleted', 'product', p.id, `${p.code} · ${p.name}`);
  res.json({ ok: true });
}));

// ======================= MATERIALS =======================
const materialSpec = {
  code: { type: 'text', required: true, maxLen: 40, label: 'Material code' },
  name: { type: 'text', required: true, maxLen: 160, label: 'Material name' },
  category: { type: 'text', required: true, maxLen: 60, label: 'Category' },
  unit: { type: 'text', required: true, maxLen: 12, label: 'Stock unit' },
  gsm: { type: 'num', min: 0, label: 'GSM' },
  thickness: { type: 'text', maxLen: 40, label: 'Thickness' },
  size: { type: 'text', maxLen: 60, label: 'Size' },
  reorder_level: { type: 'num', min: 0, default: 0, label: 'Reorder level' },
  reorder_qty: { type: 'num', min: 0, label: 'Reorder quantity' },
  unit_cost: { type: 'num', min: 0, default: 0, label: 'Unit cost' },
  supplier_id: { type: 'int', label: 'Supplier' },
  location: { type: 'text', maxLen: 80, label: 'Location' },
  notes: { type: 'text', maxLen: 2000, label: 'Notes' },
  active: { type: 'bool', default: 1 },
};
r.get('/materials', requirePerm('inventory'), h((req, res) => {
  res.json(all(`SELECT m.*, s.company AS supplier_name, ROUND(m.stock_qty * m.unit_cost, 2) AS stock_value,
    (m.stock_qty <= m.reorder_level AND m.reorder_level > 0) AS low
    FROM materials m LEFT JOIN parties s ON s.id = m.supplier_id ORDER BY m.code COLLATE NOCASE`));
}));
r.get('/materials/:id', requirePerm('inventory'), h((req, res) => {
  const m = get(`SELECT m.*, s.company AS supplier_name FROM materials m LEFT JOIN parties s ON s.id = m.supplier_id WHERE m.id = ?`, req.params.id);
  if (!m) throw notFound('Material');
  m.movements = all(`SELECT sm.*, u.name AS user_name FROM stock_movements sm LEFT JOIN users u ON u.id = sm.user_id
    WHERE item_kind = 'material' AND item_id = ? ORDER BY sm.id DESC LIMIT 100`, m.id);
  m.activity = all("SELECT * FROM activity WHERE entity = 'material' AND entity_id = ? ORDER BY id DESC LIMIT 30", m.id);
  res.json(m);
}));
r.post('/materials', requirePerm('inventory', 'create'), h((req, res) => {
  const d = validate(req.body, materialSpec);
  if (get('SELECT id FROM materials WHERE code = ?', d.code)) throw conflict(`Material code ${d.code} is already used.`, { fields: { code: 'Code already in use' } });
  const opening = Number(req.body.opening_stock) || 0;
  if (opening < 0) throw bad('Opening stock cannot be negative', { opening_stock: 'Must be 0 or more' });
  const id = tx(() => {
    const nid = insert('materials', { ...d, stock_qty: 0, created_at: now(), updated_at: now() });
    if (opening > 0) moveStock({ kind: 'material', id: nid, qty: opening, type: 'opening', unitCost: d.unit_cost, note: 'Opening stock', userId: req.user.id });
    return nid;
  });
  log(req, 'created', 'material', id, `${d.code} · ${d.name}`);
  res.status(201).json(get('SELECT * FROM materials WHERE id = ?', id));
}));
r.put('/materials/:id', requirePerm('inventory', 'edit'), h((req, res) => {
  const before = get('SELECT * FROM materials WHERE id = ?', req.params.id);
  if (!before) throw notFound('Material');
  const d = validate(req.body, materialSpec);
  if (get('SELECT id FROM materials WHERE code = ? AND id != ?', d.code, before.id)) throw conflict(`Material code ${d.code} is already used.`, { fields: { code: 'Code already in use' } });
  update('materials', before.id, { ...d, updated_at: now() });
  log(req, 'updated', 'material', before.id, `${d.code} · ${d.name}`, diff(before, d, ['code', 'name', 'unit', 'unit_cost', 'reorder_level', 'supplier_id', 'active']));
  res.json({ ok: true });
}));
r.delete('/materials/:id', requirePerm('inventory', 'delete'), h((req, res) => {
  const m = get('SELECT * FROM materials WHERE id = ?', req.params.id);
  if (!m) throw notFound('Material');
  const refs = get(`SELECT (SELECT COUNT(*) FROM purchase_lines WHERE material_id = ?) + (SELECT COUNT(*) FROM production_logs WHERE material_id = ?) AS n`, m.id, m.id).n;
  if (refs) throw conflict(`${m.code} has ${refs} purchase or consumption record(s). Mark it inactive instead.`);
  tx(() => {
    run('UPDATE products SET material_id = NULL WHERE material_id = ?', m.id);
    run("DELETE FROM stock_movements WHERE item_kind = 'material' AND item_id = ?", m.id);
    run('DELETE FROM materials WHERE id = ?', m.id);
  });
  log(req, 'deleted', 'material', m.id, `${m.code} · ${m.name}`);
  res.json({ ok: true });
}));

// ======================= EXPENSES =======================
const expenseSpec = {
  date: { type: 'date', required: true, label: 'Date' },
  category: { type: 'text', required: true, maxLen: 60, label: 'Category' },
  description: { type: 'text', required: true, maxLen: 300, label: 'Description' },
  amount: { type: 'num', required: true, gt: 0, label: 'Amount' },
  method: { type: 'text', maxLen: 40, label: 'Payment method' },
  party_id: { type: 'int', label: 'Paid to' },
  reference: { type: 'text', maxLen: 80, label: 'Reference' },
  notes: { type: 'text', maxLen: 2000, label: 'Notes' },
};
r.get('/expenses', requirePerm('expenses'), h((req, res) => {
  res.json(all(`SELECT e.*, p.company AS party_name, u.name AS user_name FROM expenses e LEFT JOIN parties p ON p.id = e.party_id
    LEFT JOIN users u ON u.id = e.user_id ORDER BY e.date DESC, e.id DESC`));
}));
r.post('/expenses', requirePerm('expenses', 'create'), h((req, res) => {
  const d = validate(req.body, expenseSpec);
  d.amount = round2(d.amount);
  const id = tx(() => insert('expenses', { ...d, number: nextNumber('EXP', d.date), user_id: req.user.id, created_at: now() }));
  const e = get('SELECT * FROM expenses WHERE id = ?', id);
  log(req, 'created', 'expense', id, `${e.number} · ${d.category}`, { amount: d.amount });
  res.status(201).json(e);
}));
r.put('/expenses/:id', requirePerm('expenses', 'edit'), h((req, res) => {
  const before = get('SELECT * FROM expenses WHERE id = ?', req.params.id);
  if (!before) throw notFound('Expense');
  const d = validate(req.body, expenseSpec);
  d.amount = round2(d.amount);
  update('expenses', before.id, d);
  log(req, 'updated', 'expense', before.id, before.number, diff(before, d, ['date', 'category', 'amount', 'description']));
  res.json({ ok: true });
}));
r.delete('/expenses/:id', requirePerm('expenses', 'delete'), h((req, res) => {
  const e = get('SELECT * FROM expenses WHERE id = ?', req.params.id);
  if (!e) throw notFound('Expense');
  run('DELETE FROM expenses WHERE id = ?', e.id);
  log(req, 'deleted', 'expense', e.id, e.number, { amount: e.amount, category: e.category });
  res.json({ ok: true });
}));

module.exports = r;
