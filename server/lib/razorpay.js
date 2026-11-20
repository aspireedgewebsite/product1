// Razorpay wrapper. With no keys configured it runs in MOCK mode so the whole flow can be tried locally.
const crypto = require('crypto');
const { q } = require('../db');
const { hasFeature } = require('../features');

function creds(tenantId) {
  const t = q.get('SELECT razorpay_key_id id, razorpay_key_secret secret FROM tenants WHERE id=?', tenantId);
  if (t?.id && t?.secret && hasFeature(tenantId, 'own_gateway')) return { id: t.id, secret: t.secret, own: true };
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) return { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET };
  return null;
}
const auth = (c) => 'Basic ' + Buffer.from(`${c.id}:${c.secret}`).toString('base64');

async function createOrder(tenantId, amount, receipt) {
  const c = creds(tenantId);
  if (!c) return { mock: true, gateway_order_id: 'order_mock_' + crypto.randomBytes(5).toString('hex'), key_id: 'mock', amount: Math.round(amount * 100) };
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth(c) },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency: 'INR', receipt: String(receipt).slice(0, 40) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.description || 'Razorpay error');
  return { mock: false, gateway_order_id: j.id, key_id: c.id, amount: j.amount };
}

function verify(tenantId, orderId, paymentId, signature) {
  const c = creds(tenantId);
  if (!c) return String(orderId).startsWith('order_mock_') && signature === 'mock_signature';
  const expected = crypto.createHmac('sha256', c.secret).update(`${orderId}|${paymentId}`).digest('hex');
  return expected.length === String(signature).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

async function refund(tenantId, paymentId, amount) {
  const c = creds(tenantId);
  if (!c || !paymentId || String(paymentId).startsWith('pay_mock_')) return { mock: true };
  const r = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth(c) },
    body: JSON.stringify({ amount: Math.round(amount * 100) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.description || 'Razorpay refund failed');
  return j;
}
module.exports = { createOrder, verify, refund, creds };
