'use strict';
// Business rules shared by several routes: stock moves, balances, order status, quotation costing.
const { get, all, run, insert, update, now, today, round2, round4 } = require('./db');
const { bad } = require('./util');

// ---------- quotation costing ----------
// costing = { materials:[{material_id, description, qty, per, unit, rate}],
//             lines:[{group:'printing'|'finishing'|'labor'|'other', name, setup, per_unit}],
//             wastage_pct, profit_pct }
function quoteCalc(costing, qty) {
  const c = costing || {};
  const Q = Math.max(Number(qty) || 0, 0);
  const w = (Number(c.wastage_pct) || 0) / 100;
  const p = (Number(c.profit_pct) || 0) / 100;
  const matPerUnit = (c.materials || []).reduce((s, m) => {
    const per = Number(m.per) > 0 ? Number(m.per) : 1;
    return s + ((Number(m.qty) || 0) / per) * (Number(m.rate) || 0);
  }, 0);
  const groups = { materials: matPerUnit * Q * (1 + w), printing: 0, finishing: 0, labor: 0, other: 0 };
  for (const l of c.lines || []) {
    const g = groups[l.group] !== undefined && l.group !== 'materials' ? l.group : 'other';
    const run = (Number(l.per_unit) || 0) * Q * (g === 'printing' ? 1 + w : 1);
    groups[g] += (Number(l.setup) || 0) + run;
  }
  const cost = Object.values(groups).reduce((a, b) => a + b, 0);
  const profit = cost * p;
  const price = cost + profit;
  return {
    qty: Q,
    groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, round2(v)])),
    cost: round2(cost), profit: round2(profit), price: round2(price),
    unit_cost: Q ? round4(cost / Q) : 0, unit_price: Q ? round4(price / Q) : 0,
  };
}

function buildTiers(costing, tiers) {
  return (tiers || [])
    .filter((t) => Number(t.qty) > 0)
    .map((t) => {
      const calc = quoteCalc(costing, t.qty);
      const override = t.override && Number(t.unit_price) > 0;
      const unit_price = override ? round4(t.unit_price) : round2(calc.unit_price);
      return {
        qty: Number(t.qty), unit_cost: calc.unit_cost, calc_unit_price: round2(calc.unit_price), unit_price,
        override: !!override, total: round2(unit_price * Number(t.qty)), cost_total: calc.cost,
        margin_pct: unit_price > 0 ? round2(((unit_price - calc.unit_cost) / unit_price) * 100) : 0,
      };
    })
    .sort((a, b) => a.qty - b.qty);
}

// ---------- stock ----------
function moveStock({ kind, id, qty, type, unitCost, refType, refId, note, userId, date, isSample = 0, allowNegative = false }) {
  const table = kind === 'material' ? 'materials' : 'products';
  const item = get(`SELECT id, code, name, stock_qty, ${kind === 'material' ? 'unit_cost' : 'cost_price AS unit_cost'} FROM ${table} WHERE id = ?`, id);
  if (!item) throw bad(`${kind === 'material' ? 'Material' : 'Product'} not found`);
  const newQty = round4(item.stock_qty + qty);
  if (newQty < -1e-9 && !allowNegative) {
    throw bad(`Not enough stock for ${item.code} · ${item.name}. Available ${round4(item.stock_qty)}, requested ${round4(-qty)}.`);
  }
  // Weighted average cost on receipts of raw materials.
  if (kind === 'material' && qty > 0 && unitCost != null && type === 'purchase') {
    const base = Math.max(item.stock_qty, 0);
    const avg = base + qty > 0 ? (base * item.unit_cost + qty * unitCost) / (base + qty) : unitCost;
    run('UPDATE materials SET unit_cost = ?, stock_qty = ?, updated_at = ? WHERE id = ?', round4(avg), newQty, now(), id);
  } else {
    run(`UPDATE ${table} SET stock_qty = ?, updated_at = ? WHERE id = ?`, newQty, now(), id);
  }
  insert('stock_movements', {
    ts: now(), date: date || today(), item_kind: kind, item_id: id, qty: round4(qty), balance_after: newQty, type,
    unit_cost: unitCost ?? item.unit_cost ?? null, ref_type: refType || null, ref_id: refId || null,
    note: note || null, user_id: userId || null, is_sample: isSample ? 1 : 0,
  });
  return newQty;
}

// ---------- invoices / purchases / payments ----------
function allocatedTo(type, id) {
  return round2(get('SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE target_type = ? AND target_id = ?', type, id).s);
}
function recomputeInvoice(id) {
  const inv = get('SELECT id, total, status, due_date FROM invoices WHERE id = ?', id);
  if (!inv) return;
  const paid = allocatedTo('invoice', id);
  let status = inv.status;
  if (status !== 'void') status = paid >= inv.total - 0.005 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  run('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?', paid, status, id);
}
function recomputePurchase(id) {
  const p = get('SELECT id, total FROM purchases WHERE id = ?', id);
  if (!p) return;
  const paid = allocatedTo('purchase', id);
  const status = paid >= p.total - 0.005 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  run('UPDATE purchases SET paid_amount = ?, status = ? WHERE id = ?', paid, status, id);
}
function paymentUnallocated(paymentId) {
  const p = get('SELECT amount FROM payments WHERE id = ?', paymentId);
  if (!p) return 0;
  const used = get('SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE payment_id = ?', paymentId).s;
  return round2(p.amount - used);
}
function outstanding(type, id) {
  if (type === 'invoice') {
    const inv = get('SELECT total, status FROM invoices WHERE id = ?', id);
    if (!inv || inv.status === 'void') return 0;
    return round2(inv.total - allocatedTo('invoice', id));
  }
  const p = get('SELECT total FROM purchases WHERE id = ?', id);
  return p ? round2(p.total - allocatedTo('purchase', id)) : 0;
}
function allocate(paymentId, allocations) {
  const pay = get('SELECT * FROM payments WHERE id = ?', paymentId);
  let free = paymentUnallocated(paymentId);
  for (const a of allocations || []) {
    const amount = round2(a.amount);
    if (!(amount > 0)) continue;
    const type = pay.direction === 'in' ? 'invoice' : 'purchase';
    const target = type === 'invoice'
      ? get('SELECT id, number, customer_id AS party_id, status FROM invoices WHERE id = ?', a.target_id)
      : get('SELECT id, number, supplier_id AS party_id FROM purchases WHERE id = ?', a.target_id);
    if (!target) throw bad(`${type === 'invoice' ? 'Invoice' : 'Purchase'} not found for allocation`);
    if (target.party_id !== pay.party_id) throw bad(`${target.number} belongs to a different ${type === 'invoice' ? 'customer' : 'supplier'}`);
    if (target.status === 'void') throw bad(`${target.number} is void`);
    const due = outstanding(type, target.id);
    if (amount > due + 0.005) throw bad(`Allocation to ${target.number} (${amount}) is more than its outstanding balance (${due}).`);
    if (amount > free + 0.005) throw bad(`Allocations exceed the payment amount. Unallocated: ${free}.`);
    insert('payment_allocations', { payment_id: paymentId, target_type: type, target_id: target.id, amount });
    free = round2(free - amount);
    if (type === 'invoice') recomputeInvoice(target.id); else recomputePurchase(target.id);
  }
}
// Apply any unallocated deposits recorded against an order to a new invoice for that order.
function applyOrderDeposits(invoiceId) {
  const inv = get('SELECT id, order_id, customer_id FROM invoices WHERE id = ?', invoiceId);
  if (!inv || !inv.order_id) return 0;
  let applied = 0;
  const pays = all("SELECT id FROM payments WHERE order_id = ? AND direction = 'in' AND party_id = ? ORDER BY date, id", inv.order_id, inv.customer_id);
  for (const p of pays) {
    const free = paymentUnallocated(p.id);
    const due = outstanding('invoice', invoiceId);
    if (free <= 0 || due <= 0) continue;
    const amt = round2(Math.min(free, due));
    insert('payment_allocations', { payment_id: p.id, target_type: 'invoice', target_id: invoiceId, amount: amt });
    applied += amt;
  }
  recomputeInvoice(invoiceId);
  return round2(applied);
}

function partyBalances(id) {
  const party = get('SELECT id, kind, opening_balance FROM parties WHERE id = ?', id);
  if (!party) return null;
  const invoiced = get("SELECT COALESCE(SUM(total),0) s FROM invoices WHERE customer_id = ? AND status != 'void'", id).s;
  const received = get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE party_id = ? AND direction = 'in'", id).s;
  const purchased = get('SELECT COALESCE(SUM(total),0) s FROM purchases WHERE supplier_id = ?', id).s;
  const paidOut = get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE party_id = ? AND direction = 'out'", id).s;
  const isSupplierOnly = party.kind === 'supplier';
  const receivable = round2((isSupplierOnly ? 0 : party.opening_balance) + invoiced - received);
  const payable = round2((isSupplierOnly ? party.opening_balance : 0) + purchased - paidOut);
  return { invoiced: round2(invoiced), received: round2(received), receivable, purchased: round2(purchased), paid_out: round2(paidOut), payable };
}

// ---------- orders ----------
function orderTotals(orderId) {
  const o = get('SELECT tax_rate FROM orders WHERE id = ?', orderId);
  const lines = all('SELECT qty, unit_price, unit_cost_est, delivered_qty, invoiced_qty, passed_qty, produced_qty FROM order_lines WHERE order_id = ?', orderId);
  const subtotal = round2(lines.reduce((s, l) => s + l.qty * l.unit_price, 0));
  const tax = round2(subtotal * ((o ? o.tax_rate : 0) / 100));
  const qty = lines.reduce((s, l) => s + l.qty, 0);
  const delivered = lines.reduce((s, l) => s + Math.min(l.delivered_qty, l.qty), 0);
  const passed = lines.reduce((s, l) => s + Math.min(l.passed_qty, l.qty), 0);
  const invoicedAmt = get("SELECT COALESCE(SUM(total),0) s FROM invoices WHERE order_id = ? AND status != 'void'", orderId).s;
  const deposits = get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id = ? AND direction = 'in'", orderId).s;
  const paidOnInvoices = get(`SELECT COALESCE(SUM(a.amount),0) s FROM payment_allocations a JOIN invoices i ON i.id = a.target_id
    WHERE a.target_type = 'invoice' AND i.order_id = ? AND i.status != 'void'`, orderId).s;
  const unappliedDeposits = get(`SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = p.id),0)),0) s
    FROM payments p WHERE p.order_id = ? AND p.direction = 'in'`, orderId).s;
  return {
    subtotal, tax, total: round2(subtotal + tax), qty, delivered, passed,
    progress_pct: qty ? Math.round((delivered / qty) * 100) : 0,
    production_pct: qty ? Math.round((passed / qty) * 100) : 0,
    invoiced: round2(invoicedAmt), deposits: round2(deposits),
    received: round2(paidOnInvoices + unappliedDeposits),
  };
}

function recomputeOrderStatus(orderId) {
  const o = get('SELECT id, status, hold_status FROM orders WHERE id = ?', orderId);
  if (!o || o.status === 'cancelled' || o.hold_status) return o && o.status;
  const lines = all('SELECT qty, produced_qty, passed_qty, delivered_qty FROM order_lines WHERE order_id = ?', orderId);
  const jobs = all("SELECT stage, status FROM production_jobs WHERE order_id = ? AND status != 'cancelled'", orderId);
  const qty = lines.reduce((s, l) => s + l.qty, 0);
  const delivered = lines.reduce((s, l) => s + Math.min(l.delivered_qty, l.qty), 0);
  const allPassed = lines.length > 0 && lines.every((l) => l.passed_qty + 1e-9 >= l.qty || l.delivered_qty + 1e-9 >= l.qty);
  const anyProduced = lines.some((l) => l.produced_qty > 0) || jobs.some((j) => j.stage !== 'queued');
  const pendingQc = jobs.some((j) => j.stage === 'qc') || lines.some((l) => l.produced_qty > l.passed_qty + 1e-9);
  let status = 'confirmed';
  if (qty > 0 && delivered + 1e-9 >= qty) status = 'delivered';
  else if (delivered > 0) status = 'partially_delivered';
  else if (allPassed) status = 'ready';
  else if (pendingQc) status = 'quality_check';
  else if (anyProduced) status = 'in_production';
  if (status !== o.status) run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, now(), orderId);
  return status;
}

function syncLineProduction(lineId) {
  const s = get(`SELECT COALESCE(SUM(qty_produced),0) p, COALESCE(SUM(qty_passed),0) q FROM production_jobs
    WHERE order_line_id = ? AND status != 'cancelled'`, lineId);
  update('order_lines', lineId, { produced_qty: round4(s.p), passed_qty: round4(s.q) });
}

module.exports = {
  quoteCalc, buildTiers, moveStock, recomputeInvoice, recomputePurchase, paymentUnallocated, outstanding, allocate,
  applyOrderDeposits, partyBalances, orderTotals, recomputeOrderStatus, syncLineProduction, allocatedTo,
};
