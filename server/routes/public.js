// Guest-facing QR ordering. No login: a per-table secret token identifies tenant, branch and table.
const express = require('express');
const crypto = require('crypto');
const { q } = require('../db');
const F = require('../features');
const rt = require('../lib/rt');
const B = require('../lib/billing');
const RZ = require('../lib/razorpay');
const { placeOrder, hydrate } = require('./tenant');

const r = express.Router();
const bad = (res, m, c = 400) => res.status(c).json({ error: m });

function ctx(req, res, next) {
  const t = q.get('SELECT * FROM tables_ WHERE qr_token=?', req.params.token);
  if (!t) return bad(res, 'This QR code is not valid', 404);
  const st = F.accessState(t.tenant_id);
  if (!st.ok) return bad(res, 'This restaurant is not accepting QR orders right now', 403);
  if (!F.hasFeature(t.tenant_id, 'qr_ordering')) return bad(res, 'QR ordering is not enabled for this restaurant', 403);
  req.table = t; next();
}

r.get('/:token/menu', ctx, (req, res) => {
  const t = req.table, hhmm = new Date().toTimeString().slice(0, 5);
  const tenant = q.get('SELECT name FROM tenants WHERE id=?', t.tenant_id), br = q.get('SELECT name FROM branches WHERE id=?', t.branch_id);
  const items = q.all('SELECT id,category_id,name,description,price,veg,gst_rate,addons,image_path,available,available_from,available_to FROM menu_items WHERE tenant_id=? AND branch_id=?', t.tenant_id, t.branch_id)
    .filter((i) => i.available && !(i.available_from && i.available_to && (hhmm < i.available_from || hhmm > i.available_to)))
    .map(({ available, available_from, available_to, ...i }) => ({ ...i, addons: JSON.parse(i.addons || '[]') }));
  res.json({ restaurant: tenant.name, branch: br.name, table: t.name,
    categories: q.all('SELECT id,name FROM categories WHERE tenant_id=? AND branch_id=?', t.tenant_id, t.branch_id), items,
    online_payment: true, mock_payments: !RZ.creds(t.tenant_id),
    can_review: F.hasFeature(t.tenant_id, 'reviews'), loyalty: F.hasFeature(t.tenant_id, 'loyalty') });
});

// Place (or add to) the table's order. The client_id doubles as the guest's tracking secret.
r.post('/:token/order', ctx, (req, res) => {
  const t = req.table, b = req.body || {};
  const client_id = 'qr-' + crypto.randomBytes(8).toString('hex');
  const phone = String(b.customer_phone || '').replace(/\D/g, '').slice(-10) || null;
  const out = placeOrder({ tenantId: t.tenant_id, branchId: t.branch_id, tableId: t.id, type: 'dine_in', source: 'qr', items: b.items,
    customer_name: String(b.customer_name || '').slice(0, 60) || null, customer_phone: phone, client_id, userId: null });
  if (out.error) return bad(res, out.error);
  rt.emitOrder(t.tenant_id, t.branch_id, out.order.id); rt.emit(t.tenant_id, t.branch_id, 'tables:changed');
  const h = hydrate(out.order);
  res.json({ order_id: out.order.id, track: out.order.client_id, bill: h.bill, pay_at_counter: true });
});

// Order tracking
r.get('/:token/track', ctx, (req, res) => {
  const o = q.get('SELECT * FROM orders WHERE table_id=? AND invoice_id IS NULL ORDER BY id DESC LIMIT 1', req.table.id);
  if (!o) return res.json({ status: 'none' });
  const h = hydrate(o);
  res.json({ order_id: o.id, status: o.status, items: h.items.filter((i) => !i.deleted).map((i) => ({ name: i.name, qty: i.qty })), bill: h.bill });
});

// Online payment: create gateway order, then verify. (Mock mode when no Razorpay keys are configured.)
r.post('/:token/pay', ctx, async (req, res) => {
  const o = q.get('SELECT * FROM orders WHERE table_id=? AND invoice_id IS NULL ORDER BY id DESC LIMIT 1', req.table.id);
  if (!o) return bad(res, 'No open order');
  const bill = B.computeBill(B.orderItems(o.id), 0);
  try { const g = await RZ.createOrder(o.tenant_id, bill.total, `ord${o.id}`); res.json({ ...g, amount_rupees: bill.total, order_id: o.id }); }
  catch (e) { bad(res, e.message, 502); }
});
r.post('/:token/pay/verify', ctx, (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = req.body || {};
  const o = q.get('SELECT * FROM orders WHERE id=? AND table_id=? AND invoice_id IS NULL', +order_id, req.table.id);
  if (!o) return bad(res, 'No open order');
  if (!RZ.verify(o.tenant_id, razorpay_order_id, razorpay_payment_id, razorpay_signature)) return bad(res, 'Payment verification failed', 402);
  const inv = B.createInvoice(o, { method: 'online', userId: null, razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id });
  if (inv.error) return bad(res, inv.error);
  rt.emitOrder(o.tenant_id, o.branch_id, o.id); rt.emit(o.tenant_id, o.branch_id, 'tables:changed');
  res.json({ ok: true, invoice: inv.number, total: inv.total });
});

r.post('/:token/review', ctx, (req, res) => {
  if (!F.hasFeature(req.table.tenant_id, 'reviews')) return bad(res, 'Reviews are not enabled', 403);
  const b = req.body || {}; const rating = Math.round(+b.rating);
  if (!(rating >= 1 && rating <= 5)) return bad(res, 'Rating 1-5 required');
  if (b.complaint) q.run('INSERT INTO complaints(tenant_id,branch_id,customer_name,text) VALUES (?,?,?,?)', req.table.tenant_id, req.table.branch_id, String(b.name || '').slice(0, 60), String(b.text || '').slice(0, 500));
  else q.run('INSERT INTO reviews(tenant_id,branch_id,customer_name,rating,text) VALUES (?,?,?,?,?)', req.table.tenant_id, req.table.branch_id, String(b.name || '').slice(0, 60), rating, String(b.text || '').slice(0, 500));
  res.json({ ok: true });
});
module.exports = r;
