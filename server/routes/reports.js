'use strict';
// Dashboard metrics, business reports and spreadsheet / PDF exports.
const express = require('express');
const { all, get, today, round2, getSetting } = require('../db');
const { requirePerm, can } = require('../auth');
const { bad, h } = require('../util');

const r = express.Router();

function range(req) {
  const t = today();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : `${t.slice(0, 7)}-01`;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : t;
  if (from > to) throw bad('The start date must be before the end date.');
  return { from, to };
}
function addDays(d, n) { return new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10); }
function bucketOf(from, to) {
  const days = (Date.parse(to) - Date.parse(from)) / 864e5;
  return days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
}
function bucketExpr(col, b) {
  if (b === 'day') return col;
  if (b === 'month') return `substr(${col},1,7)`;
  return `date(${col}, 'weekday 1', '-7 days')`; // Monday of the week
}
function buckets(from, to, b) {
  const out = [];
  if (b === 'month') {
    let [y, m] = from.slice(0, 7).split('-').map(Number);
    const end = to.slice(0, 7);
    for (;;) { const k = `${y}-${String(m).padStart(2, '0')}`; out.push(k); if (k >= end) break; m++; if (m > 12) { m = 1; y++; } }
    return out;
  }
  let d = b === 'week' ? get("SELECT date(?, 'weekday 1', '-7 days') AS d", from).d : from;
  while (d <= to) { out.push(d); d = addDays(d, b === 'week' ? 7 : 1); }
  return out;
}

// ======================= DASHBOARD =======================
r.get('/dashboard', requirePerm('dashboard'), h((req, res) => {
  const { from, to } = range(req);
  const t = today();
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const pFrom = addDays(from, -span), pTo = addDays(from, -1);
  const finance = can(req.user, 'invoices') || can(req.user, 'payments');
  const sum = (sql, ...p) => round2(get(sql, ...p).s || 0);

  const out = { from, to, finance };
  if (finance) {
    out.sales = sum("SELECT SUM(total) s FROM invoices WHERE status != 'void' AND date BETWEEN ? AND ?", from, to);
    out.sales_prev = sum("SELECT SUM(total) s FROM invoices WHERE status != 'void' AND date BETWEEN ? AND ?", pFrom, pTo);
    out.received = sum("SELECT SUM(amount) s FROM payments WHERE direction = 'in' AND date BETWEEN ? AND ?", from, to);
    out.received_prev = sum("SELECT SUM(amount) s FROM payments WHERE direction = 'in' AND date BETWEEN ? AND ?", pFrom, pTo);
    out.expenses = sum('SELECT SUM(amount) s FROM expenses WHERE date BETWEEN ? AND ?', from, to);
    out.outstanding = sum("SELECT SUM(total - paid_amount) s FROM invoices WHERE status IN ('unpaid','partial')");
    out.overdue_amount = sum("SELECT SUM(total - paid_amount) s FROM invoices WHERE status IN ('unpaid','partial') AND due_date < ?", t);
    out.overdue_invoices = get("SELECT COUNT(*) n FROM invoices WHERE status IN ('unpaid','partial') AND due_date < ?", t).n;
    out.payable = sum("SELECT SUM(total - paid_amount) s FROM purchases WHERE status IN ('unpaid','partial')");
    const aging = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
    for (const i of all("SELECT due_date, total - paid_amount AS bal FROM invoices WHERE status IN ('unpaid','partial')")) {
      const late = i.due_date ? Math.floor((Date.parse(t) - Date.parse(i.due_date)) / 864e5) : 0;
      const k = late <= 0 ? 'current' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'd90p';
      aging[k] = round2(aging[k] + i.bal);
    }
    out.aging = aging;
    const b = bucketOf(from, to);
    const inv = Object.fromEntries(all(`SELECT ${bucketExpr('date', b)} k, SUM(total) s FROM invoices WHERE status != 'void' AND date BETWEEN ? AND ? GROUP BY k`, from, to).map((x) => [x.k, x.s]));
    const rec = Object.fromEntries(all(`SELECT ${bucketExpr('date', b)} k, SUM(amount) s FROM payments WHERE direction = 'in' AND date BETWEEN ? AND ? GROUP BY k`, from, to).map((x) => [x.k, x.s]));
    const exp = Object.fromEntries(all(`SELECT ${bucketExpr('date', b)} k, SUM(amount) s FROM expenses WHERE date BETWEEN ? AND ? GROUP BY k`, from, to).map((x) => [x.k, x.s]));
    out.bucket = b;
    out.series = buckets(from, to, b).map((k) => ({ k, invoiced: round2(inv[k] || 0), received: round2(rec[k] || 0), expenses: round2(exp[k] || 0) }));
    out.top_customers = all(`SELECT c.id, c.company, ROUND(SUM(i.total),2) total, COUNT(*) n FROM invoices i JOIN parties c ON c.id = i.customer_id
      WHERE i.status != 'void' AND i.date BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC LIMIT 5`, from, to);
  }
  out.orders_active = get("SELECT COUNT(*) n FROM orders WHERE status NOT IN ('delivered','cancelled')").n;
  out.orders_overdue = get("SELECT COUNT(*) n FROM orders WHERE status NOT IN ('delivered','cancelled') AND due_date < ?", t).n;
  out.orders_new = get('SELECT COUNT(*) n FROM orders WHERE order_date BETWEEN ? AND ?', from, to).n;
  out.order_status = all("SELECT CASE WHEN hold_status IS NOT NULL AND status NOT IN ('cancelled','delivered') THEN 'on_hold' ELSE status END AS status, COUNT(*) n FROM orders WHERE status != 'cancelled' AND (status != 'delivered' OR updated_at >= ?) GROUP BY 1", from);
  const pj = get("SELECT COUNT(*) n, SUM(MIN(qty_passed, qty_target)) p, SUM(qty_target) t, SUM(qty_produced) pr FROM production_jobs WHERE status = 'open'");
  out.production = { open: pj.n, pct: pj.t ? Math.round((pj.p / pj.t) * 100) : 0, produced_pct: pj.t ? Math.round(((pj.pr || 0) / pj.t) * 100) : 0 };
  out.production.output = round2(get("SELECT SUM(qty_passed) s FROM production_logs WHERE kind = 'qc' AND substr(ts,1,10) BETWEEN ? AND ?", from, to).s || 0);
  out.production.rejected = round2(get("SELECT SUM(qty_rejected) s FROM production_logs WHERE kind = 'qc' AND substr(ts,1,10) BETWEEN ? AND ?", from, to).s || 0);
  out.jobs = all(`SELECT j.id, j.number, j.title, j.stage, j.qty_target, j.qty_produced, j.qty_passed, j.due_date, o.number AS order_number, c.company AS customer_name
    FROM production_jobs j JOIN orders o ON o.id = j.order_id JOIN parties c ON c.id = o.customer_id WHERE j.status = 'open'
    ORDER BY COALESCE(j.due_date,'9999'), j.id LIMIT 8`);
  out.low_stock = all(`SELECT * FROM (SELECT id, code, name, unit, stock_qty, reorder_level, reorder_qty, 'material' AS kind FROM materials WHERE active = 1 AND reorder_level > 0 AND stock_qty <= reorder_level
    UNION ALL SELECT id, code, name, unit, stock_qty, reorder_level, NULL, 'product' FROM products WHERE active = 1 AND reorder_level > 0 AND stock_qty <= reorder_level)
    ORDER BY stock_qty / reorder_level LIMIT 8`);
  out.low_stock_count = get(`SELECT (SELECT COUNT(*) FROM materials WHERE active = 1 AND reorder_level > 0 AND stock_qty <= reorder_level)
    + (SELECT COUNT(*) FROM products WHERE active = 1 AND reorder_level > 0 AND stock_qty <= reorder_level) n`).n;
  out.upcoming = all(`SELECT o.id, o.number, o.due_date, o.status, o.hold_status, o.priority, c.company AS customer_name,
      (SELECT SUM(qty - delivered_qty) FROM order_lines WHERE order_id = o.id) AS remaining,
      (SELECT SUM(MIN(MAX(passed_qty - delivered_qty,0), qty - delivered_qty)) FROM order_lines WHERE order_id = o.id) AS ready_qty
    FROM orders o JOIN parties c ON c.id = o.customer_id WHERE o.status NOT IN ('delivered','cancelled') AND o.due_date IS NOT NULL AND o.due_date <= ?
    ORDER BY o.due_date LIMIT 8`, addDays(t, 14));
  out.recent_dispatches = all(`SELECT d.id, d.number, d.date, d.status, c.company AS customer_name, (SELECT SUM(qty) FROM delivery_lines WHERE delivery_id = d.id) qty
    FROM deliveries d JOIN parties c ON c.id = d.customer_id ORDER BY d.date DESC, d.id DESC LIMIT 5`);
  out.quotes_open = get("SELECT COUNT(*) n FROM quotations WHERE status IN ('draft','sent')").n;
  out.quotes_approved = get("SELECT COUNT(*) n FROM quotations WHERE status = 'approved'").n;
  res.json(out);
}));

// ======================= REPORTS =======================
const M = 'money', N = 'num', D = 'date', P = 'pct', T = 'text';
function cogsSql() {
  return `SELECT ROUND(SUM(il.qty * COALESCE(NULLIF(ol.unit_cost_est,0), p.cost_price, 0)),2) s FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id LEFT JOIN order_lines ol ON ol.id = il.order_line_id LEFT JOIN products p ON p.id = il.product_id
    WHERE i.status != 'void'`;
}
const REPORTS = {
  sales: {
    title: 'Sales report',
    build({ from, to }) {
      const rows = all(`SELECT i.number, i.date, c.company AS customer, o.number AS order_no, i.subtotal, i.discount, i.tax_amount, i.total, i.paid_amount AS paid,
        ROUND(i.total - i.paid_amount,2) AS balance, i.status FROM invoices i JOIN parties c ON c.id = i.customer_id LEFT JOIN orders o ON o.id = i.order_id
        WHERE i.status != 'void' AND i.date BETWEEN ? AND ? ORDER BY i.date, i.id`, from, to);
      const byCust = all(`SELECT c.company AS customer, COUNT(*) AS invoices, ROUND(SUM(i.total),2) AS total, ROUND(SUM(i.paid_amount),2) AS paid,
        ROUND(SUM(i.total - i.paid_amount),2) AS balance FROM invoices i JOIN parties c ON c.id = i.customer_id
        WHERE i.status != 'void' AND i.date BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC`, from, to);
      const byProduct = all(`SELECT COALESCE(p.code,'—') AS code, il.description AS product, ROUND(SUM(il.qty),2) AS qty, ROUND(SUM(il.amount),2) AS amount
        FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id LEFT JOIN products p ON p.id = il.product_id
        WHERE i.status != 'void' AND i.date BETWEEN ? AND ? GROUP BY COALESCE(il.product_id, il.description) ORDER BY amount DESC`, from, to);
      const total = round2(rows.reduce((s, x) => s + x.total, 0));
      const received = round2(get("SELECT SUM(amount) s FROM payments WHERE direction = 'in' AND date BETWEEN ? AND ?", from, to).s || 0);
      return {
        summary: [
          { label: 'Invoiced', value: total, format: M }, { label: 'Invoices', value: rows.length, format: N },
          { label: 'Tax charged', value: round2(rows.reduce((s, x) => s + x.tax_amount, 0)), format: M },
          { label: 'Payments received', value: received, format: M },
        ],
        tables: [
          { title: 'Invoices', columns: [['number', 'Invoice', T], ['date', 'Date', D], ['customer', 'Customer', T], ['order_no', 'Order', T], ['subtotal', 'Subtotal', M], ['discount', 'Discount', M], ['tax_amount', 'Tax', M], ['total', 'Total', M], ['paid', 'Paid', M], ['balance', 'Balance', M], ['status', 'Status', T]], rows, totals: ['subtotal', 'discount', 'tax_amount', 'total', 'paid', 'balance'] },
          { title: 'By customer', columns: [['customer', 'Customer', T], ['invoices', 'Invoices', N], ['total', 'Total', M], ['paid', 'Paid', M], ['balance', 'Balance', M]], rows: byCust, totals: ['invoices', 'total', 'paid', 'balance'] },
          { title: 'By product', columns: [['code', 'Code', T], ['product', 'Product', T], ['qty', 'Quantity', N], ['amount', 'Amount (ex tax)', M]], rows: byProduct, totals: ['qty', 'amount'] },
        ],
      };
    },
  },
  costs: {
    title: 'Costs report',
    build({ from, to }) {
      const purchases = all(`SELECT p.number, p.date, s.company AS supplier, p.supplier_ref, p.subtotal, p.tax_amount, p.total, p.paid_amount AS paid, p.status
        FROM purchases p JOIN parties s ON s.id = p.supplier_id WHERE p.date BETWEEN ? AND ? ORDER BY p.date`, from, to);
      const expenses = all(`SELECT category, COUNT(*) AS entries, ROUND(SUM(amount),2) AS amount FROM expenses WHERE date BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC`, from, to);
      const expenseRows = all(`SELECT e.number, e.date, e.category, e.description, p.company AS paid_to, e.amount FROM expenses e LEFT JOIN parties p ON p.id = e.party_id
        WHERE e.date BETWEEN ? AND ? ORDER BY e.date`, from, to);
      const consumption = all(`SELECT m.code, m.name, m.unit, ROUND(-SUM(sm.qty),2) AS qty, ROUND(-SUM(sm.qty * COALESCE(sm.unit_cost, m.unit_cost)),2) AS value
        FROM stock_movements sm JOIN materials m ON m.id = sm.item_id WHERE sm.item_kind = 'material' AND sm.type = 'consumption' AND sm.date BETWEEN ? AND ?
        GROUP BY m.id ORDER BY value DESC`, from, to);
      return {
        summary: [
          { label: 'Purchases', value: round2(purchases.reduce((s, x) => s + x.total, 0)), format: M },
          { label: 'Expenses', value: round2(expenses.reduce((s, x) => s + x.amount, 0)), format: M },
          { label: 'Materials consumed', value: round2(consumption.reduce((s, x) => s + x.value, 0)), format: M },
        ],
        tables: [
          { title: 'Material purchases', columns: [['number', 'Purchase', T], ['date', 'Date', D], ['supplier', 'Supplier', T], ['supplier_ref', 'Bill no.', T], ['subtotal', 'Subtotal', M], ['tax_amount', 'Tax', M], ['total', 'Total', M], ['paid', 'Paid', M], ['status', 'Status', T]], rows: purchases, totals: ['subtotal', 'tax_amount', 'total', 'paid'] },
          { title: 'Expenses by category', columns: [['category', 'Category', T], ['entries', 'Entries', N], ['amount', 'Amount', M]], rows: expenses, totals: ['entries', 'amount'] },
          { title: 'Expense entries', columns: [['number', 'No.', T], ['date', 'Date', D], ['category', 'Category', T], ['description', 'Description', T], ['paid_to', 'Paid to', T], ['amount', 'Amount', M]], rows: expenseRows, totals: ['amount'] },
          { title: 'Material consumption (at recorded cost)', columns: [['code', 'Code', T], ['name', 'Material', T], ['unit', 'Unit', T], ['qty', 'Qty used', N], ['value', 'Value', M]], rows: consumption, totals: ['value'] },
        ],
      };
    },
  },
  profit: {
    title: 'Estimated profit report',
    note: 'Cost of goods uses each order line\'s estimated unit cost (from the quotation) or the product\'s cost price. Figures exclude tax.',
    build({ from, to }) {
      const months = buckets(from, to, 'month');
      const rows = months.map((m) => {
        const f = m + '-01' < from ? from : m + '-01';
        const last = get("SELECT date(?, 'start of month', '+1 month', '-1 day') d", f).d;
        const tt = last > to ? to : last;
        const revenue = round2(get("SELECT SUM(subtotal - discount) s FROM invoices WHERE status != 'void' AND date BETWEEN ? AND ?", f, tt).s || 0);
        const cogs = round2(get(`${cogsSql()} AND i.date BETWEEN ? AND ?`, f, tt).s || 0);
        const expenses = round2(get('SELECT SUM(amount) s FROM expenses WHERE date BETWEEN ? AND ?', f, tt).s || 0);
        const gross = round2(revenue - cogs);
        const net = round2(gross - expenses);
        return { month: m, revenue, cogs, gross, gross_pct: revenue ? round2((gross / revenue) * 100) : 0, expenses, net, net_pct: revenue ? round2((net / revenue) * 100) : 0 };
      });
      const byCust = all(`SELECT c.company AS customer, ROUND(SUM(il.amount),2) AS revenue,
        ROUND(SUM(il.qty * COALESCE(NULLIF(ol.unit_cost_est,0), p.cost_price, 0)),2) AS cogs
        FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id JOIN parties c ON c.id = i.customer_id
        LEFT JOIN order_lines ol ON ol.id = il.order_line_id LEFT JOIN products p ON p.id = il.product_id
        WHERE i.status != 'void' AND i.date BETWEEN ? AND ? GROUP BY c.id ORDER BY revenue DESC`, from, to)
        .map((x) => ({ ...x, gross: round2(x.revenue - x.cogs), gross_pct: x.revenue ? round2(((x.revenue - x.cogs) / x.revenue) * 100) : 0 }));
      const t = rows.reduce((a, x) => ({ revenue: a.revenue + x.revenue, cogs: a.cogs + x.cogs, expenses: a.expenses + x.expenses }), { revenue: 0, cogs: 0, expenses: 0 });
      const net = round2(t.revenue - t.cogs - t.expenses);
      return {
        summary: [
          { label: 'Revenue (ex tax)', value: round2(t.revenue), format: M }, { label: 'Est. cost of goods', value: round2(t.cogs), format: M },
          { label: 'Expenses', value: round2(t.expenses), format: M }, { label: 'Est. net profit', value: net, format: M },
          { label: 'Net margin', value: t.revenue ? round2((net / t.revenue) * 100) : 0, format: P },
        ],
        tables: [
          { title: 'By month', columns: [['month', 'Month', T], ['revenue', 'Revenue', M], ['cogs', 'Est. COGS', M], ['gross', 'Gross profit', M], ['gross_pct', 'Gross %', P], ['expenses', 'Expenses', M], ['net', 'Net profit', M], ['net_pct', 'Net %', P]], rows, totals: ['revenue', 'cogs', 'gross', 'expenses', 'net'] },
          { title: 'Gross profit by customer', columns: [['customer', 'Customer', T], ['revenue', 'Revenue', M], ['cogs', 'Est. COGS', M], ['gross', 'Gross profit', M], ['gross_pct', 'Gross %', P]], rows: byCust, totals: ['revenue', 'cogs', 'gross'] },
        ],
      };
    },
  },
  inventory: {
    title: 'Inventory report',
    build({ from, to }) {
      const mats = all(`SELECT code, name, category, unit, ROUND(stock_qty,2) AS stock, reorder_level, ROUND(unit_cost,2) AS unit_cost, ROUND(stock_qty*unit_cost,2) AS value,
        CASE WHEN reorder_level > 0 AND stock_qty <= reorder_level THEN 'Reorder' ELSE 'OK' END AS status FROM materials WHERE active = 1 ORDER BY category, code`);
      const prods = all(`SELECT code, name, type, unit, ROUND(stock_qty,2) AS stock, reorder_level, ROUND(cost_price,2) AS unit_cost, ROUND(stock_qty*cost_price,2) AS value
        FROM products WHERE active = 1 AND (stock_qty != 0 OR reorder_level > 0) ORDER BY code`);
      const moves = all(`SELECT sm.type, sm.item_kind AS kind, COUNT(*) AS entries, ROUND(SUM(sm.qty),2) AS qty FROM stock_movements sm WHERE sm.date BETWEEN ? AND ?
        GROUP BY sm.item_kind, sm.type ORDER BY sm.item_kind, sm.type`, from, to);
      return {
        summary: [
          { label: 'Raw material value', value: round2(mats.reduce((s, x) => s + x.value, 0)), format: M },
          { label: 'Finished goods value', value: round2(prods.reduce((s, x) => s + x.value, 0)), format: M },
          { label: 'Items to reorder', value: mats.filter((x) => x.status === 'Reorder').length, format: N },
        ],
        tables: [
          { title: 'Raw materials', columns: [['code', 'Code', T], ['name', 'Material', T], ['category', 'Category', T], ['unit', 'Unit', T], ['stock', 'In stock', N], ['reorder_level', 'Reorder at', N], ['unit_cost', 'Avg cost', M], ['value', 'Value', M], ['status', 'Status', T]], rows: mats, totals: ['value'] },
          { title: 'Finished goods', columns: [['code', 'Code', T], ['name', 'Product', T], ['type', 'Type', T], ['unit', 'Unit', T], ['stock', 'In stock', N], ['reorder_level', 'Reorder at', N], ['unit_cost', 'Cost', M], ['value', 'Value', M]], rows: prods, totals: ['value'] },
          { title: 'Stock movements in period', columns: [['kind', 'Item', T], ['type', 'Movement', T], ['entries', 'Entries', N], ['qty', 'Net qty', N]], rows: moves },
        ],
      };
    },
  },
  production: {
    title: 'Production report',
    build({ from, to }) {
      const jobs = all(`SELECT j.number, o.number AS order_no, c.company AS customer, COALESCE(p.code,'') AS product, j.qty_target AS target, j.qty_produced AS produced,
        j.qty_passed AS passed, j.qty_rejected AS rejected, CASE WHEN j.qty_produced > 0 THEN ROUND(j.qty_rejected * 100.0 / j.qty_produced, 2) ELSE 0 END AS reject_pct,
        j.stage, j.status, j.due_date FROM production_jobs j JOIN orders o ON o.id = j.order_id JOIN parties c ON c.id = o.customer_id LEFT JOIN products p ON p.id = j.product_id
        WHERE j.status = 'open' OR substr(j.updated_at,1,10) BETWEEN ? AND ? OR substr(j.created_at,1,10) BETWEEN ? AND ? ORDER BY j.status, j.due_date`, from, to, from, to);
      const out = all(`SELECT substr(ts,1,10) AS day, ROUND(SUM(COALESCE(qty_produced,0)),2) AS produced, ROUND(SUM(COALESCE(qty_passed,0)),2) AS passed,
        ROUND(SUM(COALESCE(qty_rejected,0)),2) AS rejected FROM production_logs WHERE kind IN ('progress','qc') AND substr(ts,1,10) BETWEEN ? AND ? GROUP BY day ORDER BY day`, from, to);
      const tot = out.reduce((a, x) => ({ produced: a.produced + x.produced, passed: a.passed + x.passed, rejected: a.rejected + x.rejected }), { produced: 0, passed: 0, rejected: 0 });
      return {
        summary: [
          { label: 'Produced', value: round2(tot.produced), format: N }, { label: 'Passed QC', value: round2(tot.passed), format: N },
          { label: 'Rejected', value: round2(tot.rejected), format: N },
          { label: 'Rejection rate', value: tot.passed + tot.rejected ? round2((tot.rejected / (tot.passed + tot.rejected)) * 100) : 0, format: P },
        ],
        tables: [
          { title: 'Jobs', columns: [['number', 'Job', T], ['order_no', 'Order', T], ['customer', 'Customer', T], ['product', 'Product', T], ['target', 'Target', N], ['produced', 'Produced', N], ['passed', 'Passed', N], ['rejected', 'Rejected', N], ['reject_pct', 'Reject %', P], ['stage', 'Stage', T], ['status', 'Status', T], ['due_date', 'Due', D]], rows: jobs },
          { title: 'Daily output', columns: [['day', 'Date', D], ['produced', 'Produced', N], ['passed', 'Passed', N], ['rejected', 'Rejected', N]], rows: out, totals: ['produced', 'passed', 'rejected'] },
        ],
      };
    },
  },
  balances: {
    title: 'Customer & supplier balances',
    build() {
      const t = today();
      const cust = all(`SELECT id, company, phone, credit_limit, CASE WHEN kind = 'supplier' THEN 0 ELSE opening_balance END AS opening FROM parties WHERE kind IN ('customer','both') ORDER BY company`).map((c) => {
        const inv = all("SELECT due_date, total - paid_amount AS bal FROM invoices WHERE customer_id = ? AND status IN ('unpaid','partial')", c.id);
        const a = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
        for (const i of inv) {
          const late = i.due_date ? Math.floor((Date.parse(t) - Date.parse(i.due_date)) / 864e5) : 0;
          const k = late <= 0 ? 'current' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'd90p';
          a[k] = round2(a[k] + i.bal);
        }
        const invoiced = get("SELECT COALESCE(SUM(total),0) s FROM invoices WHERE customer_id = ? AND status != 'void'", c.id).s;
        const received = get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE party_id = ? AND direction = 'in'", c.id).s;
        const credit = round2(get(`SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = p.id),0)),0) s
          FROM payments p WHERE p.party_id = ? AND p.direction = 'in'`, c.id).s);
        return { customer: c.company, phone: c.phone, opening: c.opening, invoiced: round2(invoiced), received: round2(received), unapplied: credit, ...a, balance: round2(c.opening + invoiced - received), credit_limit: c.credit_limit };
      }).filter((x) => x.balance || x.invoiced || x.opening);
      const sup = all(`SELECT id, company, CASE WHEN kind = 'supplier' THEN opening_balance ELSE 0 END AS opening FROM parties WHERE kind IN ('supplier','both') ORDER BY company`).map((s) => {
        const purchased = get('SELECT COALESCE(SUM(total),0) s FROM purchases WHERE supplier_id = ?', s.id).s;
        const paid = get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE party_id = ? AND direction = 'out'", s.id).s;
        return { supplier: s.company, opening: s.opening, purchased: round2(purchased), paid: round2(paid), balance: round2(s.opening + purchased - paid) };
      }).filter((x) => x.balance || x.purchased || x.opening);
      return {
        summary: [
          { label: 'Receivable from customers', value: round2(cust.reduce((s, x) => s + x.balance, 0)), format: M },
          { label: 'Overdue (30+ days)', value: round2(cust.reduce((s, x) => s + x.d60 + x.d90 + x.d90p, 0)), format: M },
          { label: 'Payable to suppliers', value: round2(sup.reduce((s, x) => s + x.balance, 0)), format: M },
        ],
        tables: [
          { title: 'Customer balances & aging', columns: [['customer', 'Customer', T], ['opening', 'Opening', M], ['invoiced', 'Invoiced', M], ['received', 'Received', M], ['unapplied', 'Unapplied credit', M], ['current', 'Not due', M], ['d30', '1–30 days', M], ['d60', '31–60', M], ['d90', '61–90', M], ['d90p', '90+', M], ['balance', 'Balance', M]], rows: cust, totals: ['opening', 'invoiced', 'received', 'unapplied', 'current', 'd30', 'd60', 'd90', 'd90p', 'balance'] },
          { title: 'Supplier balances', columns: [['supplier', 'Supplier', T], ['opening', 'Opening', M], ['purchased', 'Purchased', M], ['paid', 'Paid', M], ['balance', 'Balance', M]], rows: sup, totals: ['opening', 'purchased', 'paid', 'balance'] },
        ],
      };
    },
  },
};

function buildReport(type, q) {
  const def = REPORTS[type];
  if (!def) throw bad('Unknown report');
  const data = def.build(q);
  data.tables = data.tables.map((t) => ({ ...t, columns: t.columns.map(([key, label, format]) => ({ key, label, format })) }));
  return { type, title: def.title, note: def.note || null, from: q.from, to: q.to, generated_at: new Date().toISOString(), ...data };
}

// Each report also needs view access to the data behind it (any one of the listed modules).
const REPORT_NEEDS = { sales: ['invoices'], costs: ['expenses', 'payments'], profit: ['invoices'], inventory: ['inventory'], production: ['production'], balances: ['invoices', 'payments'] };
r.get('/reports-available', requirePerm('reports'), h((req, res) => {
  res.json(Object.keys(REPORTS).filter((k) => REPORT_NEEDS[k].some((m) => can(req.user, m))).map((k) => ({ key: k, title: REPORTS[k].title })));
}));
r.get('/reports/:type', requirePerm('reports'), h(async (req, res) => {
  const need = REPORT_NEEDS[req.params.type];
  if (need && !need.some((m) => can(req.user, m))) return res.status(403).json({ error: 'Your role does not have access to the data in this report.' });
  const q = range(req);
  const rep = buildReport(req.params.type, q);
  const fmt = req.query.format;
  const company = getSetting('company', {});
  const currency = getSetting('currency', { code: 'PKR', decimals: 0 });
  const fname = `${(company.name || 'Alkarim').replace(/[^\w]+/g, '-')}-${req.params.type}-${q.from}_to_${q.to}`;
  if (fmt === 'xlsx') {
    const buf = await toXlsx(rep, company, currency);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
    return res.end(Buffer.from(buf));
  }
  if (fmt === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.pdf"`);
    return toPdf(rep, company, currency, res);
  }
  res.json(rep);
}));

// ---------- exporters ----------
async function toXlsx(rep, company, currency) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = company.name || 'Alkarim Packages';
  const moneyFmt = currency.decimals ? `#,##0.${'0'.repeat(currency.decimals)}` : '#,##0';
  const sum = wb.addWorksheet('Summary');
  sum.addRow([company.name || 'Alkarim Packages']).font = { bold: true, size: 14 };
  sum.addRow([rep.title]).font = { bold: true, size: 12 };
  sum.addRow([`Period: ${rep.from} to ${rep.to}`]);
  sum.addRow([`Currency: ${currency.code}`]);
  if (rep.note) sum.addRow([rep.note]);
  sum.addRow([]);
  for (const s of rep.summary) {
    const row = sum.addRow([s.label, s.value]);
    row.getCell(2).numFmt = s.format === M ? moneyFmt : s.format === P ? '0.00"%"' : '#,##0.##';
  }
  sum.getColumn(1).width = 34; sum.getColumn(2).width = 20;
  const used = new Set(['Summary']);
  for (const t of rep.tables) {
    let name = t.title.replace(/[\\/?*[\]:]/g, '').slice(0, 31);
    while (used.has(name)) name = name.slice(0, 28) + used.size;
    used.add(name);
    const ws = wb.addWorksheet(name);
    const header = ws.addRow(t.columns.map((c) => (c.format === M ? `${c.label} (${currency.code})` : c.label)));
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E2A3B' } }; });
    for (const row of t.rows) ws.addRow(t.columns.map((c) => (row[c.key] ?? '')));
    if (t.totals && t.rows.length) {
      const tr = ws.addRow(t.columns.map((c, i) => (i === 0 ? 'Total' : t.totals.includes(c.key) ? round2(t.rows.reduce((s, x) => s + (Number(x[c.key]) || 0), 0)) : '')));
      tr.font = { bold: true };
    }
    t.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.min(Math.max(c.label.length + 4, c.format === T ? 18 : 14), 40);
      if (c.format === M) col.numFmt = moneyFmt;
      if (c.format === N) col.numFmt = '#,##0.##';
      if (c.format === P) col.numFmt = '0.00"%"';
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return wb.xlsx.writeBuffer();
}

function fmtVal(v, f, currency) {
  if (v === null || v === undefined || v === '') return '';
  if (f === M) return Number(v).toLocaleString('en-US', { minimumFractionDigits: currency.decimals || 0, maximumFractionDigits: currency.decimals || 0 });
  if (f === N) return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (f === P) return `${Number(v).toFixed(1)}%`;
  return String(v);
}
function toPdf(rep, company, currency, res) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: rep.title, Author: company.name } });
  doc.pipe(res);
  const W = doc.page.width - 72;
  const ink = '#0f172a', muted = '#64748b', accent = '#0e7490', line = '#cbd5e1';
  doc.fillColor(accent).font('Helvetica-Bold').fontSize(16).text(company.name || 'Alkarim Packages', 36, 36);
  doc.fillColor(ink).fontSize(12).text(rep.title, 36, 58);
  doc.fillColor(muted).font('Helvetica').fontSize(9).text(`Period ${rep.from} to ${rep.to} · Amounts in ${currency.code} · Generated ${new Date().toLocaleString('en-GB')}`, 36, 76);
  if (rep.note) doc.text(rep.note, 36, 90, { width: W });
  let y = rep.note ? 112 : 98;
  // summary boxes
  const bw = Math.min(160, (W - (rep.summary.length - 1) * 8) / rep.summary.length);
  rep.summary.forEach((s, i) => {
    const x = 36 + i * (bw + 8);
    doc.roundedRect(x, y, bw, 40, 4).strokeColor(line).stroke();
    doc.fillColor(muted).fontSize(7.5).text(s.label.toUpperCase(), x + 8, y + 7, { width: bw - 16 });
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(11).text(`${s.format === M ? currency.symbol + ' ' : ''}${fmtVal(s.value, s.format, currency)}`, x + 8, y + 20, { width: bw - 16 });
    doc.font('Helvetica');
  });
  y += 56;
  const bottom = doc.page.height - 48;
  for (const t of rep.tables) {
    if (y > bottom - 60) { doc.addPage(); y = 36; }
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(10.5).text(t.title, 36, y);
    y += 16;
    const weights = t.columns.map((c) => (c.format === T ? (/(customer|name|product|description|supplier|material)/.test(c.key) ? 2.2 : 1.2) : 1));
    const tw = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / tw) * W);
    const drawHeader = () => {
      doc.rect(36, y, W, 16).fill('#e2e8f0');
      let x = 36;
      doc.fillColor(ink).font('Helvetica-Bold').fontSize(7.5);
      t.columns.forEach((c, i) => { doc.text(c.label, x + 3, y + 4, { width: widths[i] - 6, align: c.format === T || c.format === D ? 'left' : 'right', lineBreak: false, ellipsis: true }); x += widths[i]; });
      y += 16; doc.font('Helvetica');
    };
    drawHeader();
    const rows = t.rows.slice();
    if (t.totals && rows.length) rows.push({ __total: true, ...Object.fromEntries(t.columns.map((c, i) => [c.key, i === 0 ? 'Total' : t.totals.includes(c.key) ? round2(t.rows.reduce((s, x) => s + (Number(x[c.key]) || 0), 0)) : ''])) });
    if (!rows.length) { doc.fillColor(muted).fontSize(8.5).text('No records in this period.', 39, y + 3); y += 18; }
    rows.forEach((row, ri) => {
      if (y > bottom) { doc.addPage(); y = 36; drawHeader(); }
      if (ri % 2 === 1 && !row.__total) doc.rect(36, y, W, 14).fill('#f8fafc');
      let x = 36;
      doc.fillColor(ink).font(row.__total ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
      t.columns.forEach((c, i) => {
        const v = row.__total && i === 0 ? 'Total' : fmtVal(row[c.key], c.format, currency);
        doc.text(v, x + 3, y + 3.5, { width: widths[i] - 6, align: c.format === T || c.format === D ? 'left' : 'right', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.moveTo(36, y + 14).lineTo(36 + W, y + 14).strokeColor('#eef2f7').lineWidth(0.5).stroke();
      y += 14;
    });
    y += 16;
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.fillColor(muted).fontSize(7.5).text(`${company.name || 'Alkarim Packages'} · ${rep.title} · Page ${i + 1} of ${range.count}`, 36, doc.page.height - 30, { width: W, align: 'right', lineBreak: false });
  }
  doc.end();
}

module.exports = r;
