'use strict';
const { insert, now, getSetting, setSetting } = require('./db');
const { HttpError } = require('./auth');

const DEFAULT_SETTINGS = {
  company: {
    name: 'Alkarim Packages', tagline: 'Packaging manufacturing', address: '', city: '', country: 'Pakistan',
    phone: '', email: '', website: '', ntn: '', strn: '', logo: null,
    invoiceFooter: 'Thank you for your business.', bank: '',
  },
  branding: { accent: '#22d3ee', compactTables: false },
  currency: { code: 'PKR', symbol: 'Rs', decimals: 0, priceDecimals: 2, position: 'before' },
  taxes: [],
  defaultTaxId: null,
  units: {
    length: ['mm', 'cm', 'inch'],
    material: ['kg', 'sheet', 'ream', 'roll', 'meter', 'ltr', 'pcs'],
    product: ['pcs', 'set', 'pack', 'roll', 'kg'],
    thickness: ['gsm', 'micron', 'mm', 'pt'],
  },
  productTypes: ['Folding carton', 'Corrugated box', 'Rigid box', 'Paper bag', 'Flexible pouch', 'Label / sticker', 'Sleeve', 'Tray & insert', 'Other'],
  finishes: ['Gloss lamination', 'Matte lamination', 'Soft-touch lamination', 'Spot UV', 'Gloss varnish', 'Hot foil stamping', 'Embossing', 'Debossing', 'Window patching', 'Die cutting'],
  printMethods: ['Offset', 'Flexo', 'Rotogravure', 'Digital', 'Screen', 'Unprinted'],
  materialCategories: ['Paper & Board', 'Corrugated', 'Film & Foil', 'Ink', 'Adhesive', 'Lamination', 'Consumables', 'Packing'],
  expenseCategories: ['Electricity', 'Gas', 'Rent', 'Salaries & wages', 'Transport & fuel', 'Machine maintenance', 'Plates & dies', 'Office', 'Other'],
  paymentMethods: ['Cash', 'Bank transfer', 'Cheque', 'Online / wallet'],
  productionStages: [
    { key: 'queued', label: 'Queued' }, { key: 'prepress', label: 'Pre-press' }, { key: 'printing', label: 'Printing' },
    { key: 'finishing', label: 'Finishing' }, { key: 'diecutting', label: 'Die-cutting' }, { key: 'pasting', label: 'Pasting / assembly' },
    { key: 'qc', label: 'Quality check' }, { key: 'completed', label: 'Completed' },
  ],
  numbering: { QT: 'QT', SO: 'SO', JOB: 'JOB', DN: 'DN', INV: 'INV', RCV: 'RCV', PMT: 'PMT', PUR: 'PUR', EXP: 'EXP', PRD: 'PRD' },
  defaults: { quoteValidityDays: 15, invoiceDueDays: 30, wastagePct: 5, profitPct: 20, overrunPct: 10 },
  quoteTerms: 'Prices are valid until the date shown on this quotation.\nArtwork approval is required before production starts.',
};

function ensureDefaults() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const cur = getSetting(k, undefined);
    if (cur === undefined) setSetting(k, v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      // Add any new keys introduced by an update without overwriting user values.
      const merged = { ...v, ...cur };
      if (JSON.stringify(merged) !== JSON.stringify(cur)) setSetting(k, merged);
    }
  }
}

function allSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k, DEFAULT_SETTINGS[k]);
  return out;
}

// ---------- validation ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validate(body, spec, { partial = false } = {}) {
  const data = {};
  const errors = {};
  body = body || {};
  for (const [key, f] of Object.entries(spec)) {
    const label = f.label || key;
    let v = body[key];
    if (partial && !(key in body)) continue;
    if (typeof v === 'string') v = v.trim();
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (f.required) errors[key] = `${label} is required`;
      else data[key] = f.default !== undefined ? f.default : (f.type === 'json' ? (f.jsonDefault ?? null) : null);
      continue;
    }
    switch (f.type) {
      case 'num':
      case 'int': {
        const n = Number(v);
        if (!Number.isFinite(n)) { errors[key] = `${label} must be a number`; break; }
        if (f.type === 'int' && !Number.isInteger(n)) { errors[key] = `${label} must be a whole number`; break; }
        if (f.min !== undefined && n < f.min) { errors[key] = `${label} must be at least ${f.min}`; break; }
        if (f.gt !== undefined && n <= f.gt) { errors[key] = `${label} must be greater than ${f.gt}`; break; }
        if (f.max !== undefined && n > f.max) { errors[key] = `${label} must be at most ${f.max}`; break; }
        data[key] = n;
        break;
      }
      case 'date':
        if (!DATE_RE.test(String(v)) || isNaN(Date.parse(v))) errors[key] = `${label} must be a valid date`;
        else data[key] = String(v);
        break;
      case 'bool':
        data[key] = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
        break;
      case 'json':
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { errors[key] = `${label} is not valid`; break; } }
        data[key] = v;
        break;
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) errors[key] = `${label} must be a valid email address`;
        else data[key] = String(v);
        break;
      default: {
        const s = String(v);
        if (f.maxLen && s.length > f.maxLen) { errors[key] = `${label} must be ${f.maxLen} characters or fewer`; break; }
        if (f.enum && !f.enum.includes(s)) { errors[key] = `${label} must be one of: ${f.enum.join(', ')}`; break; }
        data[key] = s;
      }
    }
  }
  if (Object.keys(errors).length) {
    throw new HttpError(400, 'Please fix the highlighted fields.', { fields: errors });
  }
  return data;
}

function bad(message, fields) { return new HttpError(400, message, fields ? { fields } : undefined); }
function notFound(what = 'Record') { return new HttpError(404, `${what} not found. It may have been deleted.`); }
function conflict(message, extra) { return new HttpError(409, message, extra); }

function log(req, action, entity, entityId, label, details) {
  try {
    insert('activity', {
      ts: now(), user_id: req && req.user ? req.user.id : null, user_name: req && req.user ? req.user.name : 'System',
      action, entity, entity_id: entityId ?? null, label: label || null, details: details ? JSON.stringify(details) : null,
    });
  } catch (e) { console.error('activity log failed', e.message); }
}

// Wrap route handlers so thrown errors become JSON responses.
const h = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (e) { next(e); }
};

function diff(before, after, keys) {
  const changes = {};
  for (const k of keys || Object.keys(after)) {
    const a = before ? before[k] : undefined;
    const b = after[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[k] = { from: a ?? null, to: b ?? null };
  }
  return changes;
}

function paging(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 5000);
  return { limit };
}

module.exports = { DEFAULT_SETTINGS, ensureDefaults, allSettings, validate, bad, notFound, conflict, log, h, diff, paging };
