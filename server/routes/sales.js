'use strict';
// Quotations → orders → production jobs.
const express = require('express');
const { all, get, run, insert, update, tx, now, today, round2, round4, parseRow, nextNumber, getSetting } = require('../db');
const { requirePerm, can } = require('../auth');
const { validate, notFound, conflict, bad, log, h, diff } = require('../util');
const { buildTiers, quoteCalc, moveStock, orderTotals, recomputeOrderStatus, syncLineProduction } = require('../logic');

const r = express.Router();

function taxById(taxId) {
  if (!taxId) return { tax_id: null, tax_name: null, tax_rate: 0 };
  const t = (getSetting('taxes', []) || []).find((x) => String(x.id) === String(taxId));
  if (!t) throw bad('The selected tax rate no longer exists. Pick another in the tax field.', { tax_id: 'Unknown tax' });
  return { tax_id: String(t.id), tax_name: t.name, tax_rate: Number(t.rate) || 0 };
}
function specSummary(s) {
  if (!s) return '';
  const dims = [s.length, s.width, s.height].filter((x) => x !== '' && x != null && Number(x) > 0);
  const parts = [
    s.type,
    dims.length ? `${dims.join(' × ')} ${s.dim_unit || 'mm'}` : null,
    [s.thickness_value ? `${s.thickness_value} ${s.thickness_unit || 'gsm'}` : null, s.material].filter(Boolean).join(' '),
    s.ply ? `${s.ply}-ply` : null,
    [s.print_method, s.print_colors].filter(Boolean).join(' '),
    Array.isArray(s.finishes) && s.finishes.length ? s.finishes.join(', ') : null,
  ];
  return parts.filter((x) => x && String(x).trim()).join(' · ');
}
function checkParty(id, kind = 'customer') {
  const p = get('SELECT id, kind, company, active FROM parties WHERE id = ?', id);
  if (!p) throw bad(`Select a valid ${kind}.`, { customer_id: 'Not found' });
  if (kind === 'customer' && p.kind === 'supplier') throw bad(`${p.company} is set up as a supplier only.`, { customer_id: 'Not a customer' });
  return p;
}

// ======================= QUOTATIONS =======================
const QSTATUS = ['draft', 'sent', 'approved', 'rejected', 'expired', 'converted'];
const quoteSpec = {
  customer_id: { type: 'int', required: true, label: 'Customer' },
  product_id: { type: 'int', label: 'Product' },
  title: { type: 'text', required: true, maxLen: 200, label: 'Job title' },
  date: { type: 'date', required: true, label: 'Quotation date' },
  valid_until: { type: 'date', label: 'Valid until' },
  specs: { type: 'json', jsonDefault: {}, label: 'Specifications' },
  costing: { type: 'json', jsonDefault: {}, label: 'Costing' },
  tiers: { type: 'json', jsonDefault: [], label: 'Quantities' },
  tax_id: { type: 'text', label: 'Tax' },
  notes: { type: 'text', maxLen: 4000, label: 'Notes' },
  terms: { type: 'text', maxLen: 4000, label: 'Terms' },
};
function prepQuote(body) {
  const d = validate(body, quoteSpec);
  checkParty(d.customer_id);
  if (d.product_id && !get('SELECT id FROM products WHERE id = ?', d.product_id)) throw bad('Selected product not found', { product_id: 'Not found' });
  if (d.valid_until && d.valid_until < d.date) throw bad('Valid-until date must be on or after the quotation date.', { valid_until: 'Before quotation date' });
  const c = d.costing || {};
  for (const m of c.materials || []) {
    if (Number(m.qty) < 0 || Number(m.rate) < 0) throw bad('Material quantities and rates cannot be negative.', { costing: 'Negative value' });
  }
  for (const l of c.lines || []) {
    if (Number(l.setup) < 0 || Number(l.per_unit) < 0) throw bad('Cost lines cannot be negative.', { costing: 'Negative value' });
  }
  if (Number(c.wastage_pct) < 0 || Number(c.wastage_pct) > 100) throw bad('Wastage must be between 0 and 100%.', { wastage_pct: '0 to 100' });
  if (Number(c.profit_pct) < -100 || Number(c.profit_pct) > 1000) throw bad('Profit % looks wrong.', { profit_pct: 'Check value' });
  const tiers = buildTiers(c, d.tiers);
  if (!tiers.length) throw bad('Add at least one quantity to price.', { tiers: 'At least one quantity is required' });
  if (new Set(tiers.map((t) => t.qty)).size !== tiers.length) throw bad('Each quantity can appear only once.', { tiers: 'Duplicate quantity' });
  return { ...d, tiers, ...taxById(d.tax_id) };
}
const QUOTE_LIST = `SELECT q.id, q.number, q.customer_id, q.product_id, q.title, q.date, q.valid_until, q.status, q.tiers, q.tax_name, q.tax_rate,
  q.order_id, q.is_sample, q.created_at, q.updated_at, c.company AS customer_name, u.name AS prepared_by_name, o.number AS order_number
  FROM quotations q JOIN parties c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.prepared_by LEFT JOIN orders o ON o.id = q.order_id`;

r.get('/quotations', requirePerm('quotations'), h((req, res) => {
  res.json(all(`${QUOTE_LIST} ORDER BY q.date DESC, q.id DESC`).map((x) => parseRow(x)));
}));
r.get('/quotations/:id', requirePerm('quotations'), h((req, res) => {
  const q = parseRow(get(`SELECT q.*, c.company AS customer_name, c.address AS customer_address, c.contact_name AS customer_contact,
    c.phone AS customer_phone, c.email AS customer_email, u.name AS prepared_by_name, o.number AS order_number, p.code AS product_code
    FROM quotations q JOIN parties c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.prepared_by
    LEFT JOIN orders o ON o.id = q.order_id LEFT JOIN products p ON p.id = q.product_id WHERE q.id = ?`, req.params.id), ['specs']);
  if (!q) throw notFound('Quotation');
  q.spec_summary = specSummary(q.specs);
  q.activity = all("SELECT * FROM activity WHERE entity = 'quotation' AND entity_id = ? ORDER BY id DESC LIMIT 50", q.id);
  res.json(q);
}));
r.post('/quotations/calc', requirePerm('quotations'), h((req, res) => {
  res.json({ tiers: buildTiers(req.body.costing, req.body.tiers), breakdown: (req.body.tiers || []).map((t) => quoteCalc(req.body.costing, t.qty)) });
}));
r.post('/quotations', requirePerm('quotations', 'create'), h((req, res) => {
  const d = prepQuote(req.body);
  const status = QSTATUS.includes(req.body.status) && ['draft', 'sent'].includes(req.body.status) ? req.body.status : 'draft';
  const id = tx(() => insert('quotations', {
    ...d, number: nextNumber('QT', d.date), status, prepared_by: req.user.id, created_at: now(), updated_at: now(),
  }));
  const q = get('SELECT id, number FROM quotations WHERE id = ?', id);
  log(req, 'created', 'quotation', id, `${q.number} · ${d.title}`, { tiers: d.tiers.map((t) => `${t.qty} @ ${t.unit_price}`) });
  res.status(201).json(q);
}));
r.put('/quotations/:id', requirePerm('quotations', 'edit'), h((req, res) => {
  const before = parseRow(get('SELECT * FROM quotations WHERE id = ?', req.params.id), ['specs']);
  if (!before) throw notFound('Quotation');
  if (before.status === 'converted') throw conflict('This quotation has already become an order and can no longer be edited. Duplicate it to make a revised quote.');
  const d = prepQuote(req.body);
  const status = before.status === 'approved' ? 'sent' : before.status; // edits after approval need re-approval
  update('quotations', before.id, { ...d, status, updated_at: now() });
  log(req, 'updated', 'quotation', before.id, `${before.number} · ${d.title}`, {
    ...diff(before, d, ['title', 'customer_id', 'valid_until', 'tax_rate']),
    ...(JSON.stringify(before.tiers) !== JSON.stringify(d.tiers) ? { prices: { from: before.tiers.map((t) => `${t.qty} @ ${t.unit_price}`), to: d.tiers.map((t) => `${t.qty} @ ${t.unit_price}`) } } : {}),
    ...(status !== before.status ? { status: { from: before.status, to: status } } : {}),
  });
  res.json({ ok: true, status });
}));
r.post('/quotations/:id/status', requirePerm('quotations', 'edit'), h((req, res) => {
  const q = get('SELECT * FROM quotations WHERE id = ?', req.params.id);
  if (!q) throw notFound('Quotation');
  const to = String(req.body.status || '');
  const allowed = { draft: ['sent', 'approved', 'rejected'], sent: ['approved', 'rejected', 'draft', 'expired'], approved: ['sent', 'rejected'], rejected: ['draft', 'sent'], expired: ['draft', 'sent'], converted: [] };
  if (!(allowed[q.status] || []).includes(to)) throw conflict(`A ${q.status} quotation can't be marked ${to}.`);
  update('quotations', q.id, { status: to, updated_at: now() });
  log(req, to === 'approved' ? 'approved' : 'status', 'quotation', q.id, q.number, { status: { from: q.status, to } });
  res.json({ ok: true });
}));
r.post('/quotations/:id/duplicate', requirePerm('quotations', 'create'), h((req, res) => {
  const q = get('SELECT * FROM quotations WHERE id = ?', req.params.id);
  if (!q) throw notFound('Quotation');
  const d = today();
  const validity = getSetting('defaults', {}).quoteValidityDays || 15;
  const id = tx(() => insert('quotations', {
    number: nextNumber('QT', d), customer_id: q.customer_id, product_id: q.product_id, title: q.title, date: d,
    valid_until: new Date(Date.now() + validity * 864e5).toISOString().slice(0, 10), status: 'draft', specs: q.specs, costing: q.costing,
    tiers: q.tiers, tax_id: q.tax_id, tax_name: q.tax_name, tax_rate: q.tax_rate, notes: q.notes, terms: q.terms,
    prepared_by: req.user.id, created_at: now(), updated_at: now(),
  }));
  const n = get('SELECT id, number FROM quotations WHERE id = ?', id);
  log(req, 'created', 'quotation', id, `${n.number} (copy of ${q.number})`);
  res.status(201).json(n);
}));
r.delete('/quotations/:id', requirePerm('quotations', 'delete'), h((req, res) => {
  const q = get('SELECT * FROM quotations WHERE id = ?', req.params.id);
  if (!q) throw notFound('Quotation');
  if (q.status === 'converted' || q.order_id) throw conflict('Converted quotations are kept for the order history and cannot be deleted.');
  run('DELETE FROM quotations WHERE id = ?', q.id);
  log(req, 'deleted', 'quotation', q.id, `${q.number} · ${q.title}`);
  res.json({ ok: true });
}));

// Approved quotation → product (if needed) → order → production job, in one step.
r.post('/quotations/:id/convert', requirePerm('quotations', 'edit'), requirePerm('orders', 'create'), h((req, res) => {
  const q = parseRow(get('SELECT * FROM quotations WHERE id = ?', req.params.id), ['specs']);
  if (!q) throw notFound('Quotation');
  if (q.status === 'converted') throw conflict(`Already converted to an order.`);
  if (q.status !== 'approved') throw conflict('Approve the quotation before converting it to an order.');
  const b = validate(req.body, {
    qty: { type: 'num', required: true, gt: 0, label: 'Quantity' },
    due_date: { type: 'date', label: 'Delivery deadline' },
    po_number: { type: 'text', maxLen: 60, label: 'Customer PO' },
    assigned_to: { type: 'int', label: 'Assigned to' },
    priority: { type: 'text', enum: ['low', 'normal', 'high', 'urgent'], default: 'normal', label: 'Priority' },
    create_job: { type: 'bool', default: 1 },
  });
  const tier = q.tiers.find((t) => Number(t.qty) === Number(b.qty));
  let unitPrice, unitCost;
  if (tier) { unitPrice = tier.unit_price; unitCost = tier.unit_cost; } else {
    const calc = quoteCalc(q.costing, b.qty);
    unitPrice = round2(calc.unit_price); unitCost = calc.unit_cost;
  }
  if (b.create_job && !can(req.user, 'production', 'create')) b.create_job = 0;
  const out = tx(() => {
    let productId = q.product_id;
    if (!productId) {
      const s = q.specs || {};
      productId = insert('products', {
        code: nextNumber('PRD'), name: q.title, customer_id: q.customer_id, type: s.type || 'Other',
        length: s.length || null, width: s.width || null, height: s.height || null, dim_unit: s.dim_unit || 'mm',
        material_id: s.material_id || null, material_desc: s.material || null, thickness_value: s.thickness_value || null,
        thickness_unit: s.thickness_unit || 'gsm', ply: s.ply || null, print_method: s.print_method || null,
        print_colors: s.print_colors || null, print_sides: s.print_sides || null, print_notes: s.print_notes || null,
        finishes: JSON.stringify(s.finishes || []),
        price_tiers: JSON.stringify(q.tiers.map((t) => ({ min_qty: t.qty, unit_price: t.unit_price }))),
        base_price: unitPrice, cost_price: unitCost, unit: s.unit || 'pcs', notes: `Created from ${q.number}`,
        is_sample: q.is_sample, created_at: now(), updated_at: now(),
      });
      update('quotations', q.id, { product_id: productId });
    }
    const date = today();
    const orderId = insert('orders', {
      number: nextNumber('SO', date), customer_id: q.customer_id, quotation_id: q.id, po_number: b.po_number,
      order_date: date, due_date: b.due_date, status: 'confirmed', priority: b.priority, assigned_to: b.assigned_to,
      tax_id: q.tax_id, tax_name: q.tax_name, tax_rate: q.tax_rate, specs: specSummary(q.specs), notes: q.notes,
      is_sample: q.is_sample, created_at: now(), updated_at: now(),
    });
    const lineId = insert('order_lines', {
      order_id: orderId, product_id: productId, description: q.title, specs: specSummary(q.specs),
      qty: b.qty, unit_price: unitPrice, unit_cost_est: unitCost,
    });
    let jobId = null;
    if (b.create_job) {
      jobId = insert('production_jobs', {
        number: nextNumber('JOB', date), order_id: orderId, order_line_id: lineId, product_id: productId, title: q.title,
        qty_target: b.qty, stage: 'queued', status: 'open', assigned_to: null, due_date: b.due_date,
        specs: [specSummary(q.specs), q.specs && q.specs.print_notes].filter(Boolean).join('\n'),
        is_sample: q.is_sample, created_at: now(), updated_at: now(),
      });
    }
    update('quotations', q.id, { status: 'converted', order_id: orderId, updated_at: now() });
    return { orderId, jobId, productId };
  });
  const o = get('SELECT id, number FROM orders WHERE id = ?', out.orderId);
  log(req, 'converted', 'quotation', q.id, `${q.number} → ${o.number}`, { qty: b.qty, unit_price: unitPrice });
  log(req, 'created', 'order', o.id, `${o.number} from ${q.number}`, { qty: b.qty, unit_price: unitPrice });
  if (out.jobId) log(req, 'created', 'job', out.jobId, `Job for ${o.number}`);
  res.status(201).json({ order: o, job_id: out.jobId, product_id: out.productId });
}));

// ======================= ORDERS =======================
const orderSpec = {
  customer_id: { type: 'int', required: true, label: 'Customer' },
  po_number: { type: 'text', maxLen: 60, label: 'Customer PO' },
  order_date: { type: 'date', required: true, label: 'Order date' },
  due_date: { type: 'date', label: 'Delivery deadline' },
  priority: { type: 'text', enum: ['low', 'normal', 'high', 'urgent'], default: 'normal', label: 'Priority' },
  assigned_to: { type: 'int', label: 'Assigned to' },
  tax_id: { type: 'text', label: 'Tax' },
  delivery_address: { type: 'text', maxLen: 400, label: 'Delivery address' },
  specs: { type: 'text', maxLen: 4000, label: 'Job specifications' },
  notes: { type: 'text', maxLen: 4000, label: 'Notes' },
  lines: { type: 'json', required: true, label: 'Items' },
};
const lineSpec = {
  id: { type: 'int' },
  product_id: { type: 'int', required: true, label: 'Product' },
  description: { type: 'text', maxLen: 300, label: 'Description' },
  specs: { type: 'text', maxLen: 2000, label: 'Specs' },
  qty: { type: 'num', required: true, gt: 0, label: 'Quantity' },
  unit_price: { type: 'num', required: true, min: 0, label: 'Unit price' },
  unit_cost_est: { type: 'num', min: 0, label: 'Est. unit cost' },
};
function prepOrder(body) {
  const d = validate(body, orderSpec);
  checkParty(d.customer_id);
  if (d.due_date && d.due_date < d.order_date) throw bad('Deadline must be on or after the order date.', { due_date: 'Before order date' });
  if (d.assigned_to && !get('SELECT id FROM users WHERE id = ?', d.assigned_to)) throw bad('Assigned staff member not found', { assigned_to: 'Not found' });
  if (!Array.isArray(d.lines) || !d.lines.length) throw bad('Add at least one item to the order.', { lines: 'At least one item' });
  d.lines = d.lines.map((l, i) => {
    let v;
    try { v = validate(l, lineSpec); } catch (e) { e.message = `Item ${i + 1}: ${Object.values(e.extra.fields)[0]}`; throw e; }
    const p = get('SELECT id, name, cost_price FROM products WHERE id = ?', v.product_id);
    if (!p) throw bad(`Item ${i + 1}: product not found`);
    if (!v.description) v.description = p.name;
    if (v.unit_cost_est == null) v.unit_cost_est = p.cost_price || 0;
    return v;
  });
  return { ...d, ...taxById(d.tax_id) };
}
const ORDER_LIST = `SELECT o.*, c.company AS customer_name, u.name AS assigned_name, q.number AS quotation_number,
  (SELECT ROUND(SUM(qty*unit_price),2) FROM order_lines WHERE order_id = o.id) AS subtotal,
  (SELECT SUM(qty) FROM order_lines WHERE order_id = o.id) AS total_qty,
  (SELECT SUM(MIN(delivered_qty, qty)) FROM order_lines WHERE order_id = o.id) AS delivered_qty,
  (SELECT SUM(MIN(passed_qty, qty)) FROM order_lines WHERE order_id = o.id) AS passed_qty,
  (SELECT SUM(MIN(produced_qty, qty)) FROM order_lines WHERE order_id = o.id) AS produced_qty,
  (SELECT GROUP_CONCAT(COALESCE(l.description, p.name), ', ') FROM order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = o.id) AS items,
  (SELECT COUNT(*) FROM production_jobs WHERE order_id = o.id AND status != 'cancelled') AS job_count
  FROM orders o JOIN parties c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.assigned_to LEFT JOIN quotations q ON q.id = o.quotation_id`;

function withTotals(o) {
  o.total = round2((o.subtotal || 0) * (1 + (o.tax_rate || 0) / 100));
  o.progress_pct = o.total_qty ? Math.round(((o.delivered_qty || 0) / o.total_qty) * 100) : 0;
  o.production_pct = o.total_qty ? Math.round(((o.passed_qty || 0) / o.total_qty) * 100) : 0;
  o.overdue = !!(o.due_date && o.due_date < today() && !['delivered', 'cancelled'].includes(o.status));
  return o;
}
r.get('/orders', requirePerm('orders'), h((req, res) => {
  res.json(all(`${ORDER_LIST} ORDER BY o.order_date DESC, o.id DESC`).map(withTotals));
}));
r.get('/orders/:id', requirePerm('orders'), h((req, res) => {
  const o = get(`${ORDER_LIST} WHERE o.id = ?`, req.params.id);
  if (!o) throw notFound('Order');
  withTotals(o);
  const c = get('SELECT address, phone, contact_name, email FROM parties WHERE id = ?', o.customer_id);
  o.customer = c;
  o.lines = all(`SELECT l.*, p.code AS product_code, p.name AS product_name, p.unit, p.stock_qty AS product_stock
    FROM order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = ? ORDER BY l.id`, o.id);
  o.jobs = all(`SELECT j.*, u.name AS assigned_name FROM production_jobs j LEFT JOIN users u ON u.id = j.assigned_to WHERE j.order_id = ? ORDER BY j.id`, o.id);
  o.deliveries = all('SELECT d.*, (SELECT SUM(qty) FROM delivery_lines WHERE delivery_id = d.id) AS qty FROM deliveries d WHERE order_id = ? ORDER BY date, id', o.id);
  o.invoices = all('SELECT id, number, date, due_date, status, total, paid_amount FROM invoices WHERE order_id = ? ORDER BY date, id', o.id);
  o.payments = all(`SELECT p.id, p.number, p.date, p.amount, p.method, p.reference FROM payments p WHERE p.order_id = ? AND p.direction = 'in'
    UNION SELECT p.id, p.number, p.date, a.amount, p.method, p.reference FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
    JOIN invoices i ON i.id = a.target_id WHERE a.target_type = 'invoice' AND i.order_id = ? AND (p.order_id IS NULL OR p.order_id != ?)
    ORDER BY date`, o.id, o.id, o.id);
  o.totals = orderTotals(o.id);
  o.activity = all(`SELECT * FROM activity WHERE (entity = 'order' AND entity_id = ?) OR (entity = 'job' AND entity_id IN (SELECT id FROM production_jobs WHERE order_id = ?))
    OR (entity = 'delivery' AND entity_id IN (SELECT id FROM deliveries WHERE order_id = ?)) OR (entity = 'invoice' AND entity_id IN (SELECT id FROM invoices WHERE order_id = ?))
    ORDER BY id DESC LIMIT 80`, o.id, o.id, o.id, o.id);
  res.json(o);
}));
r.post('/orders', requirePerm('orders', 'create'), h((req, res) => {
  const d = prepOrder(req.body);
  const createJobs = !!req.body.create_jobs && can(req.user, 'production', 'create');
  const { lines, ...head } = d;
  const id = tx(() => {
    const oid = insert('orders', { ...head, number: nextNumber('SO', d.order_date), status: 'confirmed', created_at: now(), updated_at: now() });
    for (const l of lines) {
      const { id: _ignore, ...rest } = l;
      const lid = insert('order_lines', { ...rest, order_id: oid });
      if (createJobs) {
        insert('production_jobs', {
          number: nextNumber('JOB', d.order_date), order_id: oid, order_line_id: lid, product_id: l.product_id, title: l.description,
          qty_target: l.qty, stage: 'queued', status: 'open', due_date: d.due_date, specs: [l.specs, d.specs].filter(Boolean).join('\n'),
          created_at: now(), updated_at: now(),
        });
      }
    }
    return oid;
  });
  const o = get('SELECT id, number FROM orders WHERE id = ?', id);
  log(req, 'created', 'order', id, o.number, { items: lines.length });
  res.status(201).json(o);
}));
r.put('/orders/:id', requirePerm('orders', 'edit'), h((req, res) => {
  const before = get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!before) throw notFound('Order');
  if (before.status === 'cancelled') throw conflict('Cancelled orders cannot be edited.');
  // Production staff can update progress-related fields but not prices or customer.
  const isLimited = !can(req.user, 'orders', 'create') && req.user.role !== 'admin';
  const d = prepOrder(req.body);
  const { lines, ...head } = d;
  const existing = all('SELECT * FROM order_lines WHERE order_id = ?', before.id);
  tx(() => {
    if (isLimited) {
      update('orders', before.id, { due_date: head.due_date, assigned_to: head.assigned_to, priority: head.priority, specs: head.specs, notes: head.notes, updated_at: now() });
      return;
    }
    update('orders', before.id, { ...head, updated_at: now() });
    const keep = new Set();
    for (const l of lines) {
      const cur = l.id && existing.find((e) => e.id === l.id);
      if (cur) {
        const min = Math.max(cur.delivered_qty, cur.invoiced_qty);
        if (l.qty + 1e-9 < min) throw bad(`${l.description}: quantity can't go below ${min}, which has already been delivered or invoiced.`);
        if (cur.product_id !== l.product_id && (cur.delivered_qty || cur.invoiced_qty || cur.produced_qty)) throw bad(`${cur.description}: product can't change after production, delivery or invoicing has started.`);
        update('order_lines', cur.id, { product_id: l.product_id, description: l.description, specs: l.specs, qty: l.qty, unit_price: l.unit_price, unit_cost_est: l.unit_cost_est });
        keep.add(cur.id);
      } else {
        const { id: _x, ...rest } = l;
        keep.add(insert('order_lines', { ...rest, order_id: before.id }));
      }
    }
    for (const e of existing) {
      if (keep.has(e.id)) continue;
      const used = get(`SELECT (SELECT COUNT(*) FROM production_jobs WHERE order_line_id = ?) + (SELECT COUNT(*) FROM delivery_lines WHERE order_line_id = ?)
        + (SELECT COUNT(*) FROM invoice_lines WHERE order_line_id = ?) AS n`, e.id, e.id, e.id).n;
      if (used) throw bad(`${e.description} has production, delivery or invoice records, so it can't be removed.`);
      run('DELETE FROM order_lines WHERE id = ?', e.id);
    }
    recomputeOrderStatus(before.id);
  });
  log(req, 'updated', 'order', before.id, before.number, diff(before, head, ['due_date', 'priority', 'assigned_to', 'po_number', 'tax_rate', 'customer_id']));
  res.json({ ok: true });
}));
r.post('/orders/:id/hold', requirePerm('orders', 'edit'), h((req, res) => {
  const o = get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!o) throw notFound('Order');
  if (o.status === 'cancelled') throw conflict('Order is cancelled.');
  const hold = !!req.body.hold;
  update('orders', o.id, { hold_status: hold ? (String(req.body.reason || 'On hold').slice(0, 200)) : null, updated_at: now() });
  if (!hold) recomputeOrderStatus(o.id);
  log(req, hold ? 'put on hold' : 'resumed', 'order', o.id, o.number, hold ? { reason: req.body.reason || '' } : null);
  res.json({ ok: true });
}));
r.post('/orders/:id/cancel', requirePerm('orders', 'edit'), h((req, res) => {
  const o = get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!o) throw notFound('Order');
  const t = orderTotals(o.id);
  if (t.delivered > 0) throw conflict('Items have already been delivered on this order, so it cannot be cancelled.');
  if (get("SELECT COUNT(*) n FROM invoices WHERE order_id = ? AND status != 'void'", o.id).n) throw conflict('Void the invoices on this order before cancelling it.');
  tx(() => {
    run("UPDATE production_jobs SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND status = 'open'", now(), o.id);
    update('orders', o.id, { status: 'cancelled', hold_status: null, notes: [o.notes, req.body.reason ? `Cancelled: ${req.body.reason}` : null].filter(Boolean).join('\n'), updated_at: now() });
  });
  log(req, 'cancelled', 'order', o.id, o.number, { reason: req.body.reason || '' });
  res.json({ ok: true });
}));
r.delete('/orders/:id', requirePerm('orders', 'delete'), h((req, res) => {
  const o = get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!o) throw notFound('Order');
  const n = get(`SELECT (SELECT COUNT(*) FROM deliveries WHERE order_id = ?) + (SELECT COUNT(*) FROM invoices WHERE order_id = ?)
    + (SELECT COUNT(*) FROM payments WHERE order_id = ?) + (SELECT COUNT(*) FROM production_logs WHERE job_id IN (SELECT id FROM production_jobs WHERE order_id = ?)) AS n`,
  o.id, o.id, o.id, o.id).n;
  if (n) throw conflict('This order has production updates, deliveries, invoices or payments. Cancel it instead of deleting.');
  tx(() => {
    run('DELETE FROM production_jobs WHERE order_id = ?', o.id);
    run("UPDATE quotations SET order_id = NULL, status = 'approved' WHERE order_id = ?", o.id);
    run('DELETE FROM orders WHERE id = ?', o.id);
  });
  log(req, 'deleted', 'order', o.id, o.number);
  res.json({ ok: true });
}));

// ======================= PRODUCTION JOBS =======================
const JOB_LIST = `SELECT j.*, o.number AS order_number, o.priority, o.due_date AS order_due, c.company AS customer_name,
  p.code AS product_code, p.name AS product_name, u.name AS assigned_name
  FROM production_jobs j JOIN orders o ON o.id = j.order_id JOIN parties c ON c.id = o.customer_id
  LEFT JOIN products p ON p.id = j.product_id LEFT JOIN users u ON u.id = j.assigned_to`;
function stageKeys() { return (getSetting('productionStages', []) || []).map((s) => s.key); }
function jobProgress(j) {
  j.progress_pct = j.qty_target ? Math.min(100, Math.round((j.qty_passed / j.qty_target) * 100)) : 0;
  j.produced_pct = j.qty_target ? Math.min(100, Math.round((j.qty_produced / j.qty_target) * 100)) : 0;
  j.overdue = !!(j.due_date && j.due_date < today() && j.status === 'open');
  return j;
}
r.get('/jobs', requirePerm('production'), h((req, res) => {
  res.json(all(`${JOB_LIST} ORDER BY CASE j.status WHEN 'open' THEN 0 ELSE 1 END, COALESCE(j.due_date, '9999') , j.id DESC`).map(jobProgress));
}));
r.get('/jobs/:id', requirePerm('production'), h((req, res) => {
  const j = get(`${JOB_LIST} WHERE j.id = ?`, req.params.id);
  if (!j) throw notFound('Production job');
  jobProgress(j);
  j.line = get('SELECT * FROM order_lines WHERE id = ?', j.order_line_id);
  j.logs = all(`SELECT l.*, u.name AS user_name, m.code AS material_code, m.name AS material_name, m.unit AS material_unit
    FROM production_logs l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN materials m ON m.id = l.material_id WHERE l.job_id = ? ORDER BY l.id DESC`, j.id);
  j.consumption = all(`SELECT m.id, m.code, m.name, m.unit, SUM(l.material_qty) AS qty, ROUND(SUM(l.material_qty * m.unit_cost),2) AS value
    FROM production_logs l JOIN materials m ON m.id = l.material_id WHERE l.job_id = ? AND l.kind = 'consumption' GROUP BY m.id`, j.id);
  res.json(j);
}));
const jobSpec = {
  order_line_id: { type: 'int', required: true, label: 'Order item' },
  qty_target: { type: 'num', required: true, gt: 0, label: 'Target quantity' },
  assigned_to: { type: 'int', label: 'Assigned to' },
  machine: { type: 'text', maxLen: 80, label: 'Machine / line' },
  start_date: { type: 'date', label: 'Start date' },
  due_date: { type: 'date', label: 'Due date' },
  specs: { type: 'text', maxLen: 4000, label: 'Job specifications' },
  notes: { type: 'text', maxLen: 4000, label: 'Notes' },
};
function overrun() { return 1 + (Number((getSetting('defaults', {}) || {}).overrunPct) || 0) / 100; }
r.post('/jobs', requirePerm('production', 'create'), h((req, res) => {
  const d = validate(req.body, jobSpec);
  const line = get('SELECT l.*, o.status AS order_status, o.number AS order_number FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = ?', d.order_line_id);
  if (!line) throw bad('Order item not found', { order_line_id: 'Not found' });
  if (line.order_status === 'cancelled') throw conflict('The order is cancelled.');
  const planned = get("SELECT COALESCE(SUM(qty_target),0) s FROM production_jobs WHERE order_line_id = ? AND status != 'cancelled'", line.id).s;
  const cap = round4(line.qty * overrun() - planned);
  if (d.qty_target > cap + 1e-9) throw bad(`Only ${Math.max(cap, 0)} more can be planned for this item (ordered ${line.qty}, already planned ${planned}, overrun allowance included).`, { qty_target: `Max ${Math.max(cap, 0)}` });
  const id = tx(() => insert('production_jobs', {
    ...d, number: nextNumber('JOB'), order_id: line.order_id, product_id: line.product_id, title: line.description,
    stage: 'queued', status: 'open', created_at: now(), updated_at: now(),
  }));
  const j = get('SELECT id, number FROM production_jobs WHERE id = ?', id);
  log(req, 'created', 'job', id, `${j.number} for ${line.order_number}`, { qty: d.qty_target });
  res.status(201).json(j);
}));
r.put('/jobs/:id', requirePerm('production', 'edit'), h((req, res) => {
  const j = get('SELECT * FROM production_jobs WHERE id = ?', req.params.id);
  if (!j) throw notFound('Production job');
  const d = validate({ ...req.body, order_line_id: j.order_line_id }, jobSpec);
  if (d.qty_target + 1e-9 < j.qty_passed) throw bad(`Target can't be below the ${j.qty_passed} already passed QC.`, { qty_target: `Min ${j.qty_passed}` });
  if (d.assigned_to && !get('SELECT id FROM users WHERE id = ?', d.assigned_to)) throw bad('Staff member not found', { assigned_to: 'Not found' });
  const { order_line_id: _x, ...rest } = d;
  update('production_jobs', j.id, { ...rest, updated_at: now() });
  log(req, 'updated', 'job', j.id, j.number, diff(j, rest, ['qty_target', 'assigned_to', 'machine', 'due_date', 'start_date']));
  res.json({ ok: true });
}));
function openJob(id) {
  const j = get('SELECT j.*, o.number AS order_number, o.status AS order_status, o.hold_status FROM production_jobs j JOIN orders o ON o.id = j.order_id WHERE j.id = ?', id);
  if (!j) throw notFound('Production job');
  if (j.status !== 'open') throw conflict(`${j.number} is ${j.status}.`);
  if (j.order_status === 'cancelled') throw conflict(`${j.order_number} is cancelled.`);
  return j;
}
r.post('/jobs/:id/progress', requirePerm('production', 'edit'), h((req, res) => {
  const j = openJob(req.params.id);
  const d = validate(req.body, {
    stage: { type: 'text', label: 'Stage' }, qty_produced: { type: 'num', min: 0, label: 'Quantity produced' }, note: { type: 'text', maxLen: 1000, label: 'Note' },
  });
  if (d.stage && !stageKeys().includes(d.stage)) throw bad('Unknown production stage', { stage: 'Unknown' });
  if (!d.stage && !d.qty_produced && !d.note) throw bad('Enter a quantity, a stage or a note.');
  const add = d.qty_produced || 0;
  const maxTotal = round4(j.qty_target * overrun());
  if (j.qty_produced + add > maxTotal + 1e-9) throw bad(`That would make ${j.qty_produced + add} produced, above the target ${j.qty_target} plus overrun allowance (${maxTotal}).`, { qty_produced: `Max ${round4(maxTotal - j.qty_produced)}` });
  tx(() => {
    const upd = { updated_at: now() };
    if (add) upd.qty_produced = round4(j.qty_produced + add);
    if (d.stage) upd.stage = d.stage;
    if (!j.start_date && (add || (d.stage && d.stage !== 'queued'))) upd.start_date = today();
    if (d.stage === 'completed') upd.status = 'completed';
    update('production_jobs', j.id, upd);
    insert('production_logs', { job_id: j.id, ts: now(), user_id: req.user.id, kind: add ? 'progress' : (d.stage ? 'stage' : 'note'), stage: d.stage || j.stage, qty_produced: add || null, note: d.note });
    syncLineProduction(j.order_line_id);
    recomputeOrderStatus(j.order_id);
  });
  log(req, 'progress', 'job', j.id, j.number, { ...(add ? { produced: add } : {}), ...(d.stage && d.stage !== j.stage ? { stage: { from: j.stage, to: d.stage } } : {}), ...(d.note ? { note: d.note } : {}) });
  res.json({ ok: true });
}));
r.post('/jobs/:id/qc', requirePerm('production', 'edit'), h((req, res) => {
  const j = openJob(req.params.id);
  const d = validate(req.body, {
    qty_passed: { type: 'num', min: 0, default: 0, label: 'Passed' }, qty_rejected: { type: 'num', min: 0, default: 0, label: 'Rejected' },
    note: { type: 'text', maxLen: 1000, label: 'Note' },
  });
  const pending = round4(j.qty_produced - j.qty_passed - j.qty_rejected);
  if (!(d.qty_passed + d.qty_rejected > 0)) throw bad('Enter the passed and/or rejected quantity.', { qty_passed: 'Required' });
  if (d.qty_passed + d.qty_rejected > pending + 1e-9) throw bad(`Only ${pending} produced units are waiting for QC.`, { qty_passed: `Max ${pending}` });
  tx(() => {
    const passed = round4(j.qty_passed + d.qty_passed);
    const upd = { qty_passed: passed, qty_rejected: round4(j.qty_rejected + d.qty_rejected), updated_at: now() };
    if (passed + 1e-9 >= j.qty_target) { upd.stage = 'completed'; upd.status = 'completed'; } else if (j.stage !== 'qc') upd.stage = 'qc';
    update('production_jobs', j.id, upd);
    insert('production_logs', { job_id: j.id, ts: now(), user_id: req.user.id, kind: 'qc', stage: upd.stage || j.stage, qty_passed: d.qty_passed, qty_rejected: d.qty_rejected, note: d.note });
    if (d.qty_passed > 0 && j.product_id) {
      moveStock({ kind: 'product', id: j.product_id, qty: d.qty_passed, type: 'production', refType: 'job', refId: j.id, note: `QC passed · ${j.number}`, userId: req.user.id, isSample: j.is_sample });
    }
    syncLineProduction(j.order_line_id);
    recomputeOrderStatus(j.order_id);
  });
  log(req, 'quality check', 'job', j.id, j.number, { passed: d.qty_passed, rejected: d.qty_rejected });
  res.json({ ok: true });
}));
r.post('/jobs/:id/consume', requirePerm('production', 'edit'), requirePerm('inventory', 'create'), h((req, res) => {
  const j = get('SELECT * FROM production_jobs WHERE id = ?', req.params.id);
  if (!j) throw notFound('Production job');
  if (j.status === 'cancelled') throw conflict('Job is cancelled.');
  const d = validate(req.body, {
    material_id: { type: 'int', required: true, label: 'Material' }, qty: { type: 'num', required: true, gt: 0, label: 'Quantity used' },
    note: { type: 'text', maxLen: 500, label: 'Note' },
  });
  const m = get('SELECT * FROM materials WHERE id = ?', d.material_id);
  if (!m) throw bad('Material not found', { material_id: 'Not found' });
  tx(() => {
    moveStock({ kind: 'material', id: m.id, qty: -d.qty, type: 'consumption', refType: 'job', refId: j.id, note: d.note || `Used on ${j.number}`, userId: req.user.id, isSample: j.is_sample });
    insert('production_logs', { job_id: j.id, ts: now(), user_id: req.user.id, kind: 'consumption', stage: j.stage, material_id: m.id, material_qty: d.qty, note: d.note });
  });
  log(req, 'material used', 'job', j.id, j.number, { material: `${m.code} · ${m.name}`, qty: `${d.qty} ${m.unit}` });
  res.json({ ok: true });
}));
r.post('/jobs/:id/close', requirePerm('production', 'edit'), h((req, res) => {
  const j = get('SELECT * FROM production_jobs WHERE id = ?', req.params.id);
  if (!j) throw notFound('Production job');
  const action = req.body.action === 'cancel' ? 'cancel' : req.body.action === 'reopen' ? 'reopen' : 'complete';
  if (action === 'cancel' && j.qty_passed > 0) throw conflict(`${j.qty_passed} units already passed QC and went into stock. Mark the job complete instead.`);
  if (action === 'reopen' && j.status === 'open') throw conflict('Job is already open.');
  tx(() => {
    if (action === 'reopen') update('production_jobs', j.id, { status: 'open', stage: j.stage === 'completed' ? 'qc' : j.stage, updated_at: now() });
    else update('production_jobs', j.id, { status: action === 'cancel' ? 'cancelled' : 'completed', stage: action === 'cancel' ? j.stage : 'completed', updated_at: now() });
    insert('production_logs', { job_id: j.id, ts: now(), user_id: req.user.id, kind: 'stage', stage: action === 'complete' ? 'completed' : j.stage, note: `${action}${req.body.reason ? ': ' + req.body.reason : ''}` });
    syncLineProduction(j.order_line_id);
    recomputeOrderStatus(j.order_id);
  });
  log(req, action === 'cancel' ? 'cancelled' : action === 'reopen' ? 'reopened' : 'completed', 'job', j.id, j.number, req.body.reason ? { reason: req.body.reason } : null);
  res.json({ ok: true });
}));

module.exports = { router: r, specSummary, taxById };
