// Auth + platform admin panel
const express = require('express');
const { q } = require('../db');
const { sign, hash, check, authenticate, requirePlatform } = require('../auth');
const F = require('../features');

const r = express.Router();
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5).toISOString();

function profile(user) {
  const base = { id: user.id, name: user.name, email: user.email, role: user.role, branch_id: user.branch_id, tenant_id: user.tenant_id };
  if (!user.tenant_id) return base;
  const { features, limits, sub } = F.resolve(user.tenant_id);
  const tenant = q.get('SELECT id,name,gstin,address,status FROM tenants WHERE id = ?', user.tenant_id);
  const st = F.accessState(user.tenant_id);
  return { ...base, tenant, features, limits, subscription: sub, access: st.ok ? 'ok' : st.reason,
    branches: q.all('SELECT id,name FROM branches WHERE tenant_id = ?', user.tenant_id), impersonated: !!user.impersonatedBy };
}

r.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = q.get('SELECT * FROM users WHERE email = ? AND active = 1', String(email || '').toLowerCase());
  if (!u || !check(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: sign(u), user: profile(u) });
});
r.get('/auth/me', authenticate, (req, res) => res.json(profile(req.user)));

// ---------- platform admin ----------
const admin = express.Router();
admin.use(authenticate, requirePlatform);

admin.get('/meta', (req, res) => res.json({ features: F.FEATURES, limits: F.LIMITS }));

admin.get('/plans', (req, res) => {
  res.json(q.all('SELECT * FROM plans ORDER BY price_monthly').map((p) => ({
    ...p,
    features: Object.fromEntries(q.all('SELECT feature_key,enabled FROM plan_features WHERE plan_id=?', p.id).map((x) => [x.feature_key, !!x.enabled])),
    limits: Object.fromEntries(q.all('SELECT limit_key,value FROM plan_limits WHERE plan_id=?', p.id).map((x) => [x.limit_key, x.value])),
  })));
});

function savePlan(id, b) {
  q.run('UPDATE plans SET name=?, price_monthly=?, price_yearly=?, trial_days=?, active=? WHERE id=?',
    b.name, +b.price_monthly, +b.price_yearly, +b.trial_days || 14, b.active === false ? 0 : 1, id);
  for (const k of Object.keys(F.FEATURES)) {
    q.run('INSERT INTO plan_features(plan_id,feature_key,enabled) VALUES (?,?,?) ON CONFLICT(plan_id,feature_key) DO UPDATE SET enabled=excluded.enabled', id, k, b.features?.[k] ? 1 : 0);
  }
  for (const k of Object.keys(F.LIMITS)) {
    q.run('INSERT INTO plan_limits(plan_id,limit_key,value) VALUES (?,?,?) ON CONFLICT(plan_id,limit_key) DO UPDATE SET value=excluded.value', id, k, +b.limits?.[k] || 0);
  }
}
admin.post('/plans', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const id = q.tx(() => {
    const ins = q.run('INSERT INTO plans(key,name,price_monthly,price_yearly,trial_days) VALUES (?,?,0,0,14)', slugify(b.name) + '-' + Date.now() % 10000, b.name);
    savePlan(+ins.lastInsertRowid, b); return +ins.lastInsertRowid;
  });
  q.audit(null, req.user.id, 'plan.create', 'plan', id, b.name);
  res.json({ id });
});
admin.put('/plans/:id', (req, res) => {
  q.tx(() => savePlan(+req.params.id, req.body || {}));
  q.audit(null, req.user.id, 'plan.update', 'plan', +req.params.id, req.body);
  res.json({ ok: true });
});

admin.get('/tenants', (req, res) => {
  const rows = q.all('SELECT * FROM tenants ORDER BY id DESC').map((t) => {
    const sub = F.currentSubscription(t.id);
    const st = F.accessState(t.id);
    return {
      id: t.id, name: t.name, slug: t.slug, status: t.status, created_at: t.created_at,
      effective_status: t.status === 'suspended' ? 'suspended' : !sub ? 'none' : sub.end_at < F.now() ? 'expired' : sub.status,
      plan: sub?.plan_name, plan_id: sub?.plan_id, ends: sub?.end_at,
      outlets: q.get('SELECT COUNT(*) c FROM branches WHERE tenant_id=?', t.id).c,
      users: q.get('SELECT COUNT(*) c FROM users WHERE tenant_id=?', t.id).c,
      orders_30d: q.get("SELECT COUNT(*) c FROM orders WHERE tenant_id=? AND created_at > datetime('now','-30 day')", t.id).c,
      access_ok: st.ok,
    };
  });
  res.json(rows);
});

admin.post('/tenants', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.owner_email || !b.owner_password) return res.status(400).json({ error: 'name, owner_email, owner_password required' });
  if (b.owner_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (q.get('SELECT id FROM users WHERE email=?', b.owner_email.toLowerCase())) return res.status(409).json({ error: 'Email already in use' });
  const plan = q.get('SELECT * FROM plans WHERE id = ?', b.plan_id || 0) || q.get('SELECT * FROM plans ORDER BY price_monthly LIMIT 1');
  const out = q.tx(() => {
    let slug = slugify(b.name), n = 1;
    while (q.get('SELECT id FROM tenants WHERE slug=?', slug)) slug = slugify(b.name) + '-' + ++n;
    const t = +q.run('INSERT INTO tenants(name,slug,status,gstin) VALUES (?,?,?,?)', b.name, slug, 'trial', b.gstin).lastInsertRowid;
    const br = +q.run('INSERT INTO branches(tenant_id,name) VALUES (?,?)', t, 'Main branch').lastInsertRowid;
    q.run('INSERT INTO users(tenant_id,name,email,password_hash,role,branch_id) VALUES (?,?,?,?,?,?)', t, b.owner_name || 'Owner', b.owner_email.toLowerCase(), hash(b.owner_password), 'owner', br);
    q.run('INSERT INTO tenant_subscriptions(tenant_id,plan_id,start_at,end_at,status) VALUES (?,?,?,?,?)', t, plan.id, F.now(), addDays(F.now(), plan.trial_days), 'trial');
    return t;
  });
  q.audit(out, req.user.id, 'tenant.create', 'tenant', out, b.name);
  res.json({ id: out });
});

admin.patch('/tenants/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['trial', 'active', 'suspended'].includes(status)) return res.status(400).json({ error: 'bad status' });
  q.run('UPDATE tenants SET status=? WHERE id=?', status, +req.params.id);
  q.audit(+req.params.id, req.user.id, 'tenant.status', 'tenant', +req.params.id, status);
  res.json({ ok: true });
});

admin.get('/tenants/:id', (req, res) => {
  const id = +req.params.id;
  const t = q.get('SELECT id,name,slug,status,gstin FROM tenants WHERE id=?', id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { features, limits, sub } = F.resolve(id);
  res.json({ ...t, sub, effective: { features, limits }, overrides: q.all('SELECT * FROM tenant_overrides WHERE tenant_id=?', id),
    usage: { branches: q.get('SELECT COUNT(*) c FROM branches WHERE tenant_id=?', id).c,
      tables: q.get('SELECT COUNT(*) c FROM tables_ WHERE tenant_id=?', id).c,
      managers: q.get("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND role='manager'", id).c,
      staff: q.get("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND role IN ('cashier','waiter','kitchen')", id).c },
    users: q.all('SELECT id,name,email,role,active FROM users WHERE tenant_id=?', id) });
});

// Per-tenant override: switch a feature or limit with optional expiry. value=null removes override.
admin.put('/tenants/:id/overrides', (req, res) => {
  const id = +req.params.id; const { kind, key, value, expires_at } = req.body || {};
  if (!['feature', 'limit'].includes(kind) || !(kind === 'feature' ? F.FEATURES : F.LIMITS)[key]) return res.status(400).json({ error: 'bad kind/key' });
  if (value === null || value === undefined) q.run('DELETE FROM tenant_overrides WHERE tenant_id=? AND kind=? AND key=?', id, kind, key);
  else q.run(`INSERT INTO tenant_overrides(tenant_id,kind,key,value,expires_at) VALUES (?,?,?,?,?)
      ON CONFLICT(tenant_id,kind,key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`, id, kind, key, +value, expires_at ? new Date(expires_at).toISOString() : null);
  q.audit(id, req.user.id, 'tenant.override', kind, null, req.body);
  res.json({ ok: true });
});

// Change plan / renew / manual extension, with optional platform coupon.
admin.post('/tenants/:id/subscription', (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  const plan = q.get('SELECT * FROM plans WHERE id=?', b.plan_id);
  if (!plan) return res.status(400).json({ error: 'plan required' });
  const cycle = b.cycle === 'yearly' ? 'yearly' : 'monthly';
  const days = b.extend_days ? +b.extend_days : cycle === 'yearly' ? 365 : 30;
  let amount = b.extend_days ? 0 : cycle === 'yearly' ? plan.price_yearly : plan.price_monthly;
  let couponCode = null;
  if (b.coupon && !b.extend_days) {
    const c = q.get('SELECT * FROM platform_coupons WHERE code=? AND active=1', String(b.coupon).toUpperCase());
    if (!c || (c.usage_limit && c.used >= c.usage_limit)) return res.status(400).json({ error: 'Invalid or exhausted coupon' });
    amount = Math.round(amount * (1 - c.percent / 100) * 100) / 100; couponCode = c.code;
    q.run('UPDATE platform_coupons SET used=used+1 WHERE id=?', c.id);
  }
  const cur = F.currentSubscription(id);
  const startFrom = cur && cur.end_at > F.now() && cur.plan_id === plan.id ? cur.end_at : F.now();
  // Upgrade proration: unused days of the current paid period are credited against the new plan.
  if (cur && cur.status === 'active' && cur.plan_id !== plan.id && cur.end_at > F.now() && !b.extend_days) {
    const old = q.get('SELECT * FROM plans WHERE id=?', cur.plan_id);
    const unused = Math.max(0, (new Date(cur.end_at) - Date.now()) / 864e5);
    const perDay = (cur.billing_cycle === 'yearly' ? old.price_yearly / 365 : old.price_monthly / 30);
    amount = Math.max(0, Math.round((amount - perDay * unused) * 100) / 100);
  }
  q.tx(() => {
    q.run('INSERT INTO tenant_subscriptions(tenant_id,plan_id,start_at,end_at,status,billing_cycle) VALUES (?,?,?,?,?,?)', id, plan.id, F.now(), addDays(startFrom, days), 'active', cycle);
    q.run("UPDATE tenants SET status='active' WHERE id=? AND status!='suspended'", id);
    if (amount > 0 || !b.extend_days) q.run('INSERT INTO platform_invoices(tenant_id,plan_id,amount,coupon_code,cycle) VALUES (?,?,?,?,?)', id, plan.id, amount, couponCode, cycle);
  });
  q.audit(id, req.user.id, 'subscription.set', 'plan', plan.id, { cycle, days, amount, couponCode });
  res.json({ ok: true, amount });
});

admin.get('/coupons', (req, res) => res.json(q.all('SELECT * FROM platform_coupons ORDER BY id DESC')));
admin.post('/coupons', (req, res) => {
  const b = req.body || {};
  if (!b.code || !(+b.percent > 0 && +b.percent <= 100)) return res.status(400).json({ error: 'code and percent (1-100) required' });
  try { q.run('INSERT INTO platform_coupons(code,percent,usage_limit) VALUES (?,?,?)', String(b.code).toUpperCase(), +b.percent, +b.usage_limit || 0); }
  catch { return res.status(409).json({ error: 'Code exists' }); }
  q.audit(null, req.user.id, 'coupon.create', 'coupon', null, b.code); res.json({ ok: true });
});
admin.delete('/coupons/:id', (req, res) => { q.run('UPDATE platform_coupons SET active=0 WHERE id=?', +req.params.id); res.json({ ok: true }); });

// Support tools
admin.post('/tenants/:id/impersonate', (req, res) => {
  const owner = q.get("SELECT * FROM users WHERE tenant_id=? AND role='owner' AND active=1 ORDER BY id LIMIT 1", +req.params.id);
  if (!owner) return res.status(404).json({ error: 'No owner' });
  q.audit(owner.tenant_id, req.user.id, 'support.impersonate', 'user', owner.id, `Platform admin ${req.user.email} logged in as ${owner.email}`);
  res.json({ token: sign(owner, { imp: req.user.id }), user: profile({ ...owner, impersonatedBy: req.user.id }) });
});
admin.post('/users/:id/reset-password', (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id=? AND tenant_id IS NOT NULL', +req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const pw = req.body?.password || Math.random().toString(36).slice(2, 10);
  q.run('UPDATE users SET password_hash=? WHERE id=?', hash(pw), u.id);
  q.audit(u.tenant_id, req.user.id, 'support.reset_password', 'user', u.id, u.email);
  res.json({ password: pw });
});
admin.get('/tenants/:id/complaints', (req, res) => res.json(q.all('SELECT * FROM complaints WHERE tenant_id=? ORDER BY id DESC LIMIT 100', +req.params.id)));

admin.get('/analytics', (req, res) => {
  const tenants = q.all('SELECT id FROM tenants');
  let mrr = 0, trial = 0, active = 0, expired = 0, suspended = 0;
  for (const { id } of tenants) {
    const t = q.get('SELECT status FROM tenants WHERE id=?', id);
    const sub = F.currentSubscription(id); if (!sub) continue;
    const plan = q.get('SELECT * FROM plans WHERE id=?', sub.plan_id);
    if (t.status === 'suspended') { suspended++; continue; }
    if (sub.end_at < F.now()) { expired++; continue; }
    if (sub.status === 'trial') trial++;
    else { active++; mrr += sub.billing_cycle === 'yearly' ? plan.price_yearly / 12 : plan.price_monthly; }
  }
  const everPaid = q.get("SELECT COUNT(DISTINCT tenant_id) c FROM tenant_subscriptions WHERE status='active'").c;
  const everTrial = q.get("SELECT COUNT(DISTINCT tenant_id) c FROM tenant_subscriptions WHERE status='trial'").c;
  const usage = Object.keys(F.FEATURES).map((k) => ({ feature: k, tenants: tenants.filter((t) => F.hasFeature(t.id, k)).length }));
  res.json({ mrr: Math.round(mrr), arr: Math.round(mrr * 12), counts: { trial, active, expired, suspended, total: tenants.length },
    trial_to_paid: everTrial ? Math.round((everPaid / everTrial) * 100) : 0,
    churn_pct: tenants.length ? Math.round(((expired + suspended) / tenants.length) * 100) : 0, feature_usage: usage,
    revenue_total: q.get('SELECT COALESCE(SUM(amount),0) s FROM platform_invoices').s });
});
admin.get('/audit', (req, res) => res.json(q.all(`SELECT a.*, u.email AS user_email, t.name AS tenant_name FROM audit_log a
  LEFT JOIN users u ON u.id=a.user_id LEFT JOIN tenants t ON t.id=a.tenant_id ORDER BY a.id DESC LIMIT 200`)));
admin.get('/invoices', (req, res) => res.json(q.all(`SELECT i.*, t.name AS tenant_name, p.name AS plan_name FROM platform_invoices i
  JOIN tenants t ON t.id=i.tenant_id JOIN plans p ON p.id=i.plan_id ORDER BY i.id DESC LIMIT 200`)));

r.use('/admin', admin);
module.exports = r;
module.exports.profile = profile;
