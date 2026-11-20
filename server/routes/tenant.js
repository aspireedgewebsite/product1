// Restaurant-side API: branches, staff, menu, tables, orders/KOT/KDS, billing, refunds, growth modules, reports.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { q } = require('../db');
const { authenticate, requireTenant, requirePerm, hash, can } = require('../auth');
const F = require('../features');
const rt = require('../lib/rt');
const B = require('../lib/billing');
const RZ = require('../lib/razorpay');
const { requireFeature: need } = F;

const r = express.Router();
r.use(authenticate, requireTenant);

const uploadsDir = (tid) => path.join(__dirname, '..', '..', 'data', 'uploads', String(tid));

// Resolve branch: owners may choose any of their branches (or 'all' for reports); others are pinned to theirs.
function branchOf(req, allowAll = false) {
  const asked = req.query.branch_id ?? req.body?.branch_id;
  if (req.user.role === 'owner' && asked) {
    if (asked === 'all' && allowAll) return 'all';
    const b = q.get('SELECT id FROM branches WHERE id=? AND tenant_id=?', +asked, req.user.tenant_id);
    if (b) return b.id;
  }
  return req.user.branch_id || q.get('SELECT id FROM branches WHERE tenant_id=? ORDER BY id LIMIT 1', req.user.tenant_id)?.id;
}
const T = (req) => req.user.tenant_id;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const tenantOnly = (table) => (id, tid) => q.get(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`, id, tid);

// ---------- branches & staff ----------
r.get('/branches', (req, res) => res.json(q.all('SELECT * FROM branches WHERE tenant_id=?', T(req))));
r.post('/branches', requirePerm('*'), (req, res) => {
  if (!req.body?.name) return bad(res, 'name required');
  const n = q.get('SELECT COUNT(*) c FROM branches WHERE tenant_id=?', T(req)).c;
  if (!F.withinLimit(T(req), 'branches', n)) return bad(res, 'Branch limit reached for your plan. Upgrade to add more.', 403);
  const id = +q.run('INSERT INTO branches(tenant_id,name,address) VALUES (?,?,?)', T(req), req.body.name, req.body.address).lastInsertRowid;
  q.audit(T(req), req.user.id, 'branch.create', 'branch', id, req.body.name);
  res.json({ id });
});

r.get('/users', requirePerm('staff_view'), (req, res) => res.json(
  q.all('SELECT id,name,email,role,branch_id,active,available FROM users WHERE tenant_id=? ORDER BY id', T(req))));
r.post('/users', requirePerm('*'), (req, res) => {
  const b = req.body || {};
  const roles = ['manager', 'cashier', 'waiter', 'kitchen'];
  if (!b.name || !b.email || !b.password || !roles.includes(b.role)) return bad(res, 'name, email, password and role (manager/cashier/waiter/kitchen) required');
  if (b.password.length < 6) return bad(res, 'Password must be at least 6 characters');
  const kind = b.role === 'manager' ? 'managers' : 'staff';
  const used = b.role === 'manager'
    ? q.get("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND role='manager'", T(req)).c
    : q.get("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND role IN ('cashier','waiter','kitchen')", T(req)).c;
  if (!F.withinLimit(T(req), kind, used)) return bad(res, `${kind === 'managers' ? 'Manager' : 'Staff'} limit reached for your plan.`, 403);
  if (q.get('SELECT id FROM users WHERE email=?', b.email.toLowerCase())) return bad(res, 'Email already in use', 409);
  const branch = branchOf(req);
  const id = +q.run('INSERT INTO users(tenant_id,name,email,password_hash,role,branch_id) VALUES (?,?,?,?,?,?)', T(req), b.name, b.email.toLowerCase(), hash(b.password), b.role, branch).lastInsertRowid;
  q.audit(T(req), req.user.id, 'user.create', 'user', id, `${b.role} ${b.email}`);
  res.json({ id });
});
r.patch('/users/:id', (req, res) => {
  const u = tenantOnly('users')(+req.params.id, T(req));
  if (!u || u.role === 'owner') return bad(res, 'Not found', 404);
  // owner edits anything; managers may only flip waiter availability
  if (req.user.role === 'owner') {
    if (req.body.active !== undefined) q.run('UPDATE users SET active=? WHERE id=?', +!!req.body.active, u.id);
    if (req.body.password) q.run('UPDATE users SET password_hash=? WHERE id=?', hash(req.body.password), u.id);
  } else if (!can(req.user.role, 'tables')) return bad(res, 'Your role cannot do this', 403);
  if (req.body.available !== undefined) q.run('UPDATE users SET available=? WHERE id=?', +!!req.body.available, u.id);
  q.audit(T(req), req.user.id, 'user.update', 'user', u.id, req.body);
  res.json({ ok: true });
});

// ---------- settings ----------
r.get('/settings', requirePerm('*'), (req, res) => {
  const t = q.get('SELECT name,gstin,address,razorpay_key_id FROM tenants WHERE id=?', T(req));
  res.json({ ...t, has_secret: !!q.get('SELECT razorpay_key_secret s FROM tenants WHERE id=?', T(req)).s });
});
r.put('/settings', requirePerm('*'), (req, res) => {
  const b = req.body || {};
  q.run('UPDATE tenants SET name=COALESCE(?,name), gstin=?, address=? WHERE id=?', b.name, b.gstin, b.address, T(req));
  if (b.razorpay_key_id !== undefined) {
    if (!F.hasFeature(T(req), 'own_gateway')) return bad(res, 'Own payment gateway is not part of your plan', 403);
    q.run('UPDATE tenants SET razorpay_key_id=? WHERE id=?', b.razorpay_key_id || null, T(req));
    if (b.razorpay_key_secret) q.run('UPDATE tenants SET razorpay_key_secret=? WHERE id=?', b.razorpay_key_secret, T(req));
  }
  q.audit(T(req), req.user.id, 'settings.update', 'tenant', T(req), { name: b.name, gstin: b.gstin });
  res.json({ ok: true });
});

// ---------- menu ----------
r.get('/menu', (req, res) => {
  const bid = branchOf(req);
  res.json({
    categories: q.all('SELECT * FROM categories WHERE tenant_id=? AND branch_id=? ORDER BY id', T(req), bid),
    items: q.all('SELECT * FROM menu_items WHERE tenant_id=? AND branch_id=? ORDER BY category_id, name', T(req), bid).map((i) => ({ ...i, addons: JSON.parse(i.addons || '[]') })),
  });
});
r.post('/menu/categories', need('menu'), requirePerm('menu'), (req, res) => {
  if (!req.body?.name) return bad(res, 'name required');
  const id = +q.run('INSERT INTO categories(tenant_id,branch_id,name) VALUES (?,?,?)', T(req), branchOf(req), req.body.name).lastInsertRowid;
  res.json({ id });
});
r.delete('/menu/categories/:id', need('menu'), requirePerm('menu'), (req, res) => {
  q.run('UPDATE menu_items SET category_id=NULL WHERE category_id=? AND tenant_id=?', +req.params.id, T(req));
  q.run('DELETE FROM categories WHERE id=? AND tenant_id=?', +req.params.id, T(req)); res.json({ ok: true });
});
function itemFields(b) {
  return [b.name, b.description || '', +b.price, +!!b.veg, b.gst_rate === undefined ? 5 : +b.gst_rate,
    JSON.stringify((b.addons || []).filter((a) => a.name).map((a) => ({ name: String(a.name), price: +a.price || 0 }))), b.available_from || null, b.available_to || null];
}
r.post('/menu/items', need('menu'), requirePerm('menu'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !(+b.price >= 0) || b.price === '' || b.price === undefined) return bad(res, 'name and price required');
  const id = +q.run(`INSERT INTO menu_items(tenant_id,branch_id,category_id,name,description,price,veg,gst_rate,addons,available_from,available_to) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    T(req), branchOf(req), b.category_id || null, ...itemFields(b)).lastInsertRowid;
  q.audit(T(req), req.user.id, 'menu.create', 'item', id, b.name);
  res.json({ id });
});
r.put('/menu/items/:id', need('menu'), requirePerm('menu'), (req, res) => {
  const it = tenantOnly('menu_items')(+req.params.id, T(req)); if (!it) return bad(res, 'Not found', 404);
  const b = { ...it, ...req.body, addons: req.body.addons ?? JSON.parse(it.addons) };
  q.run('UPDATE menu_items SET category_id=?, name=?, description=?, price=?, veg=?, gst_rate=?, addons=?, available_from=?, available_to=? WHERE id=?',
    b.category_id || null, ...itemFields(b), it.id);
  q.audit(T(req), req.user.id, 'menu.update', 'item', it.id, { price: b.price });
  res.json({ ok: true });
});
r.delete('/menu/items/:id', need('menu'), requirePerm('menu'), (req, res) => {
  q.run('DELETE FROM menu_items WHERE id=? AND tenant_id=?', +req.params.id, T(req)); res.json({ ok: true });
});
// One-switch "sold out": hides the dish on every QR menu immediately.
r.post('/menu/items/:id/available', requirePerm('soldout'), (req, res) => {
  const it = tenantOnly('menu_items')(+req.params.id, T(req)); if (!it) return bad(res, 'Not found', 404);
  q.run('UPDATE menu_items SET available=? WHERE id=?', +!!req.body.available, it.id);
  rt.emit(T(req), it.branch_id, 'menu:changed', { item_id: it.id, available: !!req.body.available });
  res.json({ ok: true });
});
// Bulk import: CSV text with header "category,name,price,veg,gst_rate" (Excel -> Save as CSV)
r.post('/menu/import', need('menu'), requirePerm('menu'), (req, res) => {
  const lines = String(req.body?.csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return bad(res, 'CSV needs a header row and at least one item');
  const cols = lines[0].toLowerCase().split(',').map((s) => s.trim());
  for (const need_ of ['name', 'price']) if (!cols.includes(need_)) return bad(res, `Missing column: ${need_}`);
  const bid = branchOf(req); let added = 0; const errors = [];
  q.tx(() => lines.slice(1).forEach((ln, idx) => {
    const v = ln.split(',').map((s) => s.trim()); const row = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    if (!row.name || isNaN(+row.price)) { errors.push(`Row ${idx + 2}: invalid name/price`); return; }
    let cid = null;
    if (row.category) {
      cid = q.get('SELECT id FROM categories WHERE tenant_id=? AND branch_id=? AND name=?', T(req), bid, row.category)?.id
        || +q.run('INSERT INTO categories(tenant_id,branch_id,name) VALUES (?,?,?)', T(req), bid, row.category).lastInsertRowid;
    }
    q.run('INSERT INTO menu_items(tenant_id,branch_id,category_id,name,price,veg,gst_rate) VALUES (?,?,?,?,?,?,?)', T(req), bid, cid, row.name, +row.price,
      /^(0|n|no|nonveg|non-veg)$/i.test(row.veg || '1') ? 0 : 1, row.gst_rate === undefined || row.gst_rate === '' ? 5 : +row.gst_rate);
    added++;
  }));
  res.json({ added, errors });
});
// Photo upload (base64 JSON) with per-plan storage quota
r.post('/menu/items/:id/image', need('menu'), requirePerm('menu'), (req, res) => {
  const it = tenantOnly('menu_items')(+req.params.id, T(req)); if (!it) return bad(res, 'Not found', 404);
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(req.body?.data || '');
  if (!m) return bad(res, 'Send a PNG, JPEG or WebP data URL');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return bad(res, 'Image must be under 2 MB');
  const dir = uploadsDir(T(req)); fs.mkdirSync(dir, { recursive: true });
  const used = fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
  const quota = F.resolve(T(req)).limits.storage_mb * 1024 * 1024;
  if (used + buf.length > quota) return bad(res, 'Storage quota exceeded for your plan', 403);
  const file = `item${it.id}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(dir, file), buf);
  q.run('UPDATE menu_items SET image_path=? WHERE id=?', `/uploads/${T(req)}/${file}`, it.id);
  res.json({ path: `/uploads/${T(req)}/${file}` });
});
r.get('/storage', (req, res) => {
  const dir = uploadsDir(T(req)); const used = fs.existsSync(dir) ? fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) : 0;
  res.json({ used_mb: Math.round(used / 1048576 * 100) / 100, quota_mb: F.resolve(T(req)).limits.storage_mb });
});

// ---------- tables ----------
const qrToken = () => require('crypto').randomBytes(9).toString('hex');
r.get('/tables', (req, res) => {
  const bid = branchOf(req);
  res.json(q.all(`SELECT t.*, u.name AS waiter_name,
    (SELECT id FROM orders o WHERE o.table_id=t.id AND o.invoice_id IS NULL ORDER BY id DESC LIMIT 1) AS open_order_id
    FROM tables_ t LEFT JOIN users u ON u.id=t.waiter_id WHERE t.tenant_id=? AND t.branch_id=? ORDER BY t.id`, T(req), bid));
});
r.post('/tables', requirePerm('tables'), (req, res) => {
  const bid = branchOf(req);
  const names = req.body?.names ? String(req.body.names).split(',').map((s) => s.trim()).filter(Boolean) : [req.body?.name].filter(Boolean);
  if (!names.length) return bad(res, 'name required');
  const n = q.get('SELECT COUNT(*) c FROM tables_ WHERE tenant_id=?', T(req)).c;
  if (!F.resolve(T(req)).limits.tables || n + names.length > F.resolve(T(req)).limits.tables) return bad(res, 'Table limit reached for your plan.', 403);
  names.forEach((nm) => q.run('INSERT INTO tables_(tenant_id,branch_id,name,qr_token) VALUES (?,?,?,?)', T(req), bid, nm, qrToken()));
  res.json({ added: names.length });
});
r.delete('/tables/:id', requirePerm('tables'), (req, res) => {
  const t = tenantOnly('tables_')(+req.params.id, T(req)); if (!t) return bad(res, 'Not found', 404);
  if (q.get('SELECT id FROM orders WHERE table_id=? AND invoice_id IS NULL', t.id)) return bad(res, 'Table has an open order');
  q.run('DELETE FROM tables_ WHERE id=?', t.id); res.json({ ok: true });
});
r.post('/tables/:id/waiter', requirePerm('tables'), (req, res) => {
  const t = tenantOnly('tables_')(+req.params.id, T(req)); if (!t) return bad(res, 'Not found', 404);
  const w = req.body.waiter_id ? q.get("SELECT id FROM users WHERE id=? AND tenant_id=? AND role='waiter'", req.body.waiter_id, T(req)) : null;
  if (req.body.waiter_id && !w) return bad(res, 'Waiter not found');
  q.run('UPDATE tables_ SET waiter_id=? WHERE id=?', w?.id || null, t.id);
  q.audit(T(req), req.user.id, 'table.assign_waiter', 'table', t.id, req.body); rt.emit(T(req), t.branch_id, 'tables:changed');
  res.json({ ok: true });
});
// Transfer open order to a free table, or merge into another table's open order.
r.post('/tables/:id/transfer', requirePerm('tables'), (req, res) => {
  const from = tenantOnly('tables_')(+req.params.id, T(req)), to = tenantOnly('tables_')(+req.body.to_table_id, T(req));
  if (!from || !to || from.id === to.id || from.branch_id !== to.branch_id) return bad(res, 'Invalid tables');
  const src = q.get('SELECT * FROM orders WHERE table_id=? AND invoice_id IS NULL ORDER BY id DESC LIMIT 1', from.id);
  if (!src) return bad(res, 'Source table has no open order');
  const dst = q.get('SELECT * FROM orders WHERE table_id=? AND invoice_id IS NULL ORDER BY id DESC LIMIT 1', to.id);
  q.tx(() => {
    if (dst) { // merge
      q.run('UPDATE order_items SET order_id=? WHERE order_id=?', dst.id, src.id);
      q.run("UPDATE orders SET status='cancelled', invoice_id=-1 WHERE id=?", src.id);
      q.run("UPDATE orders SET status='new', updated_at=CURRENT_TIMESTAMP WHERE id=?", dst.id);
    } else q.run('UPDATE orders SET table_id=? WHERE id=?', to.id, src.id);
    q.run("UPDATE tables_ SET status='free' WHERE id=?", from.id); q.run("UPDATE tables_ SET status='occupied' WHERE id=?", to.id);
    q.audit(T(req), req.user.id, dst ? 'table.merge' : 'table.transfer', 'order', src.id, { from: from.name, to: to.name });
  });
  rt.emitOrder(T(req), from.branch_id, src.id); rt.emit(T(req), from.branch_id, 'tables:changed');
  res.json({ ok: true, merged: !!dst });
});
r.post('/tables/:id/clear', requirePerm('tables'), (req, res) => {
  const t = tenantOnly('tables_')(+req.params.id, T(req)); if (!t) return bad(res, 'Not found', 404);
  const open = q.get('SELECT id FROM orders WHERE table_id=? AND invoice_id IS NULL', t.id);
  if (open) { // cancel an unbilled order (manager action, audited)
    if (!can(req.user.role, 'refunds') && req.user.role !== 'owner') return bad(res, 'Only a manager can clear a table with an open order', 403);
    q.run("UPDATE orders SET status='cancelled', invoice_id=-1 WHERE table_id=? AND invoice_id IS NULL", t.id);
    q.audit(T(req), req.user.id, 'table.clear_open_order', 'table', t.id, t.name);
  }
  q.run("UPDATE tables_ SET status='free' WHERE id=?", t.id);
  rt.emit(T(req), t.branch_id, 'tables:changed'); rt.emitOrder(T(req), t.branch_id, open?.id);
  res.json({ ok: true });
});

// ---------- orders ----------
function hydrate(o) {
  const items = q.all('SELECT * FROM order_items WHERE order_id=? ORDER BY id', o.id).map((i) => ({ ...i, addons: JSON.parse(i.addons || '[]'), line: B.lineTotal(i) }));
  const live = items.filter((i) => !i.deleted);
  const tbl = o.table_id ? q.get('SELECT name, waiter_id FROM tables_ WHERE id=?', o.table_id) : null;
  return { ...o, table_name: tbl?.name || null, waiter_id: tbl?.waiter_id || null, items, bill: B.computeBill(live, 0) };
}
const getOrder = (id, tid) => q.get('SELECT * FROM orders WHERE id=? AND tenant_id=?', id, tid);

/** Shared by POS and QR. Adds to the table's open order if there is one. */
function placeOrder({ tenantId, branchId, tableId, type, source, items, customer_name, customer_phone, client_id, userId }) {
  if (client_id) { const ex = q.get('SELECT o.* FROM client_ops c JOIN orders o ON o.id=c.order_id WHERE c.client_id=? AND o.tenant_id=?', client_id, tenantId); if (ex) return { order: ex, duplicate: true }; }
  if (!Array.isArray(items) || !items.length) return { error: 'Add at least one item' };
  const rows = [];
  const hhmm = new Date().toTimeString().slice(0, 5);
  for (const it of items) {
    const m = q.get('SELECT * FROM menu_items WHERE id=? AND tenant_id=? AND branch_id=?', it.item_id, tenantId, branchId);
    if (!m) return { error: 'Unknown menu item' };
    if (!m.available) return { error: `${m.name} is sold out` };
    if (m.available_from && m.available_to && (hhmm < m.available_from || hhmm > m.available_to)) return { error: `${m.name} is available ${m.available_from}–${m.available_to} only` };
    const qty = Math.floor(+it.qty); if (!(qty >= 1 && qty <= 99)) return { error: 'Invalid quantity' };
    const menuAddons = JSON.parse(m.addons || '[]');
    const chosen = (it.addons || []).map((n) => menuAddons.find((a) => a.name === n)).filter(Boolean);
    rows.push({ m, qty, note: String(it.note || '').slice(0, 200), addons: JSON.stringify(chosen) });
  }
  const table = tableId ? q.get('SELECT * FROM tables_ WHERE id=? AND tenant_id=? AND branch_id=?', tableId, tenantId, branchId) : null;
  if (type === 'dine_in' && !table) return { error: 'Choose a table for dine-in' };
  return q.tx(() => {
    let order = table ? q.get('SELECT * FROM orders WHERE table_id=? AND invoice_id IS NULL ORDER BY id DESC LIMIT 1', table.id) : null;
    if (!order) {
      const token = type === 'takeaway' ? (q.get("SELECT COALESCE(MAX(token),0) m FROM orders WHERE tenant_id=? AND branch_id=? AND type='takeaway' AND date(created_at)=date('now')", tenantId, branchId).m + 1) : null;
      const id = +q.run('INSERT INTO orders(tenant_id,branch_id,table_id,type,source,token,customer_name,customer_phone,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
        tenantId, branchId, table?.id, type, source, token, customer_name, customer_phone, userId).lastInsertRowid;
      order = q.get('SELECT * FROM orders WHERE id=?', id);
    } else {
      q.run("UPDATE orders SET status='new', updated_at=CURRENT_TIMESTAMP, customer_phone=COALESCE(customer_phone,?), customer_name=COALESCE(customer_name,?) WHERE id=?", customer_phone, customer_name, order.id);
    }
    for (const x of rows) q.run('INSERT INTO order_items(order_id,item_id,name,price,gst_rate,qty,note,addons) VALUES (?,?,?,?,?,?,?,?)', order.id, x.m.id, x.m.name, x.m.price, x.m.gst_rate, x.qty, x.note, x.addons);
    if (table) q.run("UPDATE tables_ SET status='occupied' WHERE id=?", table.id);
    if (client_id) q.run('INSERT INTO client_ops(client_id,order_id) VALUES (?,?)', client_id, order.id);
    return { order: q.get('SELECT * FROM orders WHERE id=?', order.id) };
  });
}

r.post('/orders', need('pos'), requirePerm('pos'), (req, res) => {
  const b = req.body || {};
  const bid = branchOf(req);
  const type = b.type === 'takeaway' ? 'takeaway' : 'dine_in';
  const out = placeOrder({ tenantId: T(req), branchId: bid, tableId: b.table_id, type, source: 'pos', items: b.items, customer_name: b.customer_name, customer_phone: b.customer_phone, client_id: b.client_id, userId: req.user.id });
  if (out.error) return bad(res, out.error);
  q.audit(T(req), req.user.id, out.duplicate ? 'order.replay' : 'order.items_added', 'order', out.order.id, { n: b.items?.length });
  rt.emitOrder(T(req), bid, out.order.id); rt.emit(T(req), bid, 'tables:changed');
  res.json(hydrate(out.order));
});
r.get('/orders', requirePerm('orders'), (req, res) => {
  const bid = branchOf(req); const open = req.query.open !== '0';
  const rows = q.all(`SELECT * FROM orders WHERE tenant_id=? AND branch_id=? AND ${open ? 'invoice_id IS NULL' : 'invoice_id IS NOT NULL AND invoice_id > 0'} ORDER BY id DESC LIMIT 100`, T(req), bid);
  res.json(rows.map(hydrate));
});
r.get('/orders/:id', requirePerm('orders'), (req, res) => {
  const o = getOrder(+req.params.id, T(req)); if (!o) return bad(res, 'Not found', 404); res.json(hydrate(o));
});
// Kitchen display: active tickets (New -> Preparing -> Ready)
r.get('/kds', need('kds'), requirePerm('kds'), (req, res) => {
  const bid = branchOf(req);
  const rows = q.all("SELECT * FROM orders WHERE tenant_id=? AND branch_id=? AND status IN ('new','preparing','ready') ORDER BY id", T(req), bid);
  res.json(rows.map((o) => ({ ...hydrate(o), age_sec: Math.floor((Date.now() - new Date(o.created_at.replace(' ', 'T') + 'Z')) / 1000) })));
});
r.post('/orders/:id/status', requirePerm('kds'), (req, res) => {
  const o = getOrder(+req.params.id, T(req)); if (!o) return bad(res, 'Not found', 404);
  const flow = { new: ['preparing'], preparing: ['ready'], ready: ['served'] };
  const s = req.body?.status;
  if (!(flow[o.status] || []).includes(s)) return bad(res, `Cannot move from ${o.status} to ${s}`);
  q.run('UPDATE orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', s, o.id);
  q.audit(T(req), req.user.id, 'order.status', 'order', o.id, `${o.status} -> ${s}`);
  rt.emitOrder(T(req), o.branch_id, o.id);
  if (s === 'ready') { const h = hydrate(o); rt.emit(T(req), o.branch_id, 'order:ready', { order_id: o.id, table: h.table_name, token: o.token, waiter_id: h.waiter_id }); }
  res.json({ ok: true });
});
// Remove / restore an item (audited). Billed orders are locked.
r.post('/orders/:id/items/:itemId/delete', requirePerm('orders'), (req, res) => {
  const o = getOrder(+req.params.id, T(req)); if (!o || o.invoice_id) return bad(res, 'Order not editable');
  if (!['owner', 'manager'].includes(req.user.role) && o.status !== 'new') return bad(res, 'Only a manager can remove items once the kitchen has started', 403);
  q.run('UPDATE order_items SET deleted=? WHERE id=? AND order_id=?', +!req.body.restore, +req.params.itemId, o.id);
  q.audit(T(req), req.user.id, req.body.restore ? 'order.item_restore' : 'order.item_delete', 'order', o.id, { item: +req.params.itemId });
  rt.emitOrder(T(req), o.branch_id, o.id); res.json(hydrate(getOrder(o.id, T(req))));
});
r.post('/orders/:id/preview-bill', requirePerm('orders'), (req, res) => {
  const o = getOrder(+req.params.id, T(req)); if (!o) return bad(res, 'Not found', 404);
  const items = B.orderItems(o.id); const sub = B.computeBill(items, 0).subtotal;
  const cd = B.couponDiscount(T(req), req.body?.coupon_code, sub);
  if (cd.error) return bad(res, cd.error);
  let coins = 0;
  if (req.body?.coins > 0 && o.customer_phone && F.hasFeature(T(req), 'loyalty')) {
    const c = q.get('SELECT coins FROM customers WHERE tenant_id=? AND phone=?', T(req), o.customer_phone);
    coins = Math.max(0, Math.min(Math.floor(req.body.coins), c?.coins || 0, Math.floor(sub - cd.discount)));
  }
  res.json({ ...B.computeBill(items, cd.discount + coins), coins_used: coins });
});
r.post('/orders/:id/bill', need('pos'), requirePerm('pos'), (req, res) => {
  const o = getOrder(+req.params.id, T(req)); if (!o) return bad(res, 'Not found', 404);
  const method = ['cash', 'card', 'upi'].includes(req.body?.payment_method) ? req.body.payment_method : null;
  if (!method) return bad(res, 'payment_method must be cash, card or upi');
  const inv = B.createInvoice(o, { method, couponCode: req.body.coupon_code, coins: +req.body.coins || 0, userId: req.user.id });
  if (inv.error) return bad(res, inv.error);
  rt.emitOrder(T(req), o.branch_id, o.id); rt.emit(T(req), o.branch_id, 'tables:changed');
  res.json(inv);
});

// ---------- invoices, printing, refunds ----------
r.get('/invoices', requirePerm('orders'), (req, res) => {
  const bid = branchOf(req, true);
  const rows = bid === 'all'
    ? q.all('SELECT * FROM invoices WHERE tenant_id=? ORDER BY id DESC LIMIT 200', T(req))
    : q.all('SELECT * FROM invoices WHERE tenant_id=? AND branch_id=? ORDER BY id DESC LIMIT 200', T(req), bid);
  res.json(rows);
});
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const thermalCss = `<style>@page{size:80mm auto;margin:3mm}body{font:12px/1.35 monospace;width:74mm;margin:0 auto}h1,h2{text-align:center;margin:2px 0}h1{font-size:15px}
table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}.r{text-align:right}hr{border:0;border-top:1px dashed #000}.c{text-align:center}.b{font-weight:bold}</style>`;
// 80mm thermal-friendly KOT and bill. Use browser print (network/USB thermal printers appear as system printers).
r.get('/orders/:id/kot', (req, res) => {
  const o = getOrder(+req.params.id, T(req)); if (!o) return res.status(404).send('Not found');
  const h = hydrate(o);
  res.type('html').send(`<!doctype html><meta charset=utf-8><title>KOT</title>${thermalCss}<h1>KOT #${o.id}</h1><div class=c>${h.table_name ? 'Table ' + esc(h.table_name) : 'Takeaway token ' + o.token} · ${esc(o.created_at)}</div><hr><table>
${h.items.filter((i) => !i.deleted).map((i) => `<tr><td class=b>${i.qty} x ${esc(i.name)}${i.addons.length ? '<br>+ ' + esc(i.addons.map((a) => a.name).join(', ')) : ''}${i.note ? '<br>* ' + esc(i.note) : ''}</td></tr>`).join('')}</table><hr><script>print()</script>`);
});
r.get('/invoices/:id/print', (req, res) => {
  const inv = q.get('SELECT * FROM invoices WHERE id=? AND tenant_id=?', +req.params.id, T(req)); if (!inv) return res.status(404).send('Not found');
  const t = q.get('SELECT name,gstin,address FROM tenants WHERE id=?', T(req));
  const br = q.get('SELECT name,address FROM branches WHERE id=?', inv.branch_id);
  const items = B.orderItems(inv.order_id);
  const cns = q.all('SELECT * FROM credit_notes WHERE invoice_id=?', inv.id);
  res.type('html').send(`<!doctype html><meta charset=utf-8><title>${esc(inv.number)}</title>${thermalCss}<h1>${esc(t.name)}</h1><div class=c>${esc(br?.name)}${br?.address ? ', ' + esc(br.address) : ''}<br>${t.gstin ? 'GSTIN: ' + esc(t.gstin) : ''}</div><hr>
<div>Invoice: ${esc(inv.number)}<br>Date: ${esc(inv.created_at)}</div><hr><table>
${items.map((i) => `<tr><td>${i.qty} x ${esc(i.name)}</td><td class=r>${B.lineTotal(i).toFixed(2)}</td></tr>`).join('')}</table><hr><table>
<tr><td>Subtotal</td><td class=r>${inv.subtotal.toFixed(2)}</td></tr>${inv.discount ? `<tr><td>Discount</td><td class=r>-${inv.discount.toFixed(2)}</td></tr>` : ''}
<tr><td>CGST</td><td class=r>${inv.cgst.toFixed(2)}</td></tr><tr><td>SGST</td><td class=r>${inv.sgst.toFixed(2)}</td></tr>
<tr class=b><td>TOTAL</td><td class=r>₹${inv.total.toFixed(2)}</td></tr></table><hr>
<div class=c>Paid by ${esc(inv.payment_method)}${inv.refunded ? '<br>Refunded ₹' + inv.refunded.toFixed(2) : ''}</div>
${cns.map((c) => `<div class=c>Credit note ${esc(c.number)}: ₹${c.amount.toFixed(2)}</div>`).join('')}<div class=c>Thank you! Visit again.</div><script>print()</script>`);
});
r.post('/invoices/:id/refund', need('refunds'), requirePerm('refunds'), async (req, res) => {
  const inv = q.get('SELECT * FROM invoices WHERE id=? AND tenant_id=?', +req.params.id, T(req)); if (!inv) return bad(res, 'Not found', 404);
  const amount = B.r2(+req.body?.amount);
  if (!(amount > 0) || amount > B.r2(inv.total - inv.refunded)) return bad(res, `Refund must be between 0.01 and ${B.r2(inv.total - inv.refunded)}`);
  if (!req.body?.reason) return bad(res, 'Reason required');
  try { if (inv.payment_method === 'online') await RZ.refund(T(req), inv.razorpay_payment_id, amount); }
  catch (e) { return bad(res, e.message, 502); }
  const out = q.tx(() => {
    const n = q.get('SELECT COUNT(*) c FROM credit_notes WHERE tenant_id=?', T(req)).c + 1;
    const number = `CN/${String(n).padStart(5, '0')}`;
    q.run('INSERT INTO credit_notes(tenant_id,invoice_id,number,amount,reason,created_by) VALUES (?,?,?,?,?,?)', T(req), inv.id, number, amount, req.body.reason, req.user.id);
    const total = B.r2(inv.refunded + amount);
    q.run('UPDATE invoices SET refunded=?, payment_status=? WHERE id=?', total, total >= inv.total ? 'refunded' : 'partial_refund', inv.id);
    q.audit(T(req), req.user.id, 'invoice.refund', 'invoice', inv.id, { amount, reason: req.body.reason, number });
    return number;
  });
  res.json({ credit_note: out });
});
r.get('/invoices/:id/credit-notes', (req, res) => res.json(q.all('SELECT * FROM credit_notes WHERE invoice_id=? AND tenant_id=?', +req.params.id, T(req))));

// ---------- coupons ----------
r.get('/coupons', need('coupons'), requirePerm('coupons'), (req, res) => res.json(q.all('SELECT * FROM coupons WHERE tenant_id=? ORDER BY id DESC', T(req))));
r.post('/coupons', need('coupons'), requirePerm('coupons'), (req, res) => {
  const b = req.body || {};
  if (!b.code || !(+b.percent > 0 && +b.percent <= 100)) return bad(res, 'code and percent (1-100) required');
  try { q.run('INSERT INTO coupons(tenant_id,code,percent,max_discount,min_amount,usage_limit,start_hour,end_hour) VALUES (?,?,?,?,?,?,?,?)', T(req), String(b.code).toUpperCase(), +b.percent, +b.max_discount || 0, +b.min_amount || 0, +b.usage_limit || 0, b.start_hour === '' || b.start_hour === undefined ? 0 : +b.start_hour, b.end_hour === '' || b.end_hour === undefined ? 24 : +b.end_hour); }
  catch { return bad(res, 'Code already exists', 409); }
  res.json({ ok: true });
});
r.delete('/coupons/:id', need('coupons'), requirePerm('coupons'), (req, res) => { q.run('UPDATE coupons SET active=0 WHERE id=? AND tenant_id=?', +req.params.id, T(req)); res.json({ ok: true }); });

// ---------- reviews & complaints ----------
r.get('/reviews', need('reviews'), requirePerm('reviews'), (req, res) => res.json({
  reviews: q.all('SELECT * FROM reviews WHERE tenant_id=? ORDER BY id DESC LIMIT 100', T(req)),
  complaints: q.all('SELECT * FROM complaints WHERE tenant_id=? ORDER BY id DESC LIMIT 100', T(req)) }));
r.post('/reviews/:id', need('reviews'), requirePerm('reviews'), (req, res) => {
  const v = tenantOnly('reviews')(+req.params.id, T(req)); if (!v) return bad(res, 'Not found', 404);
  if (req.body.status && ['approved', 'rejected'].includes(req.body.status)) q.run('UPDATE reviews SET status=? WHERE id=?', req.body.status, v.id);
  if (req.body.reply !== undefined) q.run('UPDATE reviews SET reply=? WHERE id=?', String(req.body.reply).slice(0, 500), v.id);
  res.json({ ok: true });
});
r.post('/complaints/:id', need('reviews'), requirePerm('reviews'), (req, res) => {
  q.run('UPDATE complaints SET status=? WHERE id=? AND tenant_id=?', req.body.status === 'resolved' ? 'resolved' : 'open', +req.params.id, T(req)); res.json({ ok: true });
});

// ---------- customers (loyalty) ----------
r.get('/customers', need('loyalty'), requirePerm('customers'), (req, res) => res.json(q.all('SELECT * FROM customers WHERE tenant_id=? ORDER BY last_visit DESC LIMIT 500', T(req))));
r.get('/customers/lookup', need('loyalty'), (req, res) => res.json(q.get('SELECT phone,name,coins FROM customers WHERE tenant_id=? AND phone=?', T(req), String(req.query.phone || '')) || null));

// ---------- reports ----------
const rangeSql = (req) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0, 10);
  return { from, to };
};
const bf = (bid) => (bid === 'all' ? { sql: '', args: [] } : { sql: ' AND branch_id=?', args: [bid] });

r.get('/reports/dashboard', need('dashboard'), requirePerm('reports'), (req, res) => {
  const bid = branchOf(req, true), f = bf(bid);
  const today = q.get(`SELECT COUNT(*) n, COALESCE(SUM(total-refunded),0) sales FROM invoices WHERE tenant_id=? AND date(created_at)=date('now')${f.sql}`, T(req), ...f.args);
  const open = q.get(`SELECT COUNT(*) n FROM orders WHERE tenant_id=? AND invoice_id IS NULL${f.sql}`, T(req), ...f.args).n;
  const byMethod = q.all(`SELECT payment_method m, COALESCE(SUM(total-refunded),0) amt FROM invoices WHERE tenant_id=? AND date(created_at)=date('now')${f.sql} GROUP BY payment_method`, T(req), ...f.args);
  const tables = q.get(`SELECT SUM(status='occupied') occ, COUNT(*) total FROM tables_ WHERE tenant_id=?${f.sql}`, T(req), ...f.args);
  res.json({ today_sales: B.r2(today.sales), today_bills: today.n, avg_bill: today.n ? B.r2(today.sales / today.n) : 0, open_orders: open, by_method: byMethod, tables_occupied: tables.occ || 0, tables_total: tables.total });
});
r.get('/reports/analytics', need('analytics'), requirePerm('reports'), (req, res) => {
  const bid = branchOf(req, true), f = bf(bid), { from, to } = rangeSql(req);
  const base = [T(req), from, to, ...f.args];
  const W = `tenant_id=? AND date(created_at) BETWEEN ? AND ?${f.sql}`;
  res.json({
    from, to,
    sales_by_day: q.all(`SELECT date(created_at) d, ROUND(SUM(total-refunded),2) sales, COUNT(*) bills FROM invoices WHERE ${W} GROUP BY d ORDER BY d`, ...base),
    bestsellers: q.all(`SELECT oi.name, SUM(oi.qty) qty, ROUND(SUM(oi.price*oi.qty),2) revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE o.tenant_id=? AND o.invoice_id>0 AND oi.deleted=0 AND date(o.created_at) BETWEEN ? AND ?${f.sql.replace('branch_id', 'o.branch_id')} GROUP BY oi.name ORDER BY qty DESC LIMIT 10`, ...base),
    peak_hours: q.all(`SELECT CAST(strftime('%H', created_at) AS INTEGER) hour, COUNT(*) bills, ROUND(SUM(total),2) sales FROM invoices WHERE ${W} GROUP BY hour ORDER BY hour`, ...base),
    staff: q.all(`SELECT u.name, u.role, COUNT(*) bills, ROUND(SUM(i.total-i.refunded),2) sales FROM invoices i JOIN users u ON u.id=i.created_by WHERE i.tenant_id=? AND date(i.created_at) BETWEEN ? AND ?${f.sql.replace('branch_id', 'i.branch_id')} GROUP BY u.id ORDER BY sales DESC`, ...base),
    by_branch: bid === 'all' ? q.all(`SELECT b.name, COUNT(i.id) bills, ROUND(COALESCE(SUM(i.total-i.refunded),0),2) sales FROM branches b LEFT JOIN invoices i ON i.branch_id=b.id AND date(i.created_at) BETWEEN ? AND ? WHERE b.tenant_id=? GROUP BY b.id`, from, to, T(req)) : undefined,
  });
});
r.get('/reports/gst', need('gst_reports'), requirePerm('reports'), (req, res) => {
  const bid = branchOf(req, true), f = bf(bid), { from, to } = rangeSql(req);
  const invs = q.all(`SELECT * FROM invoices WHERE tenant_id=? AND date(created_at) BETWEEN ? AND ?${f.sql}`, T(req), from, to, ...f.args);
  const byRate = {};
  for (const inv of invs) {
    const bill = B.computeBill(B.orderItems(inv.order_id), inv.discount);
    for (const it of B.orderItems(inv.order_id)) {
      const share = inv.subtotal ? (1 - inv.discount / inv.subtotal) : 1; const base = B.lineTotal(it) * share;
      const x = byRate[it.gst_rate] ||= { rate: it.gst_rate, taxable: 0, tax: 0 };
      x.taxable += base; x.tax += base * it.gst_rate / 100;
    }
  }
  res.json({ from, to, invoices: invs.length, taxable: B.r2(invs.reduce((s, i) => s + i.subtotal - i.discount, 0)), cgst: B.r2(invs.reduce((s, i) => s + i.cgst, 0)), sgst: B.r2(invs.reduce((s, i) => s + i.sgst, 0)),
    refunds: B.r2(invs.reduce((s, i) => s + i.refunded, 0)), total: B.r2(invs.reduce((s, i) => s + i.total, 0)),
    by_rate: Object.values(byRate).map((x) => ({ rate: x.rate, taxable: B.r2(x.taxable), tax: B.r2(x.tax) })) });
});
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
r.get('/reports/export.csv', need('exports'), requirePerm('reports'), (req, res) => {
  const bid = branchOf(req, true), f = bf(bid), { from, to } = rangeSql(req);
  const rows = q.all(`SELECT number,created_at,subtotal,discount,cgst,sgst,total,refunded,payment_method,coupon_code FROM invoices WHERE tenant_id=? AND date(created_at) BETWEEN ? AND ?${f.sql} ORDER BY id`, T(req), from, to, ...f.args);
  const head = ['Invoice', 'Date', 'Subtotal', 'Discount', 'CGST', 'SGST', 'Total', 'Refunded', 'Payment', 'Coupon'];
  res.type('text/csv').set('Content-Disposition', `attachment; filename="invoices_${from}_${to}.csv"`)
    .send([head, ...rows.map((x) => Object.values(x))].map((l) => l.map(csvCell).join(',')).join('\n'));
});
r.get('/audit', requirePerm('*'), (req, res) => res.json(q.all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.tenant_id=? ORDER BY a.id DESC LIMIT 200`, T(req))));

module.exports = r;
module.exports.placeOrder = placeOrder;
module.exports.hydrate = hydrate;
