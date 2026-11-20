// End-to-end API test against a throwaway database. Run: npm test
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `rbs-test-${Date.now()}.db`);
const assert = require('assert');
const http = require('http');
const { seed } = require('./seed');
seed();
const { createApp } = require('./index');

const server = http.createServer(createApp());
let base;
async function call(method, url, body, token) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const login = async (e, p = 'demo123') => (await call('POST', '/api/auth/login', { email: e, password: p })).body;
let n = 0; const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);

server.listen(0, async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const admin = await login('admin@platform.test', 'admin123'); assert(admin.token); ok('platform admin login');
    const owner = await login('owner@spice.test'), cashier = await login('cashier@spice.test'), kitchen = await login('kitchen@spice.test'), starter = await login('owner@chai.test');
    assert.equal((await call('POST', '/api/auth/login', { email: 'owner@spice.test', password: 'bad' })).status, 401); ok('bad password rejected');

    // Feature gating: Starter plan has no QR, coupons, analytics; Growth has everything
    assert.equal(starter.user.features.qr_ordering, false); assert.equal(owner.user.features.qr_ordering, true);
    assert.equal((await call('GET', '/api/coupons', null, starter.token)).status, 403); ok('Starter plan blocked from coupons (backend flag check)');
    assert.equal((await call('GET', '/api/reports/analytics', null, starter.token)).status, 403); ok('Starter plan blocked from analytics');

    // Per-tenant override gives Starter tenant coupons, then expiry removes it
    const tenants = (await call('GET', '/api/admin/tenants', null, admin.token)).body; const chai = tenants.find((t) => t.slug === 'chai-point');
    await call('PUT', `/api/admin/tenants/${chai.id}/overrides`, { kind: 'feature', key: 'coupons', value: 1 }, admin.token);
    assert.equal((await call('GET', '/api/coupons', null, starter.token)).status, 200); ok('override enables a module for one tenant');
    await call('PUT', `/api/admin/tenants/${chai.id}/overrides`, { kind: 'feature', key: 'coupons', value: 1, expires_at: '2020-01-01' }, admin.token);
    assert.equal((await call('GET', '/api/coupons', null, starter.token)).status, 403); ok('expired override falls back to plan');

    // Limits: Starter allows 1 branch
    assert.equal((await call('POST', '/api/branches', { name: 'Second' }, starter.token)).status, 403); ok('branch limit enforced');

    // POS flow
    const tables = (await call('GET', '/api/tables', null, cashier.token)).body; const menu = (await call('GET', '/api/menu', null, cashier.token)).body;
    const byName = (n) => menu.items.find((i) => i.name === n);
    const cid = 'c-' + Date.now();
    const o1 = await call('POST', '/api/orders', { table_id: tables[0].id, type: 'dine_in', client_id: cid, items: [{ item_id: byName('Paneer Tikka').id, qty: 2, addons: ['Extra mint chutney'] }, { item_id: byName('Cold Coffee').id, qty: 1 }] }, cashier.token);
    assert.equal(o1.status, 200, JSON.stringify(o1.body));
    // 2*(240+20)=520 @5% =26 ; 140 @18% =25.2 ; subtotal 660
    assert.equal(o1.body.bill.subtotal, 660); assert.equal(o1.body.bill.gst, 51.2); assert.equal(o1.body.bill.total, 711.2); ok('GST bill maths (5% and 18% lines, add-ons)');
    const dup = await call('POST', '/api/orders', { table_id: tables[0].id, type: 'dine_in', client_id: cid, items: [{ item_id: byName('Paneer Tikka').id, qty: 2 }] }, cashier.token);
    assert.equal(dup.body.id, o1.body.id); assert.equal(dup.body.items.length, 2); ok('offline replay with same client_id is idempotent');
    const add = await call('POST', '/api/orders', { table_id: tables[0].id, type: 'dine_in', items: [{ item_id: byName('Butter Naan').id, qty: 2 }] }, cashier.token);
    assert.equal(add.body.id, o1.body.id); assert.equal(add.body.items.length, 3); ok('adding to an occupied table appends to its open order');
    const tk = await call('POST', '/api/orders', { type: 'takeaway', items: [{ item_id: byName('Masala Chai').id, qty: 1 }] }, cashier.token); assert.equal(tk.body.token, 1); ok('takeaway gets a daily token');

    // Kitchen display
    assert.equal((await call('GET', '/api/kds', null, cashier.token)).status, 403); ok('cashier cannot open kitchen display');
    const kds = (await call('GET', '/api/kds', null, kitchen.token)).body; assert(kds.length >= 2);
    assert.equal((await call('POST', `/api/orders/${o1.body.id}/status`, { status: 'ready' }, kitchen.token)).status, 400); ok('KDS cannot skip New -> Ready');
    for (const s of ['preparing', 'ready']) assert.equal((await call('POST', `/api/orders/${o1.body.id}/status`, { status: s }, kitchen.token)).status, 200); ok('KDS New -> Preparing -> Ready');

    // Delete / restore item with audit
    const itemId = add.body.items[2].id;
    let r = await call('POST', `/api/orders/${o1.body.id}/items/${itemId}/delete`, {}, owner.token); assert.equal(r.body.items.find((i) => i.id === itemId).deleted, 1);
    r = await call('POST', `/api/orders/${o1.body.id}/items/${itemId}/delete`, { restore: true }, owner.token); assert.equal(r.body.items.find((i) => i.id === itemId).deleted, 0); ok('delete + restore item');

    // Coupon, bill, invoice
    const prev = await call('POST', `/api/orders/${o1.body.id}/preview-bill`, { coupon_code: 'WELCOME10' }, cashier.token); assert.equal(prev.status, 200); assert(prev.body.discount > 0);
    assert.equal((await call('POST', `/api/orders/${o1.body.id}/preview-bill`, { coupon_code: 'NOPE' }, cashier.token)).status, 400); ok('coupon applied / invalid coupon rejected');
    const inv = await call('POST', `/api/orders/${o1.body.id}/bill`, { payment_method: 'cash', coupon_code: 'WELCOME10' }, cashier.token);
    assert.equal(inv.status, 200, JSON.stringify(inv.body)); assert.match(inv.body.number, /^INV\//); ok('invoice created ' + inv.body.number);
    assert.equal((await call('POST', `/api/orders/${o1.body.id}/bill`, { payment_method: 'cash' }, cashier.token)).status, 400); ok('cannot bill twice');
    assert.equal((await call('GET', '/api/tables', null, cashier.token)).body[0].status, 'free'); ok('table freed after billing');

    // Refund with credit note
    assert.equal((await call('POST', `/api/invoices/${inv.body.id}/refund`, { amount: 50, reason: 'x' }, cashier.token)).status, 403); ok('cashier cannot refund');
    const rf = await call('POST', `/api/invoices/${inv.body.id}/refund`, { amount: 50, reason: 'Cold food' }, owner.token); assert.match(rf.body.credit_note, /^CN\//);
    assert.equal((await call('POST', `/api/invoices/${inv.body.id}/refund`, { amount: 99999, reason: 'x' }, owner.token)).status, 400); ok('refund -> credit note; over-refund rejected');

    // QR ordering + online payment (mock gateway)
    const tok = require('./db').q.get('SELECT qr_token FROM tables_ WHERE id=?', tables[1].id).qr_token;
    const qm = await call('GET', `/api/public/${tok}/menu`); assert.equal(qm.status, 200); assert(qm.body.items.length === 15);
    await call('POST', `/api/menu/items/${byName('Gulab Jamun').id}/available`, { available: false }, kitchen.token);
    assert.equal((await call('GET', `/api/public/${tok}/menu`)).body.items.length, 14); ok('sold-out switch hides dish on QR menu');
    const bo = await call('POST', `/api/public/${tok}/order`, { customer_name: 'Guest', customer_phone: '9876543210', items: [{ item_id: byName('Dal Makhani').id, qty: 1 }, { item_id: byName('Gulab Jamun').id, qty: 1 }] });
    assert.equal(bo.status, 400); ok('sold-out item cannot be ordered via QR');
    const qo = await call('POST', `/api/public/${tok}/order`, { customer_name: 'Guest', customer_phone: '9876543210', items: [{ item_id: byName('Dal Makhani').id, qty: 2 }] }); assert.equal(qo.status, 200);
    const pay = await call('POST', `/api/public/${tok}/pay`); assert(pay.body.mock);
    assert.equal((await call('POST', `/api/public/${tok}/pay/verify`, { razorpay_order_id: pay.body.gateway_order_id, razorpay_payment_id: 'pay_mock_1', razorpay_signature: 'forged', order_id: pay.body.order_id })).status, 402);
    const vr = await call('POST', `/api/public/${tok}/pay/verify`, { razorpay_order_id: pay.body.gateway_order_id, razorpay_payment_id: 'pay_mock_1', razorpay_signature: 'mock_signature', order_id: qo.body.order_id }); assert.equal(vr.status, 200, JSON.stringify(vr.body));
    ok('QR order + online payment (mock) -> invoice; forged signature rejected');
    const cust = (await call('GET', '/api/customers', null, owner.token)).body.find((c) => c.phone === '9876543210'); assert(cust.coins > 0); ok('loyalty coins earned on paid QR order: ' + cust.coins);
    const rv = await call('POST', `/api/public/${tok}/review`, { rating: 5, text: 'Great', name: 'G' }); assert.equal(rv.status, 200);
    const list = (await call('GET', '/api/reviews', null, owner.token)).body; await call('POST', `/api/reviews/${list.reviews[0].id}`, { status: 'approved', reply: 'Thanks!' }, owner.token); ok('review submitted + moderated');

    // Tenant isolation
    assert.equal((await call('GET', `/api/orders/${o1.body.id}`, null, starter.token)).status, 404); ok('tenant isolation: other tenant cannot read order');
    assert.equal((await call('GET', '/api/admin/tenants', null, owner.token)).status, 403); ok('tenant user cannot reach admin API');

    // Reports
    const gst = (await call('GET', '/api/reports/gst', null, owner.token)).body; assert(gst.invoices >= 2);
    const an = (await call('GET', '/api/reports/analytics', null, owner.token)).body; assert(an.bestsellers.length);
    const csv = await call('GET', '/api/reports/export.csv', null, owner.token); assert.match(csv.body, /^Invoice,Date/); ok('GST summary, analytics, CSV export');

    // Suspension blocks tenant
    const sp = tenants.find((t) => t.slug === 'spice-garden');
    await call('PATCH', `/api/admin/tenants/${sp.id}/status`, { status: 'suspended' }, admin.token);
    assert.equal((await call('GET', '/api/tables', null, cashier.token)).status, 402);
    assert.equal((await call('GET', `/api/public/${tok}/menu`)).status, 403); ok('suspended tenant blocked (staff + QR)');
    await call('PATCH', `/api/admin/tenants/${sp.id}/status`, { status: 'active' }, admin.token);
    const an2 = (await call('GET', '/api/admin/analytics', null, admin.token)).body; assert(an2.mrr > 0); ok('platform analytics MRR ' + an2.mrr);
    const imp = await call('POST', `/api/admin/tenants/${sp.id}/impersonate`, null, admin.token); assert((await call('GET', '/api/auth/me', null, imp.body.token)).body.impersonated); ok('support impersonation (audited)');
    console.log(`\nAll ${n} checks passed.`); process.exit(0);
  } catch (e) { console.error('\nFAILED:', e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); }
});
