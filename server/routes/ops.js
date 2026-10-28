'use strict';
// Inventory movements & purchases, deliveries, invoices, payments.
const express = require('express');
const { all, get, run, insert, update, tx, now, today, round2, round4, nextNumber, getSetting } = require('../db');
const { requirePerm } = require('../auth');
const { validate, notFound, conflict, bad, log, h } = require('../util');
const {
  moveStock, recomputeInvoice, recomputePurchase, paymentUnallocated, outstanding, allocate, applyOrderDeposits, recomputeOrderStatus,
} = require('../logic');
const { taxById } = require('./sales');

const r = express.Router();

// ======================= INVENTORY =======================
r.get('/inventory/movements', requirePerm('inventory'), h((req, res) => {
  const where = [];
  const params = [];
  if (req.query.kind) { where.push('sm.item_kind = ?'); params.push(req.query.kind); }
  if (req.query.item_id) { where.push('sm.item_id = ?'); params.push(req.query.item_id); }
  if (req.query.from) { where.push('sm.date >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('sm.date <= ?'); params.push(req.query.to); }
  res.json(all(`SELECT sm.*, u.name AS user_name,
      CASE sm.item_kind WHEN 'material' THEN (SELECT code || ' · ' || name FROM materials WHERE id = sm.item_id)
        ELSE (SELECT code || ' · ' || name FROM products WHERE id = sm.item_id) END AS item_label,
      CASE sm.item_kind WHEN 'material' THEN (SELECT unit FROM materials WHERE id = sm.item_id) ELSE (SELECT unit FROM products WHERE id = sm.item_id) END AS unit,
      CASE sm.ref_type WHEN 'job' THEN (SELECT number FROM production_jobs WHERE id = sm.ref_id)
        WHEN 'purchase' THEN (SELECT number FROM purchases WHERE id = sm.ref_id)
        WHEN 'delivery' THEN (SELECT number FROM deliveries WHERE id = sm.ref_id) END AS ref_number
    FROM stock_movements sm LEFT JOIN users u ON u.id = sm.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sm.id DESC LIMIT 1000`, ...params));
}));
r.post('/inventory/adjust', requirePerm('inventory', 'edit'), h((req, res) => {
  const d = validate(req.body, {
    item_kind: { type: 'text', required: true, enum: ['material', 'product'], label: 'Item type' },
    item_id: { type: 'int', required: true, label: 'Item' },
    mode: { type: 'text', enum: ['delta', 'count'], default: 'delta', label: 'Mode' },
    qty: { type: 'num', required: true, label: 'Quantity' },
    reason: { type: 'text', required: true, maxLen: 300, label: 'Reason' },
    date: { type: 'date', label: 'Date' },
  });
  const table = d.item_kind === 'material' ? 'materials' : 'products';
  const item = get(`SELECT id, code, name, stock_qty, unit FROM ${table} WHERE id = ?`, d.item_id);
  if (!item) throw bad('Item not found', { item_id: 'Not found' });
  if (d.mode === 'count' && d.qty < 0) throw bad('Counted quantity cannot be negative', { qty: 'Must be 0 or more' });
  const delta = d.mode === 'count' ? round4(d.qty - item.stock_qty) : d.qty;
  if (!delta) throw bad('No change: the quantity matches current stock.', { qty: 'No change' });
  const bal = tx(() => moveStock({ kind: d.item_kind, id: item.id, qty: delta, type: 'adjustment', note: d.reason, userId: req.user.id, date: d.date }));
  log(req, 'stock adjusted', d.item_kind, item.id, `${item.code} · ${item.name}`, { change: delta, new_balance: bal, reason: d.reason });
  res.json({ ok: true, balance: bal });
}));

// ---- purchases (raw material receipts) ----
r.get('/purchases', requirePerm('inventory'), h((req, res) => {
  res.json(all(`SELECT p.*, s.company AS supplier_name, (SELECT COUNT(*) FROM purchase_lines WHERE purchase_id = p.id) AS line_count
    FROM purchases p JOIN parties s ON s.id = p.supplier_id ORDER BY p.date DESC, p.id DESC`));
}));
r.get('/purchases/:id', requirePerm('inventory'), h((req, res) => {
  const p = get('SELECT p.*, s.company AS supplier_name FROM purchases p JOIN parties s ON s.id = p.supplier_id WHERE p.id = ?', req.params.id);
  if (!p) throw notFound('Purchase');
  p.lines = all('SELECT l.*, m.code, m.name, m.unit FROM purchase_lines l JOIN materials m ON m.id = l.material_id WHERE purchase_id = ?', p.id);
  p.payments = all(`SELECT a.amount, y.number, y.date, y.method FROM payment_allocations a JOIN payments y ON y.id = a.payment_id
    WHERE a.target_type = 'purchase' AND a.target_id = ?`, p.id);
  res.json(p);
}));
r.post('/purchases', requirePerm('inventory', 'create'), h((req, res) => {
  const d = validate(req.body, {
    supplier_id: { type: 'int', required: true, label: 'Supplier' },
    date: { type: 'date', required: true, label: 'Date' },
    supplier_ref: { type: 'text', maxLen: 60, label: 'Supplier bill no.' },
    tax_id: { type: 'text', label: 'Tax' },
    notes: { type: 'text', maxLen: 2000, label: 'Notes' },
    lines: { type: 'json', required: true, label: 'Items' },
  });
  const sup = get('SELECT id, kind, company FROM parties WHERE id = ?', d.supplier_id);
  if (!sup) throw bad('Supplier not found', { supplier_id: 'Not found' });
  if (sup.kind === 'customer') throw bad(`${sup.company} is a customer. Change its type to "Supplier" or "Both" first.`, { supplier_id: 'Not a supplier' });
  if (!Array.isArray(d.lines) || !d.lines.length) throw bad('Add at least one material.', { lines: 'Required' });
  const lines = d.lines.map((l, i) => {
    const v = validate(l, { material_id: { type: 'int', required: true, label: `Item ${i + 1} material` }, qty: { type: 'num', required: true, gt: 0, label: `Item ${i + 1} quantity` }, unit_cost: { type: 'num', required: true, min: 0, label: `Item ${i + 1} rate` } });
    if (!get('SELECT id FROM materials WHERE id = ?', v.material_id)) throw bad(`Item ${i + 1}: material not found`);
    return { ...v, amount: round2(v.qty * v.unit_cost) };
  });
  const tax = taxById(d.tax_id);
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const taxAmt = round2(subtotal * tax.tax_rate / 100);
  const id = tx(() => {
    const pid = insert('purchases', {
      number: nextNumber('PUR', d.date), supplier_id: d.supplier_id, date: d.date, supplier_ref: d.supplier_ref, subtotal,
      tax_name: tax.tax_name, tax_rate: tax.tax_rate, tax_amount: taxAmt, total: round2(subtotal + taxAmt), status: 'unpaid', notes: d.notes, created_at: now(),
    });
    for (const l of lines) {
      insert('purchase_lines', { purchase_id: pid, ...l });
      moveStock({ kind: 'material', id: l.material_id, qty: l.qty, type: 'purchase', unitCost: l.unit_cost, refType: 'purchase', refId: pid, userId: req.user.id, date: d.date });
    }
    return pid;
  });
  const p = get('SELECT id, number, total FROM purchases WHERE id = ?', id);
  log(req, 'created', 'purchase', id, `${p.number} · ${sup.company}`, { total: p.total, items: lines.length });
  res.status(201).json(p);
}));
r.delete('/purchases/:id', requirePerm('inventory', 'delete'), h((req, res) => {
  const p = get('SELECT * FROM purchases WHERE id = ?', req.params.id);
  if (!p) throw notFound('Purchase');
  if (get("SELECT COUNT(*) n FROM payment_allocations WHERE target_type = 'purchase' AND target_id = ?", p.id).n) throw conflict('Payments are allocated to this purchase. Delete those payments first.');
  tx(() => {
    for (const l of all('SELECT * FROM purchase_lines WHERE purchase_id = ?', p.id)) {
      moveStock({ kind: 'material', id: l.material_id, qty: -l.qty, type: 'adjustment', refType: 'purchase', refId: p.id, note: `Reversed ${p.number}`, userId: req.user.id });
    }
    run('DELETE FROM purchases WHERE id = ?', p.id);
  });
  log(req, 'deleted', 'purchase', p.id, p.number, { total: p.total });
  res.json({ ok: true });
}));

// ======================= DELIVERIES =======================
r.get('/deliveries', requirePerm('deliveries'), h((req, res) => {
  res.json(all(`SELECT d.*, c.company AS customer_name, o.number AS order_number,
    (SELECT SUM(qty) FROM delivery_lines WHERE delivery_id = d.id) AS qty,
    (SELECT GROUP_CONCAT(p.name, ', ') FROM delivery_lines l JOIN products p ON p.id = l.product_id WHERE l.delivery_id = d.id) AS items,
    (SELECT number FROM invoices WHERE delivery_id = d.id AND status != 'void' LIMIT 1) AS invoice_number
    FROM deliveries d JOIN parties c ON c.id = d.customer_id JOIN orders o ON o.id = d.order_id ORDER BY d.date DESC, d.id DESC`));
}));
r.get('/deliveries/:id', requirePerm('deliveries'), h((req, res) => {
  const d = get(`SELECT d.*, c.company AS customer_name, c.phone AS customer_phone, c.contact_name AS customer_contact, o.number AS order_number, o.po_number
    FROM deliveries d JOIN parties c ON c.id = d.customer_id JOIN orders o ON o.id = d.order_id WHERE d.id = ?`, req.params.id);
  if (!d) throw notFound('Delivery');
  d.lines = all(`SELECT l.*, p.code AS product_code, p.name AS product_name, p.unit, ol.qty AS ordered_qty, ol.delivered_qty, ol.description, ol.specs
    FROM delivery_lines l JOIN products p ON p.id = l.product_id JOIN order_lines ol ON ol.id = l.order_line_id WHERE l.delivery_id = ?`, d.id);
  d.invoice = get("SELECT id, number FROM invoices WHERE delivery_id = ? AND status != 'void'", d.id) || null;
  d.activity = all("SELECT * FROM activity WHERE entity = 'delivery' AND entity_id = ? ORDER BY id DESC", d.id);
  res.json(d);
}));
r.post('/deliveries', requirePerm('deliveries', 'create'), h((req, res) => {
  const d = validate(req.body, {
    order_id: { type: 'int', required: true, label: 'Order' }, date: { type: 'date', required: true, label: 'Dispatch date' },
    vehicle: { type: 'text', maxLen: 60, label: 'Vehicle' }, driver: { type: 'text', maxLen: 80, label: 'Driver' },
    address: { type: 'text', maxLen: 400, label: 'Delivery address' }, notes: { type: 'text', maxLen: 2000, label: 'Notes' },
    lines: { type: 'json', required: true, label: 'Quantities' },
  });
  const o = get('SELECT o.*, c.address AS caddr FROM orders o JOIN parties c ON c.id = o.customer_id WHERE o.id = ?', d.order_id);
  if (!o) throw bad('Order not found', { order_id: 'Not found' });
  if (o.status === 'cancelled') throw conflict(`${o.number} is cancelled.`);
  if (o.hold_status) throw conflict(`${o.number} is on hold (${o.hold_status}). Resume it before dispatching.`);
  const lines = (d.lines || []).filter((l) => Number(l.qty) > 0);
  if (!lines.length) throw bad('Enter a dispatch quantity for at least one item.', { lines: 'Required' });
  const id = tx(() => {
    const did = insert('deliveries', {
      number: nextNumber('DN', d.date), order_id: o.id, customer_id: o.customer_id, date: d.date, status: 'dispatched',
      vehicle: d.vehicle, driver: d.driver, address: d.address || o.delivery_address || o.caddr, notes: d.notes, is_sample: o.is_sample, created_at: now(),
    });
    for (const l of lines) {
      const ol = get('SELECT l.*, p.code, p.stock_qty FROM order_lines l JOIN products p ON p.id = l.product_id WHERE l.id = ? AND l.order_id = ?', l.order_line_id, o.id);
      if (!ol) throw bad('An item does not belong to this order.');
      const qty = round4(Number(l.qty));
      const remaining = round4(ol.qty - ol.delivered_qty);
      if (qty > remaining + 1e-9) throw bad(`${ol.description}: only ${remaining} left to deliver.`);
      if (qty > ol.stock_qty + 1e-9) throw bad(`${ol.description}: only ${round4(ol.stock_qty)} in finished stock. Record QC-passed output or adjust stock first.`);
      insert('delivery_lines', { delivery_id: did, order_line_id: ol.id, product_id: ol.product_id, qty, packages: l.packages ? String(l.packages).slice(0, 80) : null });
      moveStock({ kind: 'product', id: ol.product_id, qty: -qty, type: 'delivery', refType: 'delivery', refId: did, note: `${o.number}`, userId: req.user.id, date: d.date, isSample: o.is_sample });
      update('order_lines', ol.id, { delivered_qty: round4(ol.delivered_qty + qty) });
    }
    recomputeOrderStatus(o.id);
    return did;
  });
  const dn = get('SELECT id, number FROM deliveries WHERE id = ?', id);
  log(req, 'dispatched', 'delivery', id, `${dn.number} for ${o.number}`, { qty: lines.reduce((s, l) => s + Number(l.qty), 0) });
  res.status(201).json(dn);
}));
r.post('/deliveries/:id/received', requirePerm('deliveries', 'edit'), h((req, res) => {
  const dv = get('SELECT * FROM deliveries WHERE id = ?', req.params.id);
  if (!dv) throw notFound('Delivery');
  const d = validate(req.body, { receiver_name: { type: 'text', maxLen: 120, label: 'Received by' }, received_date: { type: 'date', required: true, label: 'Received date' } });
  if (d.received_date < dv.date) throw bad('Received date cannot be before the dispatch date.', { received_date: 'Before dispatch' });
  update('deliveries', dv.id, { status: 'delivered', ...d });
  log(req, 'delivered', 'delivery', dv.id, dv.number, d);
  res.json({ ok: true });
}));
r.delete('/deliveries/:id', requirePerm('deliveries', 'delete'), h((req, res) => {
  const dv = get('SELECT * FROM deliveries WHERE id = ?', req.params.id);
  if (!dv) throw notFound('Delivery');
  if (get("SELECT COUNT(*) n FROM invoices WHERE delivery_id = ? AND status != 'void'", dv.id).n) throw conflict('This delivery has been invoiced. Void the invoice first.');
  tx(() => {
    for (const l of all('SELECT * FROM delivery_lines WHERE delivery_id = ?', dv.id)) {
      const ol = get('SELECT * FROM order_lines WHERE id = ?', l.order_line_id);
      update('order_lines', ol.id, { delivered_qty: round4(Math.max(ol.delivered_qty - l.qty, 0)) });
      moveStock({ kind: 'product', id: l.product_id, qty: l.qty, type: 'adjustment', refType: 'delivery', refId: dv.id, note: `Reversed ${dv.number}`, userId: req.user.id });
    }
    run('UPDATE invoices SET delivery_id = NULL WHERE delivery_id = ?', dv.id);
    run('DELETE FROM deliveries WHERE id = ?', dv.id);
    recomputeOrderStatus(dv.order_id);
  });
  log(req, 'cancelled', 'delivery', dv.id, dv.number, { note: 'Stock returned to finished goods' });
  res.json({ ok: true });
}));

// ======================= INVOICES =======================
const INV_LIST = `SELECT i.*, c.company AS customer_name, o.number AS order_number, d.number AS delivery_number,
  ROUND(i.total - i.paid_amount, 2) AS balance,
  (i.status IN ('unpaid','partial') AND i.due_date IS NOT NULL AND i.due_date < date('now','localtime')) AS overdue
  FROM invoices i JOIN parties c ON c.id = i.customer_id LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN deliveries d ON d.id = i.delivery_id`;
r.get('/invoices', requirePerm('invoices'), h((req, res) => {
  res.json(all(`${INV_LIST} ORDER BY i.date DESC, i.id DESC`));
}));
r.get('/invoices/:id', requirePerm('invoices'), h((req, res) => {
  const i = get(`${INV_LIST} WHERE i.id = ?`, req.params.id);
  if (!i) throw notFound('Invoice');
  i.customer = get('SELECT company, contact_name, address, city, phone, email, tax_id FROM parties WHERE id = ?', i.customer_id);
  i.lines = all('SELECT l.*, p.code AS product_code, p.unit FROM invoice_lines l LEFT JOIN products p ON p.id = l.product_id WHERE invoice_id = ? ORDER BY l.id', i.id);
  i.payments = all(`SELECT a.id AS allocation_id, a.amount, y.id AS payment_id, y.number, y.date, y.method, y.reference FROM payment_allocations a
    JOIN payments y ON y.id = a.payment_id WHERE a.target_type = 'invoice' AND a.target_id = ? ORDER BY y.date`, i.id);
  i.po_number = i.order_id ? get('SELECT po_number FROM orders WHERE id = ?', i.order_id).po_number : null;
  i.customer_credit = round2(get(`SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = p.id),0)),0) s
    FROM payments p WHERE p.party_id = ? AND p.direction = 'in'`, i.customer_id).s);
  i.activity = all("SELECT * FROM activity WHERE entity = 'invoice' AND entity_id = ? ORDER BY id DESC", i.id);
  res.json(i);
}));
// What can still be invoiced on an order (helps the form prefill without retyping).
r.get('/orders/:id/invoiceable', requirePerm('invoices'), h((req, res) => {
  const o = get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!o) throw notFound('Order');
  const lines = all(`SELECT l.id AS order_line_id, l.product_id, l.description, l.qty, l.unit_price, l.delivered_qty, l.invoiced_qty, p.code AS product_code, p.unit
    FROM order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = ?`, o.id).map((l) => ({
    ...l, remaining: round4(l.qty - l.invoiced_qty), suggested: round4(Math.max(l.delivered_qty - l.invoiced_qty, 0)),
  }));
  const deliveries = all(`SELECT d.id, d.number, d.date FROM deliveries d WHERE d.order_id = ? AND NOT EXISTS
    (SELECT 1 FROM invoices i WHERE i.delivery_id = d.id AND i.status != 'void') ORDER BY d.date`, o.id).map((dv) => ({
    ...dv, lines: all('SELECT order_line_id, qty FROM delivery_lines WHERE delivery_id = ?', dv.id),
  }));
  res.json({ order: { id: o.id, number: o.number, customer_id: o.customer_id, tax_id: o.tax_id, tax_rate: o.tax_rate }, lines, deliveries });
}));
r.post('/invoices', requirePerm('invoices', 'create'), h((req, res) => {
  const d = validate(req.body, {
    customer_id: { type: 'int', required: true, label: 'Customer' }, order_id: { type: 'int', label: 'Order' },
    delivery_id: { type: 'int', label: 'Delivery' }, date: { type: 'date', required: true, label: 'Invoice date' },
    due_date: { type: 'date', label: 'Due date' }, discount: { type: 'num', min: 0, default: 0, label: 'Discount' },
    tax_id: { type: 'text', label: 'Tax' }, notes: { type: 'text', maxLen: 2000, label: 'Notes' },
    lines: { type: 'json', required: true, label: 'Items' }, apply_deposits: { type: 'bool', default: 1 },
  });
  const cust = get('SELECT id, kind, company FROM parties WHERE id = ?', d.customer_id);
  if (!cust || cust.kind === 'supplier') throw bad('Select a valid customer.', { customer_id: 'Not a customer' });
  if (d.due_date && d.due_date < d.date) throw bad('Due date must be on or after the invoice date.', { due_date: 'Before invoice date' });
  let order = null;
  if (d.order_id) {
    order = get('SELECT * FROM orders WHERE id = ?', d.order_id);
    if (!order) throw bad('Order not found', { order_id: 'Not found' });
    if (order.customer_id !== d.customer_id) throw bad('That order belongs to a different customer.', { order_id: 'Customer mismatch' });
    if (order.status === 'cancelled') throw conflict(`${order.number} is cancelled.`);
  }
  if (d.delivery_id) {
    const dv = get('SELECT * FROM deliveries WHERE id = ?', d.delivery_id);
    if (!dv || dv.order_id !== d.order_id) throw bad('Delivery does not belong to this order.', { delivery_id: 'Mismatch' });
    if (get("SELECT COUNT(*) n FROM invoices WHERE delivery_id = ? AND status != 'void'", dv.id).n) throw conflict(`${dv.number} has already been invoiced.`);
  }
  const lines = (d.lines || []).filter((l) => Number(l.qty) > 0).map((l, i) => {
    const v = validate(l, {
      order_line_id: { type: 'int' }, product_id: { type: 'int' }, description: { type: 'text', required: true, maxLen: 300, label: `Item ${i + 1} description` },
      qty: { type: 'num', required: true, gt: 0, label: `Item ${i + 1} quantity` }, unit_price: { type: 'num', required: true, min: 0, label: `Item ${i + 1} price` },
    });
    if (v.order_line_id) {
      const ol = get('SELECT * FROM order_lines WHERE id = ? AND order_id = ?', v.order_line_id, d.order_id || -1);
      if (!ol) throw bad(`Item ${i + 1} is not on the selected order.`);
      const rem = round4(ol.qty - ol.invoiced_qty);
      if (v.qty > rem + 1e-9) throw bad(`${ol.description}: only ${rem} left to invoice.`);
      v.product_id = ol.product_id;
    }
    return { ...v, amount: round2(v.qty * v.unit_price) };
  });
  if (!lines.length) throw bad('Add at least one item with a quantity.', { lines: 'Required' });
  const tax = taxById(d.tax_id);
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  if (d.discount > subtotal) throw bad('Discount cannot exceed the subtotal.', { discount: 'Too high' });
  const taxable = round2(subtotal - d.discount);
  const taxAmt = round2(taxable * tax.tax_rate / 100);
  const due = d.due_date || new Date(Date.parse(d.date) + ((getSetting('defaults', {}).invoiceDueDays ?? 30) * 864e5)).toISOString().slice(0, 10);
  let applied = 0;
  const id = tx(() => {
    const iid = insert('invoices', {
      number: nextNumber('INV', d.date), customer_id: d.customer_id, order_id: d.order_id, delivery_id: d.delivery_id, date: d.date, due_date: due,
      status: 'unpaid', subtotal, discount: round2(d.discount), ...tax, tax_amount: taxAmt, total: round2(taxable + taxAmt), paid_amount: 0,
      notes: d.notes, is_sample: order ? order.is_sample : 0, created_at: now(),
    });
    for (const l of lines) {
      insert('invoice_lines', { invoice_id: iid, ...l });
      if (l.order_line_id) run('UPDATE order_lines SET invoiced_qty = ROUND(invoiced_qty + ?, 4) WHERE id = ?', l.qty, l.order_line_id);
    }
    if (d.apply_deposits) applied = applyOrderDeposits(iid);
    return iid;
  });
  const inv = get('SELECT id, number, total FROM invoices WHERE id = ?', id);
  log(req, 'created', 'invoice', id, `${inv.number} · ${cust.company}`, { total: inv.total, ...(applied ? { deposits_applied: applied } : {}) });
  res.status(201).json({ ...inv, deposits_applied: applied });
}));
r.post('/invoices/:id/void', requirePerm('invoices', 'delete'), h((req, res) => {
  const i = get('SELECT * FROM invoices WHERE id = ?', req.params.id);
  if (!i) throw notFound('Invoice');
  if (i.status === 'void') throw conflict('Invoice is already void.');
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw bad('Give a reason for voiding.', { reason: 'Required' });
  tx(() => {
    for (const l of all('SELECT * FROM invoice_lines WHERE invoice_id = ? AND order_line_id IS NOT NULL', i.id)) {
      run('UPDATE order_lines SET invoiced_qty = MAX(ROUND(invoiced_qty - ?, 4), 0) WHERE id = ?', l.qty, l.order_line_id);
    }
    run("DELETE FROM payment_allocations WHERE target_type = 'invoice' AND target_id = ?", i.id);
    update('invoices', i.id, { status: 'void', paid_amount: 0, void_reason: reason.slice(0, 300) });
  });
  log(req, 'voided', 'invoice', i.id, i.number, { reason, total: i.total, note: 'Payments released as customer credit' });
  res.json({ ok: true });
}));

// ======================= PAYMENTS =======================
const PAY_LIST = `SELECT y.*, p.company AS party_name, o.number AS order_number, u.name AS user_name,
  ROUND(y.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = y.id),0), 2) AS unallocated,
  (SELECT GROUP_CONCAT(COALESCE(i.number, pu.number), ', ') FROM payment_allocations a LEFT JOIN invoices i ON a.target_type = 'invoice' AND i.id = a.target_id
     LEFT JOIN purchases pu ON a.target_type = 'purchase' AND pu.id = a.target_id WHERE a.payment_id = y.id) AS applied_to
  FROM payments y JOIN parties p ON p.id = y.party_id LEFT JOIN orders o ON o.id = y.order_id LEFT JOIN users u ON u.id = y.user_id`;
r.get('/payments', requirePerm('payments'), h((req, res) => {
  res.json(all(`${PAY_LIST} ORDER BY y.date DESC, y.id DESC`));
}));
r.get('/payments/:id', requirePerm('payments'), h((req, res) => {
  const y = get(`${PAY_LIST} WHERE y.id = ?`, req.params.id);
  if (!y) throw notFound('Payment');
  y.allocations = all(`SELECT a.*, COALESCE(i.number, pu.number) AS number FROM payment_allocations a LEFT JOIN invoices i ON a.target_type = 'invoice' AND i.id = a.target_id
    LEFT JOIN purchases pu ON a.target_type = 'purchase' AND pu.id = a.target_id WHERE a.payment_id = ?`, y.id);
  res.json(y);
}));
// Open documents for a party, to allocate against.
r.get('/parties/:id/open-items', requirePerm('payments'), h((req, res) => {
  const id = req.params.id;
  res.json({
    invoices: all(`SELECT id, number, date, due_date, total, paid_amount, ROUND(total - paid_amount,2) AS balance, order_id FROM invoices
      WHERE customer_id = ? AND status IN ('unpaid','partial') ORDER BY date, id`, id),
    purchases: all(`SELECT id, number, date, total, paid_amount, ROUND(total - paid_amount,2) AS balance FROM purchases
      WHERE supplier_id = ? AND status IN ('unpaid','partial') ORDER BY date, id`, id),
    orders: all(`SELECT id, number, order_date, status FROM orders WHERE customer_id = ? AND status NOT IN ('cancelled') ORDER BY order_date DESC LIMIT 50`, id),
    credits: all(`SELECT id, number, date, amount, ROUND(amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = payments.id),0),2) AS unallocated
      FROM payments WHERE party_id = ? AND direction = 'in' AND amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = payments.id),0) > 0.005`, id),
  });
}));
r.post('/payments', requirePerm('payments', 'create'), h((req, res) => {
  const d = validate(req.body, {
    party_id: { type: 'int', required: true, label: 'Customer / supplier' }, direction: { type: 'text', enum: ['in', 'out'], default: 'in', label: 'Direction' },
    date: { type: 'date', required: true, label: 'Date' }, amount: { type: 'num', required: true, gt: 0, label: 'Amount' },
    method: { type: 'text', required: true, maxLen: 40, label: 'Method' }, reference: { type: 'text', maxLen: 80, label: 'Reference' },
    order_id: { type: 'int', label: 'Order (deposit)' }, notes: { type: 'text', maxLen: 1000, label: 'Notes' },
    allocations: { type: 'json', jsonDefault: [], label: 'Allocations' },
  });
  const party = get('SELECT * FROM parties WHERE id = ?', d.party_id);
  if (!party) throw bad('Customer / supplier not found', { party_id: 'Not found' });
  if (d.direction === 'in' && party.kind === 'supplier') throw bad(`${party.company} is a supplier. Use "Payment made" for suppliers.`, { party_id: 'Supplier' });
  if (d.direction === 'out' && party.kind === 'customer') throw bad(`${party.company} is a customer. Use "Payment received".`, { party_id: 'Customer' });
  if (d.order_id) {
    const o = get('SELECT customer_id FROM orders WHERE id = ?', d.order_id);
    if (!o || o.customer_id !== d.party_id) throw bad('That order belongs to a different customer.', { order_id: 'Mismatch' });
  }
  const allocs = (Array.isArray(d.allocations) ? d.allocations : []).filter((a) => Number(a.amount) > 0);
  const sum = round2(allocs.reduce((s, a) => s + Number(a.amount), 0));
  if (sum > round2(d.amount) + 0.005) throw bad(`Allocations (${sum}) are more than the payment amount (${round2(d.amount)}).`, { amount: 'Less than allocations' });
  const id = tx(() => {
    const pid = insert('payments', {
      number: nextNumber(d.direction === 'in' ? 'RCV' : 'PMT', d.date), party_id: d.party_id, direction: d.direction, date: d.date, amount: round2(d.amount),
      method: d.method, reference: d.reference, order_id: d.direction === 'in' ? d.order_id : null, notes: d.notes, user_id: req.user.id, created_at: now(),
    });
    allocate(pid, allocs);
    return pid;
  });
  const y = get('SELECT id, number, amount FROM payments WHERE id = ?', id);
  log(req, 'recorded', 'payment', id, `${y.number} · ${party.company}`, { amount: y.amount, direction: d.direction, allocated: sum, unallocated: round2(d.amount - sum) });
  res.status(201).json({ ...y, unallocated: paymentUnallocated(id) });
}));
r.post('/payments/:id/allocate', requirePerm('payments', 'edit'), h((req, res) => {
  const y = get('SELECT * FROM payments WHERE id = ?', req.params.id);
  if (!y) throw notFound('Payment');
  const allocs = (Array.isArray(req.body.allocations) ? req.body.allocations : []).filter((a) => Number(a.amount) > 0);
  if (!allocs.length) throw bad('Enter an amount to apply.');
  tx(() => allocate(y.id, allocs));
  log(req, 'allocated', 'payment', y.id, y.number, { amounts: allocs.map((a) => a.amount) });
  res.json({ ok: true, unallocated: paymentUnallocated(y.id) });
}));
r.delete('/payments/:id', requirePerm('payments', 'delete'), h((req, res) => {
  const y = get('SELECT * FROM payments WHERE id = ?', req.params.id);
  if (!y) throw notFound('Payment');
  const targets = all('SELECT target_type, target_id FROM payment_allocations WHERE payment_id = ?', y.id);
  tx(() => {
    run('DELETE FROM payments WHERE id = ?', y.id);
    for (const t of targets) { if (t.target_type === 'invoice') recomputeInvoice(t.target_id); else recomputePurchase(t.target_id); }
  });
  log(req, 'deleted', 'payment', y.id, y.number, { amount: y.amount });
  res.json({ ok: true });
}));

module.exports = r;
module.exports.outstanding = outstanding;
