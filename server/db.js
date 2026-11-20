// SQLite via Node's built-in node:sqlite (no native build needed).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE, name TEXT, price_monthly REAL, price_yearly REAL, trial_days INTEGER DEFAULT 14, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS plan_features (plan_id INTEGER, feature_key TEXT, enabled INTEGER, PRIMARY KEY(plan_id, feature_key));
CREATE TABLE IF NOT EXISTS plan_limits (plan_id INTEGER, limit_key TEXT, value INTEGER, PRIMARY KEY(plan_id, limit_key));

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY, name TEXT, slug TEXT UNIQUE, status TEXT DEFAULT 'trial',
  gstin TEXT, address TEXT, razorpay_key_id TEXT, razorpay_key_secret TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, plan_id INTEGER, start_at TEXT, end_at TEXT, status TEXT, billing_cycle TEXT DEFAULT 'monthly');
CREATE TABLE IF NOT EXISTS tenant_overrides (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, kind TEXT, key TEXT, value INTEGER, expires_at TEXT, UNIQUE(tenant_id, kind, key));
CREATE TABLE IF NOT EXISTS platform_coupons (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, percent REAL, usage_limit INTEGER DEFAULT 0, used INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS platform_invoices (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, plan_id INTEGER, amount REAL, coupon_code TEXT, cycle TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, name TEXT, email TEXT UNIQUE, password_hash TEXT,
  role TEXT, branch_id INTEGER, active INTEGER DEFAULT 1, available INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY, tenant_id INTEGER, name TEXT, address TEXT);
CREATE TABLE IF NOT EXISTS tables_ (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, branch_id INTEGER, name TEXT, status TEXT DEFAULT 'free',
  waiter_id INTEGER, qr_token TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, tenant_id INTEGER, branch_id INTEGER, name TEXT);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, branch_id INTEGER, category_id INTEGER, name TEXT, description TEXT,
  price REAL, veg INTEGER DEFAULT 1, gst_rate REAL DEFAULT 5, available INTEGER DEFAULT 1,
  addons TEXT DEFAULT '[]', image_path TEXT, available_from TEXT, available_to TEXT);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, branch_id INTEGER, table_id INTEGER, type TEXT, source TEXT DEFAULT 'pos',
  status TEXT DEFAULT 'new', token INTEGER, customer_name TEXT, customer_phone TEXT, client_id TEXT UNIQUE,
  created_by INTEGER, invoice_id INTEGER, ready_notified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER, item_id INTEGER, name TEXT, price REAL, gst_rate REAL,
  qty INTEGER, note TEXT, addons TEXT DEFAULT '[]', deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, branch_id INTEGER, order_id INTEGER, number TEXT,
  subtotal REAL, discount REAL, cgst REAL, sgst REAL, total REAL, payment_method TEXT, payment_status TEXT,
  coupon_code TEXT, coins_used INTEGER DEFAULT 0, razorpay_order_id TEXT, razorpay_payment_id TEXT,
  refunded REAL DEFAULT 0, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS credit_notes (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, invoice_id INTEGER, number TEXT, amount REAL, reason TEXT,
  created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, code TEXT, percent REAL, max_discount REAL DEFAULT 0, min_amount REAL DEFAULT 0,
  usage_limit INTEGER DEFAULT 0, used INTEGER DEFAULT 0, start_hour INTEGER DEFAULT 0, end_hour INTEGER DEFAULT 24,
  active INTEGER DEFAULT 1, UNIQUE(tenant_id, code));
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, phone TEXT, name TEXT, coins INTEGER DEFAULT 0,
  total_spend REAL DEFAULT 0, visits INTEGER DEFAULT 0, last_visit TEXT, UNIQUE(tenant_id, phone));
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, branch_id INTEGER, customer_name TEXT, rating INTEGER, text TEXT,
  status TEXT DEFAULT 'pending', reply TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, branch_id INTEGER, customer_name TEXT, text TEXT,
  status TEXT DEFAULT 'open', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, user_id INTEGER, action TEXT, entity TEXT, entity_id INTEGER,
  detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS client_ops (client_id TEXT PRIMARY KEY, order_id INTEGER);
CREATE INDEX IF NOT EXISTS idx_orders_t ON orders(tenant_id, branch_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_t ON invoices(tenant_id, created_at);
`);

const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
const q = {
  get: (sql, ...p) => db.prepare(sql).get(...clean(p)),
  all: (sql, ...p) => db.prepare(sql).all(...clean(p)),
  run: (sql, ...p) => db.prepare(sql).run(...clean(p)),
  tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  audit(tenantId, userId, action, entity, entityId, detail) {
    db.prepare('INSERT INTO audit_log(tenant_id,user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?)')
      .run(...clean([tenantId, userId, action, entity, entityId, typeof detail === 'string' ? detail : JSON.stringify(detail || {})]));
  },
};
module.exports = { db, q };
