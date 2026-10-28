'use strict';
// Sample data for a packaging manufacturer. Every row is flagged is_sample = 1 so it can be removed in one step.
const { get, insert, update, run, tx, now, today, round2, round4, nextNumber } = require('./db');
const { hashPassword } = require('./auth');
const { buildTiers, moveStock, recomputeInvoice, recomputeOrderStatus, syncLineProduction, allocate, applyOrderDeposits } = require('./logic');

const S = 1;
const day = (offset) => new Date(Date.parse(today()) + offset * 864e5).toISOString().slice(0, 10);
const ts = (d, h = 10) => `${d}T${String(h).padStart(2, '0')}:00:00.000Z`;

function seed(adminId) {
  tx(() => {
    // ---------- staff ----------
    const pw = hashPassword('demo1234');
    const U = {};
    for (const [username, name, role] of [['sara', 'Sara Ahmed', 'sales'], ['bilal', 'Bilal Khan', 'production'], ['imran', 'Imran Ali', 'inventory'], ['ayesha', 'Ayesha Malik', 'accounts']]) {
      const ex = get('SELECT id FROM users WHERE username = ?', username);
      U[role] = ex ? ex.id : insert('users', { name, username, password_hash: pw, role, active: 1, is_sample: S, created_at: now() });
    }
    const by = (role) => U[role] || adminId;

    // ---------- parties ----------
    const P = {};
    const party = (key, o) => { P[key] = insert('parties', { kind: 'customer', contacts: '[]', opening_balance: 0, active: 1, is_sample: S, created_at: now(), updated_at: now(), ...o }); };
    party('crescent', { company: 'Crescent Sweets & Bakers', contact_name: 'Hamza Qureshi', phone: '0300 1234567', email: 'purchase@crescent-sweets.example', address: '14 Main Boulevard, Gulberg III', city: 'Lahore', tax_id: '1234567-8', payment_terms_days: 30, credit_limit: 1500000,
      contacts: JSON.stringify([{ name: 'Hamza Qureshi', role: 'Purchase manager', phone: '0300 1234567' }, { name: 'Nadia Iqbal', role: 'Accounts', phone: '042 35761234' }]), notes: 'Peak demand before Eid and wedding season. Prefers matte lamination with gold foil.' });
    party('ravi', { company: 'Ravi Pharma Labs', contact_name: 'Dr. Usman Tariq', phone: '0321 7654321', email: 'packaging@ravipharma.example', address: 'Plot 22, Sundar Industrial Estate', city: 'Lahore', tax_id: '2345678-9', payment_terms_days: 45, credit_limit: 2500000, notes: 'Artwork must carry batch/expiry panel. QC certificate required with every delivery.' });
    party('greenvalley', { company: 'Green Valley Foods', contact_name: 'Faisal Mehmood', phone: '0333 4567890', email: 'supply@greenvalley.example', address: 'Industrial Area, Sheikhupura Road', city: 'Faisalabad', payment_terms_days: 30, opening_balance: 85000, notes: 'Export cartons, needs edge crush test report.' });
    party('indus', { company: 'Indus Tea House', contact_name: 'Kamran Baig', phone: '0345 1122334', email: 'ops@industea.example', address: '7-B Saddar Road', city: 'Karachi', payment_terms_days: 15 });
    party('noor', { company: 'Noor Cosmetics', contact_name: 'Mahnoor Shah', phone: '0301 9988776', email: 'hello@noorcosmetics.example', address: 'DHA Phase 6', city: 'Lahore', payment_terms_days: 30 });
    party('margalla', { company: 'Margalla Retail Stores', contact_name: 'Adeel Raza', phone: '0312 5566778', email: 'admin@margallaretail.example', address: 'Blue Area', city: 'Islamabad', payment_terms_days: 30 });
    party('shalimar', { kind: 'supplier', company: 'Shalimar Board Mills', contact_name: 'Rashid Butt', phone: '042 36543210', email: 'sales@shalimarboard.example', address: 'Kot Lakhpat', city: 'Lahore', payment_terms_days: 30, opening_balance: 120000 });
    party('polyfilm', { kind: 'supplier', company: 'Polyfilm Industries', contact_name: 'Sohail Akhtar', phone: '021 34567890', city: 'Karachi', payment_terms_days: 30 });
    party('colourmax', { kind: 'supplier', company: 'ColourMax Inks', contact_name: 'Waqas Ahmed', phone: '0300 4455667', city: 'Lahore', payment_terms_days: 15 });
    party('bondtech', { kind: 'both', company: 'BondTech Adhesives', contact_name: 'Naveed Anjum', phone: '0322 1239876', city: 'Gujranwala', notes: 'Supplies adhesives; also buys printed cartons for its own products.' });

    // ---------- materials ----------
    const M = {};
    const mat = (key, o, opening) => {
      M[key] = insert('materials', { stock_qty: 0, active: 1, is_sample: S, created_at: now(), updated_at: now(), location: 'Main store', ...o });
      if (opening) moveStock({ kind: 'material', id: M[key], qty: opening, type: 'opening', unitCost: o.unit_cost, note: 'Opening stock', userId: by('inventory'), date: day(-60), isSample: S });
    };
    mat('sbs350', { code: 'BRD-SBS350', name: 'SBS board 350 gsm (25×36 in)', category: 'Paper & Board', unit: 'sheet', gsm: 350, size: '25 × 36 in', reorder_level: 2000, reorder_qty: 6000, unit_cost: 62, supplier_id: P.shalimar }, 6500);
    mat('dup300', { code: 'BRD-DUP300', name: 'Duplex board grey back 300 gsm (28×40 in)', category: 'Paper & Board', unit: 'sheet', gsm: 300, size: '28 × 40 in', reorder_level: 3000, reorder_qty: 8000, unit_cost: 41, supplier_id: P.shalimar }, 7200);
    mat('kraft150', { code: 'PPR-KRF150', name: 'Kraft liner 150 gsm', category: 'Corrugated', unit: 'kg', gsm: 150, reorder_level: 1000, reorder_qty: 3000, unit_cost: 210, supplier_id: P.shalimar }, 3200);
    mat('flute120', { code: 'PPR-FLT120', name: 'Fluting medium 120 gsm', category: 'Corrugated', unit: 'kg', gsm: 120, reorder_level: 1000, reorder_qty: 3000, unit_cost: 165, supplier_id: P.shalimar }, 1900);
    mat('bopp20', { code: 'FLM-BOPP20', name: 'BOPP film 20 micron', category: 'Film & Foil', unit: 'kg', thickness: '20 micron', reorder_level: 200, reorder_qty: 500, unit_cost: 520, supplier_id: P.polyfilm }, 640);
    mat('mpet12', { code: 'FLM-MPET12', name: 'Metallised PET 12 micron', category: 'Film & Foil', unit: 'kg', thickness: '12 micron', reorder_level: 150, reorder_qty: 400, unit_cost: 690, supplier_id: P.polyfilm }, 330);
    mat('inkcmyk', { code: 'INK-OFF-CMYK', name: 'Offset process ink (CMYK set)', category: 'Ink', unit: 'kg', reorder_level: 40, reorder_qty: 100, unit_cost: 2400, supplier_id: P.colourmax }, 95);
    mat('inkflexo', { code: 'INK-FLX-WB', name: 'Water-based flexo ink', category: 'Ink', unit: 'kg', reorder_level: 30, reorder_qty: 80, unit_cost: 1350, supplier_id: P.colourmax }, 45);
    mat('pva', { code: 'ADH-PVA', name: 'PVA pasting adhesive', category: 'Adhesive', unit: 'kg', reorder_level: 80, reorder_qty: 200, unit_cost: 310, supplier_id: P.bondtech }, 240);
    mat('matlam', { code: 'LAM-MATTE', name: 'Matte BOPP lamination film (1000 m roll)', category: 'Lamination', unit: 'roll', reorder_level: 4, reorder_qty: 10, unit_cost: 9500, supplier_id: P.polyfilm }, 6);
    mat('goldfoil', { code: 'FOL-GOLD', name: 'Gold hot-stamping foil (120 m roll)', category: 'Film & Foil', unit: 'roll', reorder_level: 4, reorder_qty: 10, unit_cost: 4800, supplier_id: P.colourmax }, 2);
    mat('art130', { code: 'PPR-ART130', name: 'Art paper 130 gsm (ream)', category: 'Paper & Board', unit: 'ream', gsm: 130, reorder_level: 10, reorder_qty: 30, unit_cost: 7800, supplier_id: P.shalimar }, 16);
    mat('stretch', { code: 'PCK-STRETCH', name: 'Stretch wrap for pallets', category: 'Packing', unit: 'roll', reorder_level: 10, reorder_qty: 30, unit_cost: 1650 }, 22);

    // ---------- purchases ----------
    const purchase = (sup, date, ref, lines) => {
      const sub = round2(lines.reduce((s, l) => s + l.qty * l.unit_cost, 0));
      const pid = insert('purchases', { number: nextNumber('PUR', date), supplier_id: sup, date, supplier_ref: ref, subtotal: sub, tax_rate: 0, tax_amount: 0, total: sub, status: 'unpaid', is_sample: S, created_at: now() });
      for (const l of lines) {
        insert('purchase_lines', { purchase_id: pid, material_id: l.m, qty: l.qty, unit_cost: l.unit_cost, amount: round2(l.qty * l.unit_cost) });
        moveStock({ kind: 'material', id: l.m, qty: l.qty, type: 'purchase', unitCost: l.unit_cost, refType: 'purchase', refId: pid, userId: by('inventory'), date, isSample: S });
      }
      return pid;
    };
    const pur1 = purchase(P.shalimar, day(-40), 'SBM-8812', [{ m: M.sbs350, qty: 5000, unit_cost: 63 }, { m: M.dup300, qty: 6000, unit_cost: 42 }]);
    purchase(P.polyfilm, day(-28), 'PFI-2231', [{ m: M.bopp20, qty: 400, unit_cost: 525 }, { m: M.mpet12, qty: 200, unit_cost: 700 }]);
    const pur3 = purchase(P.colourmax, day(-21), 'CMX-0457', [{ m: M.inkcmyk, qty: 40, unit_cost: 2450 }, { m: M.goldfoil, qty: 4, unit_cost: 4900 }]);
    purchase(P.shalimar, day(-12), 'SBM-8920', [{ m: M.kraft150, qty: 2000, unit_cost: 212 }, { m: M.flute120, qty: 1500, unit_cost: 168 }]);

    // ---------- products ----------
    const PR = {};
    const prod = (key, o) => { PR[key] = insert('products', { stock_qty: 0, active: 1, is_sample: S, created_at: now(), updated_at: now(), unit: 'pcs', finishes: '[]', price_tiers: '[]', ...o }); };
    prod('mithai', { code: 'AK-MB-1KG', name: 'Mithai box 1 kg, foil logo', customer_id: P.crescent, type: 'Folding carton', length: 230, width: 180, height: 70, dim_unit: 'mm', material_id: M.sbs350, material_desc: 'SBS board', thickness_value: 350, thickness_unit: 'gsm', print_method: 'Offset', print_colors: '4+0 CMYK', print_sides: 'Outside', print_notes: 'Gold foil logo on lid, Pantone 871 C reference', finishes: JSON.stringify(['Matte lamination', 'Hot foil stamping', 'Die cutting']), price_tiers: JSON.stringify([{ min_qty: 2000, unit_price: 42 }, { min_qty: 5000, unit_price: 38 }, { min_qty: 10000, unit_price: 35 }]), base_price: 38, cost_price: 28.6, reorder_level: 0 });
    prod('pharma', { code: 'AK-PH-10X10', name: 'Tablet carton 10×10 blister', customer_id: P.ravi, type: 'Folding carton', length: 110, width: 60, height: 25, dim_unit: 'mm', material_id: M.dup300, material_desc: 'Duplex board grey back', thickness_value: 300, thickness_unit: 'gsm', print_method: 'Offset', print_colors: '2+0 (Pantone 286 C + black)', print_sides: 'Outside', print_notes: 'Leave 30×15 mm blank panel for batch/expiry inkjet', finishes: JSON.stringify(['Gloss varnish', 'Die cutting']), price_tiers: JSON.stringify([{ min_qty: 20000, unit_price: 6.6 }, { min_qty: 50000, unit_price: 6.2 }]), base_price: 6.6, cost_price: 4.7 });
    prod('export', { code: 'AK-CB-5PLY', name: '5-ply export carton 600×400×400', customer_id: P.greenvalley, type: 'Corrugated box', length: 600, width: 400, height: 400, dim_unit: 'mm', material_id: M.kraft150, material_desc: 'Kraft liner / B+C flute', thickness_value: 150, thickness_unit: 'gsm', ply: 5, print_method: 'Flexo', print_colors: '2 colour', print_sides: 'Two sides', finishes: JSON.stringify(['Die cutting']), price_tiers: JSON.stringify([{ min_qty: 500, unit_price: 245 }, { min_qty: 1000, unit_price: 235 }]), base_price: 245, cost_price: 179 });
    prod('teapouch', { code: 'AK-TP-250', name: 'Tea pouch 250 g with zip', customer_id: P.indus, type: 'Flexible pouch', length: 140, width: 220, height: 60, dim_unit: 'mm', material_id: M.bopp20, material_desc: 'BOPP 20 µ / MPET 12 µ laminate', thickness_value: 32, thickness_unit: 'micron', print_method: 'Rotogravure', print_colors: '6 colour', print_sides: 'Reverse print', finishes: JSON.stringify(['Gloss lamination']), price_tiers: JSON.stringify([{ min_qty: 10000, unit_price: 14.5 }, { min_qty: 30000, unit_price: 13.8 }]), base_price: 14.5, cost_price: 10.4 });
    prod('label', { code: 'AK-LB-CRM', name: 'Cream jar wrap label', customer_id: P.noor, type: 'Label / sticker', length: 90, width: 40, dim_unit: 'mm', material_id: M.art130, material_desc: 'Art paper, permanent adhesive', thickness_value: 130, thickness_unit: 'gsm', print_method: 'Digital', print_colors: '4 colour', print_sides: 'Front', finishes: JSON.stringify(['Gloss lamination', 'Die cutting']), price_tiers: JSON.stringify([{ min_qty: 10000, unit_price: 2.3 }, { min_qty: 20000, unit_price: 2.1 }]), base_price: 2.3, cost_price: 1.35 });
    prod('bag', { code: 'AK-PB-M', name: 'Kraft paper bag, medium, twisted handle', customer_id: P.margalla, type: 'Paper bag', length: 260, width: 120, height: 330, dim_unit: 'mm', material_id: M.kraft150, material_desc: 'Brown kraft', thickness_value: 150, thickness_unit: 'gsm', print_method: 'Flexo', print_colors: '1 colour', print_sides: 'Two sides', finishes: JSON.stringify([]), price_tiers: JSON.stringify([{ min_qty: 2000, unit_price: 25 }, { min_qty: 5000, unit_price: 24 }]), base_price: 25, cost_price: 16.8, reorder_level: 1500 });
    prod('tray', { code: 'AK-TR-CHOC', name: 'Chocolate tray insert 12 cavity', customer_id: null, type: 'Tray & insert', length: 200, width: 150, height: 20, dim_unit: 'mm', material_desc: 'SBS board', thickness_value: 300, thickness_unit: 'gsm', print_method: 'Unprinted', finishes: JSON.stringify(['Die cutting']), base_price: 9, cost_price: 5.9, reorder_level: 2000 });
    moveStock({ kind: 'product', id: PR.tray, qty: 1200, type: 'opening', note: 'Opening stock', userId: by('inventory'), date: day(-60), isSample: S });
    moveStock({ kind: 'product', id: PR.bag, qty: 900, type: 'opening', note: 'Opening stock', userId: by('inventory'), date: day(-60), isSample: S });

    // ---------- quotation helper ----------
    const quote = (o) => {
      const tiers = buildTiers(o.costing, o.tiers.map((q) => ({ qty: q })));
      const qid = insert('quotations', {
        number: nextNumber('QT', o.date), customer_id: o.customer, product_id: o.product || null, title: o.title, date: o.date, valid_until: o.valid,
        status: o.status, specs: JSON.stringify(o.specs), costing: JSON.stringify(o.costing), tiers: JSON.stringify(tiers), tax_rate: 0,
        notes: o.notes || null, terms: 'Prices are valid until the date shown on this quotation.\nArtwork approval is required before production starts.',
        prepared_by: by('sales'), is_sample: S, created_at: ts(o.date), updated_at: ts(o.date),
      });
      return { id: qid, tiers };
    };
    const mithaiCosting = {
      materials: [{ material_id: M.sbs350, description: 'SBS board 350 gsm', qty: 1, per: 2, unit: 'sheet', rate: 62 }, { material_id: M.pva, description: 'PVA adhesive', qty: 1, per: 400, unit: 'kg', rate: 310 }],
      lines: [{ group: 'printing', name: 'Plates & make-ready (4 colour)', setup: 18000, per_unit: 1.2 }, { group: 'finishing', name: 'Matte lamination', setup: 0, per_unit: 2.4 },
        { group: 'finishing', name: 'Gold foil block + stamping', setup: 9000, per_unit: 1.6 }, { group: 'finishing', name: 'Die + die-cutting', setup: 12000, per_unit: 0.6 },
        { group: 'labor', name: 'Pasting & packing', setup: 0, per_unit: 1.1 }, { group: 'other', name: 'Delivery (Lahore)', setup: 6000, per_unit: 0 }],
      wastage_pct: 6, profit_pct: 18,
    };
    const mithaiSpecs = { type: 'Folding carton', length: 230, width: 180, height: 70, dim_unit: 'mm', material_id: M.sbs350, material: 'SBS board', thickness_value: 350, thickness_unit: 'gsm', print_method: 'Offset', print_colors: '4+0 CMYK', finishes: ['Matte lamination', 'Hot foil stamping', 'Die cutting'], unit: 'pcs' };
    const q1 = quote({ customer: P.crescent, product: PR.mithai, title: 'Mithai box 1 kg, Eid run', date: day(-30), valid: day(-15), status: 'converted', specs: mithaiSpecs, costing: mithaiCosting, tiers: [5000, 10000, 20000] });
    const syncProduct = (pid, tiers, qty) => {
      const t = tiers.find((x) => x.qty === qty) || tiers[0];
      update('products', pid, { price_tiers: JSON.stringify(tiers.map((x) => ({ min_qty: x.qty, unit_price: x.unit_price }))), base_price: t.unit_price, cost_price: round2(t.unit_cost) });
    };
    syncProduct(PR.mithai, q1.tiers, 10000);
    const pharmaCosting = {
      materials: [{ material_id: M.dup300, description: 'Duplex 300 gsm', qty: 1, per: 12, unit: 'sheet', rate: 41 }],
      lines: [{ group: 'printing', name: 'Plates & make-ready (2 colour)', setup: 9000, per_unit: 0.35 }, { group: 'finishing', name: 'Gloss varnish', setup: 0, per_unit: 0.25 },
        { group: 'finishing', name: 'Die-cutting', setup: 8000, per_unit: 0.2 }, { group: 'labor', name: 'Pasting & counting', setup: 0, per_unit: 0.45 }],
      wastage_pct: 5, profit_pct: 22,
    };
    const q2 = quote({ customer: P.ravi, product: PR.pharma, title: 'Tablet carton 10×10 blister', date: day(-21), valid: day(-6), status: 'converted', specs: { type: 'Folding carton', length: 110, width: 60, height: 25, dim_unit: 'mm', material: 'Duplex grey back', thickness_value: 300, thickness_unit: 'gsm', print_method: 'Offset', print_colors: '2+0', finishes: ['Gloss varnish', 'Die cutting'] }, costing: pharmaCosting, tiers: [20000, 50000, 100000] });
    syncProduct(PR.pharma, q2.tiers, 50000);
    const pouchCosting = {
      materials: [{ material_id: M.bopp20, description: 'BOPP 20 µ', qty: 1, per: 180, unit: 'kg', rate: 520 }, { material_id: M.mpet12, description: 'MPET 12 µ', qty: 1, per: 260, unit: 'kg', rate: 690 }],
      lines: [{ group: 'printing', name: 'Gravure cylinders (6 colour)', setup: 85000, per_unit: 1.1 }, { group: 'finishing', name: 'Lamination & curing', setup: 0, per_unit: 1.4 },
        { group: 'finishing', name: 'Zip & pouch making', setup: 0, per_unit: 2.2 }, { group: 'labor', name: 'Slitting & packing', setup: 0, per_unit: 0.5 }],
      wastage_pct: 8, profit_pct: 20,
    };
    const q3 = quote({ customer: P.indus, product: PR.teapouch, title: 'Tea pouch 250 g with zip', date: day(-9), valid: day(6), status: 'converted', specs: { type: 'Flexible pouch', length: 140, width: 220, height: 60, dim_unit: 'mm', material: 'BOPP/MPET laminate', thickness_value: 32, thickness_unit: 'micron', print_method: 'Rotogravure', print_colors: '6 colour', finishes: ['Gloss lamination'] }, costing: pouchCosting, tiers: [10000, 30000, 50000] });
    syncProduct(PR.teapouch, q3.tiers, 30000);
    quote({ customer: P.bondtech, title: 'Adhesive tin sleeve, 1 kg', date: day(-4), valid: day(11), status: 'approved', notes: 'Customer confirmed artwork by email; awaiting PO.',
      specs: { type: 'Sleeve', length: 330, width: 110, dim_unit: 'mm', material: 'SBS board', thickness_value: 300, thickness_unit: 'gsm', print_method: 'Offset', print_colors: '4+0', finishes: ['Gloss varnish'] },
      costing: { materials: [{ material_id: M.sbs350, description: 'SBS board', qty: 1, per: 6, unit: 'sheet', rate: 62 }], lines: [{ group: 'printing', name: 'Plates & make-ready', setup: 16000, per_unit: 0.6 }, { group: 'finishing', name: 'Varnish + cutting', setup: 4000, per_unit: 0.5 }, { group: 'labor', name: 'Packing', setup: 0, per_unit: 0.3 }], wastage_pct: 5, profit_pct: 20 },
      tiers: [3000, 6000, 10000] });
    quote({ customer: P.noor, title: 'Lipstick carton with window', date: day(-2), valid: day(13), status: 'sent',
      specs: { type: 'Folding carton', length: 25, width: 25, height: 85, dim_unit: 'mm', material: 'SBS board', thickness_value: 350, thickness_unit: 'gsm', print_method: 'Offset', print_colors: '4+1', finishes: ['Soft-touch lamination', 'Spot UV', 'Window patching'] },
      costing: { materials: [{ material_id: M.sbs350, description: 'SBS board', qty: 1, per: 30, unit: 'sheet', rate: 62 }], lines: [{ group: 'printing', name: 'Plates (5)', setup: 22000, per_unit: 0.4 }, { group: 'finishing', name: 'Soft-touch lamination', setup: 0, per_unit: 0.9 }, { group: 'finishing', name: 'Spot UV screen', setup: 7000, per_unit: 0.5 }, { group: 'finishing', name: 'Window patching', setup: 3000, per_unit: 0.8 }, { group: 'labor', name: 'Pasting', setup: 0, per_unit: 0.4 }], wastage_pct: 7, profit_pct: 25 },
      tiers: [5000, 10000, 25000] });
    quote({ customer: P.margalla, title: 'Gift bag large, laminated', date: day(-1), valid: day(14), status: 'draft',
      specs: { type: 'Paper bag', length: 320, width: 120, height: 420, dim_unit: 'mm', material: 'Art card', thickness_value: 210, thickness_unit: 'gsm', print_method: 'Offset', print_colors: '4+0', finishes: ['Matte lamination'] },
      costing: { materials: [{ description: 'Art card 210 gsm', qty: 1, per: 1, unit: 'sheet', rate: 38 }], lines: [{ group: 'printing', name: 'Plates', setup: 15000, per_unit: 3 }, { group: 'finishing', name: 'Lamination', setup: 0, per_unit: 4 }, { group: 'labor', name: 'Bag making + rope handle', setup: 0, per_unit: 9 }], wastage_pct: 6, profit_pct: 22 },
      tiers: [1000, 3000] });
    quote({ customer: P.greenvalley, title: 'Display tray for juice packs', date: day(-35), valid: day(-20), status: 'rejected', notes: 'Customer went with a cheaper unprinted option.',
      specs: { type: 'Corrugated box', length: 380, width: 260, height: 90, dim_unit: 'mm', ply: 3, material: 'Kraft E flute', print_method: 'Flexo', print_colors: '2 colour' },
      costing: { materials: [{ material_id: M.kraft150, description: 'Kraft liner', qty: 0.32, per: 1, unit: 'kg', rate: 210 }], lines: [{ group: 'printing', name: 'Flexo plates', setup: 12000, per_unit: 2 }, { group: 'finishing', name: 'Die-cutting', setup: 10000, per_unit: 1.5 }], wastage_pct: 5, profit_pct: 20 },
      tiers: [2000, 5000] });

    // ---------- order / production / delivery / invoice helpers ----------
    const order = (o) => {
      const oid = insert('orders', { number: nextNumber('SO', o.date), customer_id: o.customer, quotation_id: o.quote || null, po_number: o.po, order_date: o.date, due_date: o.due,
        status: 'confirmed', priority: o.priority || 'normal', assigned_to: by('sales'), tax_rate: 0, specs: o.specs || null, notes: o.notes || null, is_sample: S, created_at: ts(o.date), updated_at: ts(o.date) });
      const lines = o.lines.map((l) => insert('order_lines', { order_id: oid, product_id: l.product, description: l.desc, specs: l.specs || null, qty: l.qty, unit_price: l.price, unit_cost_est: l.cost }));
      if (o.quote) update('quotations', o.quote, { order_id: oid });
      return { id: oid, lines };
    };
    const job = (o, lineIdx, qty, d, extra = {}) => insert('production_jobs', {
      number: nextNumber('JOB', d), order_id: o.id, order_line_id: o.lines[lineIdx], product_id: get('SELECT product_id FROM order_lines WHERE id = ?', o.lines[lineIdx]).product_id,
      title: get('SELECT description FROM order_lines WHERE id = ?', o.lines[lineIdx]).description, qty_target: qty, stage: 'queued', status: 'open', assigned_to: by('production'),
      start_date: d, due_date: extra.due || null, machine: extra.machine || null, specs: extra.specs || null, is_sample: S, created_at: ts(d), updated_at: ts(d),
    });
    const produce = (jid, d, qty, stage, note) => {
      const j = get('SELECT * FROM production_jobs WHERE id = ?', jid);
      update('production_jobs', jid, { qty_produced: round4(j.qty_produced + qty), stage, updated_at: ts(d, 15) });
      insert('production_logs', { job_id: jid, ts: ts(d, 15), user_id: by('production'), kind: 'progress', stage, qty_produced: qty, note: note || null });
      syncLineProduction(j.order_line_id);
    };
    const qc = (jid, d, passed, rejected, note) => {
      const j = get('SELECT * FROM production_jobs WHERE id = ?', jid);
      const totalPassed = round4(j.qty_passed + passed);
      const done = totalPassed >= j.qty_target;
      update('production_jobs', jid, { qty_passed: totalPassed, qty_rejected: round4(j.qty_rejected + rejected), stage: done ? 'completed' : 'qc', status: done ? 'completed' : 'open', updated_at: ts(d, 17) });
      insert('production_logs', { job_id: jid, ts: ts(d, 17), user_id: by('production'), kind: 'qc', stage: done ? 'completed' : 'qc', qty_passed: passed, qty_rejected: rejected, note: note || null });
      moveStock({ kind: 'product', id: j.product_id, qty: passed, type: 'production', refType: 'job', refId: jid, note: `QC passed · ${j.number}`, userId: by('production'), date: d, isSample: S });
      syncLineProduction(j.order_line_id);
    };
    const consume = (jid, d, m, qty) => {
      moveStock({ kind: 'material', id: m, qty: -qty, type: 'consumption', refType: 'job', refId: jid, note: `Used on ${get('SELECT number FROM production_jobs WHERE id = ?', jid).number}`, userId: by('production'), date: d, isSample: S });
      insert('production_logs', { job_id: jid, ts: ts(d, 12), user_id: by('production'), kind: 'consumption', stage: get('SELECT stage FROM production_jobs WHERE id = ?', jid).stage, material_id: m, material_qty: qty });
    };
    const deliver = (o, d, items, extra = {}) => {
      const cust = get('SELECT customer_id FROM orders WHERE id = ?', o.id).customer_id;
      const addr = get('SELECT address FROM parties WHERE id = ?', cust).address;
      const did = insert('deliveries', { number: nextNumber('DN', d), order_id: o.id, customer_id: cust, date: d, status: extra.received ? 'delivered' : 'dispatched', vehicle: extra.vehicle || 'LES-4512', driver: extra.driver || 'Akram', receiver_name: extra.received || null, received_date: extra.received ? d : null, address: addr, is_sample: S, created_at: ts(d, 11) });
      for (const [idx, qty, packages] of items) {
        const l = get('SELECT * FROM order_lines WHERE id = ?', o.lines[idx]);
        insert('delivery_lines', { delivery_id: did, order_line_id: l.id, product_id: l.product_id, qty, packages: packages || null });
        moveStock({ kind: 'product', id: l.product_id, qty: -qty, type: 'delivery', refType: 'delivery', refId: did, note: get('SELECT number FROM orders WHERE id = ?', o.id).number, userId: by('inventory'), date: d, isSample: S });
        update('order_lines', l.id, { delivered_qty: round4(l.delivered_qty + qty) });
      }
      return did;
    };
    const invoice = (o, d, items, dueDays, deliveryId) => {
      const ord = get('SELECT * FROM orders WHERE id = ?', o.id);
      const lines = items.map(([idx, qty]) => { const l = get('SELECT * FROM order_lines WHERE id = ?', o.lines[idx]); return { l, qty, amount: round2(qty * l.unit_price) }; });
      const sub = round2(lines.reduce((s, x) => s + x.amount, 0));
      const iid = insert('invoices', { number: nextNumber('INV', d), customer_id: ord.customer_id, order_id: o.id, delivery_id: deliveryId || null, date: d, due_date: day(Math.round((Date.parse(d) - Date.parse(today())) / 864e5) + dueDays), status: 'unpaid', subtotal: sub, discount: 0, tax_rate: 0, tax_amount: 0, total: sub, paid_amount: 0, is_sample: S, created_at: ts(d, 16) });
      for (const x of lines) {
        insert('invoice_lines', { invoice_id: iid, order_line_id: x.l.id, product_id: x.l.product_id, description: x.l.description, qty: x.qty, unit_price: x.l.unit_price, amount: x.amount });
        update('order_lines', x.l.id, { invoiced_qty: round4(x.l.invoiced_qty + x.qty) });
      }
      applyOrderDeposits(iid);
      return iid;
    };
    const pay = (partyId, d, amount, method, ref, opts = {}) => {
      const pid = insert('payments', { number: nextNumber(opts.out ? 'PMT' : 'RCV', d), party_id: partyId, direction: opts.out ? 'out' : 'in', date: d, amount, method, reference: ref, order_id: opts.order || null, user_id: by('accounts'), is_sample: S, created_at: ts(d, 14) });
      if (opts.alloc) allocate(pid, opts.alloc);
      return pid;
    };

    // 1) Margalla paper bags: delivered, invoiced, fully paid.
    const o1 = order({ customer: P.margalla, po: 'MRS-PO-1182', date: day(-48), due: day(-32), lines: [{ product: PR.bag, desc: 'Kraft paper bag, medium, twisted handle', qty: 5000, price: 24, cost: 16.8, specs: 'Flexo 1 colour logo both sides' }] });
    const j1 = job(o1, 0, 5000, day(-46), { machine: 'Bag line 1' });
    consume(j1, day(-45), M.kraft150, 560); consume(j1, day(-45), M.inkflexo, 9);
    produce(j1, day(-43), 3000, 'printing'); produce(j1, day(-40), 2150, 'pasting');
    qc(j1, day(-39), 5000, 150);
    const d1 = deliver(o1, day(-36), [[0, 5000, '50 bundles × 100']], { received: 'Store manager, Blue Area', vehicle: 'RIN-2210' });
    const i1 = invoice(o1, day(-36), [[0, 5000]], 30, d1);
    pay(P.margalla, day(-20), 120000, 'Bank transfer', 'HBL TT 559102', { alloc: [{ target_id: i1, amount: 120000 }] });

    // 2) Crescent mithai boxes: delivered in two parts, invoiced, part paid.
    const o2 = order({ customer: P.crescent, quote: q1.id, po: 'CSB-4471', date: day(-27), due: day(-6), priority: 'high', specs: 'Matte lamination, gold foil logo on lid', lines: [{ product: PR.mithai, desc: 'Mithai box 1 kg, foil logo', qty: 10000, price: q1.tiers.find((t) => t.qty === 10000).unit_price, cost: q1.tiers.find((t) => t.qty === 10000).unit_cost, specs: '230 × 180 × 70 mm · SBS 350 gsm · 4+0 · matte lam · gold foil' }] });
    pay(P.crescent, day(-27), 100000, 'Cheque', 'MCB chq 004512', { order: o2.id });
    const j2 = job(o2, 0, 10000, day(-25), { machine: 'Heidelberg SM 102', due: day(-9) });
    consume(j2, day(-25), M.sbs350, 5300); consume(j2, day(-25), M.inkcmyk, 14); consume(j2, day(-23), M.matlam, 3); consume(j2, day(-22), M.goldfoil, 2); consume(j2, day(-20), M.pva, 26);
    produce(j2, day(-24), 6000, 'printing'); produce(j2, day(-22), 4300, 'finishing', 'Lamination and foil done in one pass');
    qc(j2, day(-19), 6000, 120); qc(j2, day(-16), 4000, 90);
    const d2a = deliver(o2, day(-15), [[0, 6000, '60 cartons']], { received: 'Hamza Qureshi' });
    const d2b = deliver(o2, day(-8), [[0, 4000, '40 cartons']], { received: 'Gate, Gulberg outlet' });
    const i2a = invoice(o2, day(-15), [[0, 6000]], 30, d2a);
    invoice(o2, day(-8), [[0, 4000]], 30, d2b);
    pay(P.crescent, day(-5), 90000, 'Bank transfer', 'Meezan IBFT 77810', { alloc: [{ target_id: i2a, amount: 90000 }] });

    // 3) Ravi Pharma cartons: in production, partial delivery and partial invoice.
    const o3 = order({ customer: P.ravi, quote: q2.id, po: 'RPL/PKG/0931', date: day(-19), due: day(4), priority: 'high', lines: [{ product: PR.pharma, desc: 'Tablet carton 10×10 blister', qty: 50000, price: q2.tiers.find((t) => t.qty === 50000).unit_price, cost: q2.tiers.find((t) => t.qty === 50000).unit_cost, specs: 'Blank batch/expiry panel 30×15 mm' }] });
    const j3 = job(o3, 0, 50000, day(-17), { machine: 'Komori 2-colour', due: day(2), specs: 'Leave blank batch/expiry panel. Gloss varnish overall.' });
    consume(j3, day(-17), M.dup300, 4300); consume(j3, day(-16), M.inkcmyk, 8);
    produce(j3, day(-15), 20000, 'printing'); produce(j3, day(-11), 12000, 'diecutting');
    qc(j3, day(-10), 19600, 400); qc(j3, day(-4), 10400, 300);
    const d3 = deliver(o3, day(-9), [[0, 19500, '39 cartons × 500']], { received: 'QC officer, Ravi Pharma' });
    invoice(o3, day(-9), [[0, 19500]], 45, d3);
    // further production logged today, awaiting QC
    produce(j3, day(0), 6000, 'pasting', 'Second shift');

    // 4) Green Valley export cartons: in QC.
    const o4 = order({ customer: P.greenvalley, po: 'GVF-EXP-221', date: day(-11), due: day(2), lines: [{ product: PR.export, desc: '5-ply export carton 600×400×400', qty: 1200, price: 235, cost: 179 }] });
    const j4 = job(o4, 0, 1200, day(-9), { machine: 'Corrugator + flexo', due: day(1) });
    consume(j4, day(-9), M.kraft150, 1300); consume(j4, day(-9), M.flute120, 950); consume(j4, day(-8), M.inkflexo, 12);
    produce(j4, day(-6), 800, 'printing'); produce(j4, day(-3), 420, 'diecutting');
    qc(j4, day(-2), 700, 20);

    // 5) Noor labels: ready for dispatch, deadline already passed.
    const o5 = order({ customer: P.noor, po: 'NC-PO-77', date: day(-30), due: day(-3), lines: [{ product: PR.label, desc: 'Cream jar wrap label', qty: 20000, price: 2.1, cost: 1.35 }] });
    const j5 = job(o5, 0, 20000, day(-24), { machine: 'Digital press' });
    consume(j5, day(-24), M.art130, 9);
    produce(j5, day(-22), 20400, 'finishing');
    qc(j5, day(-20), 20000, 400);

    // 6) Indus Tea pouches: confirmed, advance received, job queued.
    const o6 = order({ customer: P.indus, quote: q3.id, po: 'ITH-2026-14', date: day(-6), due: day(12), lines: [{ product: PR.teapouch, desc: 'Tea pouch 250 g with zip', qty: 30000, price: q3.tiers.find((t) => t.qty === 30000).unit_price, cost: q3.tiers.find((t) => t.qty === 30000).unit_cost }] });
    pay(P.indus, day(-5), 150000, 'Bank transfer', 'UBL IBFT 66231', { order: o6.id });
    job(o6, 0, 30000, day(-5), { machine: 'Rotogravure 8-colour', due: day(9) });

    // 7) BondTech: stock items from the shelf, delivered same day, invoice unpaid.
    const o7 = order({ customer: P.bondtech, po: 'BT-554', date: day(-14), due: day(-10), lines: [{ product: PR.tray, desc: 'Chocolate tray insert 12 cavity', qty: 800, price: 9, cost: 5.9 }] });
    const d7 = deliver(o7, day(-12), [[0, 800, '8 bundles']], { received: 'Naveed Anjum' });
    invoice(o7, day(-12), [[0, 800]], 10, d7);

    // supplier payments
    pay(P.shalimar, day(-25), 300000, 'Bank transfer', 'TT 88123', { out: true, alloc: [{ target_id: pur1, amount: 300000 }] });
    pay(P.colourmax, day(-10), get('SELECT total FROM purchases WHERE id = ?', pur3).total, 'Cheque', 'chq 100231', { out: true, alloc: [{ target_id: pur3, amount: get('SELECT total FROM purchases WHERE id = ?', pur3).total }] });

    // expenses across the last two months
    const exp = (d, category, description, amount, method = 'Bank transfer') => insert('expenses', { number: nextNumber('EXP', d), date: d, category, description, amount, method, user_id: by('accounts'), is_sample: S, created_at: ts(d) });
    exp(day(-58), 'Rent', 'Factory rent', 350000); exp(day(-28), 'Rent', 'Factory rent', 350000);
    exp(day(-55), 'Electricity', 'LESCO bill', 412000); exp(day(-25), 'Electricity', 'LESCO bill', 438500);
    exp(day(-52), 'Gas', 'SNGPL bill', 68000); exp(day(-22), 'Gas', 'SNGPL bill', 71200);
    exp(day(-31), 'Salaries & wages', 'Monthly payroll', 1650000); exp(day(-1), 'Salaries & wages', 'Monthly payroll', 1690000);
    exp(day(-44), 'Machine maintenance', 'Heidelberg rollers re-covered', 145000); exp(day(-13), 'Machine maintenance', 'Die-cutter blade set', 38000, 'Cash');
    exp(day(-26), 'Plates & dies', 'CTP plates (24)', 52000); exp(day(-18), 'Plates & dies', 'Die for 10×10 carton', 26000, 'Cash');
    exp(day(-33), 'Transport & fuel', 'Diesel for delivery van', 42000, 'Cash'); exp(day(-7), 'Transport & fuel', 'Diesel for delivery van', 39500, 'Cash');
    exp(day(-3), 'Office', 'Printer toner & stationery', 9800, 'Cash');

    for (const o of [o1, o2, o3, o4, o5, o6, o7]) recomputeOrderStatus(o.id);
    recomputeInvoice(i1);

    insert('activity', { ts: now(), user_id: adminId, user_name: 'System', action: 'loaded sample data', entity: 'system', label: 'Sample data for training and testing' });
  });
}

module.exports = { seed };
