const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { q } = require('./db');
const { accessState } = require('./features');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('Set JWT_SECRET in production');
}

// What each role may do inside a tenant (role -> permission set).
const PERMISSIONS = {
  owner: ['*'],
  manager: ['orders', 'pos', 'kds', 'tables', 'menu', 'coupons', 'reviews', 'reports', 'refunds', 'staff_view', 'customers', 'soldout'],
  cashier: ['orders', 'pos', 'tables', 'soldout'],
  waiter: ['orders', 'pos', 'tables'],
  kitchen: ['kds', 'soldout'],
};
const can = (role, perm) => PERMISSIONS[role] && (PERMISSIONS[role].includes('*') || PERMISSIONS[role].includes(perm));

const sign = (u, extra = {}) => jwt.sign({ id: u.id, ...extra }, SECRET, { expiresIn: '12h' });
const hash = (pw) => bcrypt.hashSync(pw, 10);
const check = (pw, h) => bcrypt.compareSync(pw, h);

function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = q.get('SELECT * FROM users WHERE id = ? AND active = 1', payload.id);
    if (!user) return res.status(401).json({ error: 'Account disabled' });
    req.user = { ...user, impersonatedBy: payload.imp || null };
    next();
  } catch { res.status(401).json({ error: 'Session expired' }); }
}

const requirePlatform = (req, res, next) =>
  req.user.role === 'platform_admin' ? next() : res.status(403).json({ error: 'Platform admin only' });

/** Tenant routes: user must belong to a tenant whose subscription is live. */
function requireTenant(req, res, next) {
  if (!req.user.tenant_id) return res.status(403).json({ error: 'Tenant account required' });
  const st = accessState(req.user.tenant_id);
  if (!st.ok) return res.status(402).json({ error: `Account ${st.reason}. Contact support or renew your plan.`, reason: st.reason });
  next();
}

const requirePerm = (perm) => (req, res, next) =>
  can(req.user.role, perm) ? next() : res.status(403).json({ error: 'Your role cannot do this' });

module.exports = { sign, hash, check, authenticate, requirePlatform, requireTenant, requirePerm, can, PERMISSIONS };
