// Bill maths (GST-ready) and invoice creation.
const { q } = require('../db');
const { hasFeature } = require('../features');
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const lineTotal = (i) => {
  const list = typeof i.addons === 'string' ? JSON.parse(i.addons || '[]') : (i.addons || []);
  const add = list.reduce((s, a) => s + a.price, 0);
  return r2((i.price + add) * i.qty);
};

function orderItems(orderId) { return q.all('SELECT * FROM order_items WHERE order_id=? AND deleted=0', orderId); }

/** Prices are tax-exclusive. Discount is spread proportionally across lines before GST. */
function computeBill(items, discount = 0) {
  const subtotal = r2(items.reduce((s, i) => s + lineTotal(i), 0));
  const disc = Math.min(r2(discount), subtotal);
  const factor = subtotal > 0 ? 1 - disc / subtotal : 1;
  const byRate = {};
  let gst = 0;
  for (const i of items) {
    const base = lineTotal(i) * factor, tax = base * (i.gst_rate / 100);
    gst += tax; byRate[i.gst_rate] = r2((byRate[i.gst_rate] || 0) + tax);
  }
  gst = r2(gst);
  const cgst = r2(gst / 2), sgst = r2(gst - cgst);
  return { subtotal, discount: disc, cgst, sgst, gst, total: r2(subtotal - disc + gst), byRate };
}

function couponDiscount(tenantId, code, subtotal) {
  if (!code) return { discount: 0 };
  if (!hasFeature(tenantId, 'coupons')) return { error: 'Coupons are not part of your plan' };
  const c = q.get('SELECT * FROM coupons WHERE tenant_id=? AND code=? AND active=1', tenantId, String(code).toUpperCase());
  if (!c) return { error: 'Invalid coupon' };
  if (c.usage_limit && c.used >= c.usage_limit) return { error: 'Coupon usage limit reached' };
  if (subtotal < c.min_amount) return { error: `Minimum order ₹${c.min_amount} for this coupon` };
  const h = new Date().getHours();
  if (h < c.start_hour || h >= c.end_hour) return { error: `Coupon valid ${c.start_hour}:00–${c.end_hour}:00 only` };
  let d = subtotal * c.percent / 100; if (c.max_discount > 0) d = Math.min(d, c.max_discount);
  return { discount: r2(d), coupon: c };
}

function nextInvoiceNumber(tenantId) {
  const d = new Date(), fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const n = q.get('SELECT COUNT(*) c FROM invoices WHERE tenant_id=?', tenantId).c + 1;
  return `INV/${String(fy).slice(2)}-${String(fy + 1).slice(2)}/${String(n).padStart(5, '0')}`;
}

/** Creates a paid invoice, closes the order, frees the table, updates customer + coins. Returns invoice or {error}. */
function createInvoice(order, { method, couponCode, coins = 0, userId, razorpayOrderId, razorpayPaymentId }) {
  const items = orderItems(order.id);
  if (!items.length) return { error: 'Order has no items' };
  if (order.invoice_id) return { error: 'Order already billed' };
  const sub = computeBill(items, 0).subtotal;
  const cd = couponDiscount(order.tenant_id, couponCode, sub);
  if (cd.error) return { error: cd.error };
  let coinsUsed = 0, cust = null;
  if (order.customer_phone && hasFeature(order.tenant_id, 'loyalty')) {
    cust = q.get('SELECT * FROM customers WHERE tenant_id=? AND phone=?', order.tenant_id, order.customer_phone);
    if (coins > 0 && cust) coinsUsed = Math.max(0, Math.min(Math.floor(coins), cust.coins, Math.floor(sub - cd.discount)));
  }
  const bill = computeBill(items, cd.discount + coinsUsed);
  return q.tx(() => {
    const id = +q.run(`INSERT INTO invoices(tenant_id,branch_id,order_id,number,subtotal,discount,cgst,sgst,total,payment_method,payment_status,coupon_code,coins_used,razorpay_order_id,razorpay_payment_id,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, order.tenant_id, order.branch_id, order.id, nextInvoiceNumber(order.tenant_id),
      bill.subtotal, bill.discount, bill.cgst, bill.sgst, bill.total, method, 'paid', cd.coupon?.code || null, coinsUsed, razorpayOrderId, razorpayPaymentId, userId).lastInsertRowid;
    q.run("UPDATE orders SET invoice_id=?, status='billed', updated_at=CURRENT_TIMESTAMP WHERE id=?", id, order.id);
    if (order.table_id) q.run("UPDATE tables_ SET status='free' WHERE id=? AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id=tables_.id AND o.invoice_id IS NULL AND o.id!=?)", order.table_id, order.id);
    if (cd.coupon) q.run('UPDATE coupons SET used=used+1 WHERE id=?', cd.coupon.id);
    if (order.customer_phone && hasFeature(order.tenant_id, 'loyalty')) {
      const earn = order.source === 'qr' ? Math.floor(bill.total * 0.05) : 0; // coins earned on paid QR orders
      q.run(`INSERT INTO customers(tenant_id,phone,name,coins,total_spend,visits,last_visit) VALUES (?,?,?,?,?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(tenant_id,phone) DO UPDATE SET coins=coins-?+?, total_spend=total_spend+?, visits=visits+1, last_visit=CURRENT_TIMESTAMP, name=COALESCE(NULLIF(excluded.name,''),name)`,
        order.tenant_id, order.customer_phone, order.customer_name || '', earn, bill.total, coinsUsed, earn, bill.total);
    }
    q.audit(order.tenant_id, userId, 'invoice.create', 'invoice', id, { order: order.id, total: bill.total, method });
    return q.get('SELECT * FROM invoices WHERE id=?', id);
  });
}
module.exports = { computeBill, couponDiscount, createInvoice, orderItems, lineTotal, r2 };
