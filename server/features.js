// Plan + feature-flag engine.
// Access check order (per the product plan): tenant override first, then the plan, then deny.
const { q } = require('./db');

const FEATURES = {
  pos: 'POS billing, KOT', kds: 'Kitchen display', menu: 'Menu management', dashboard: 'Live dashboard',
  gst_reports: 'GST reports', exports: 'Excel/CSV exports', qr_ordering: 'QR table ordering',
  coupons: 'Offers and coupons', reviews: 'Review moderation, complaint desk', refunds: 'Refunds with credit notes',
  own_gateway: 'Own payment gateway', analytics: 'Analytics', loyalty: 'Coins loyalty, customer list',
};
const LIMITS = { branches: 'Branches', managers: 'Managers', staff: 'Staff accounts', tables: 'Tables', storage_mb: 'Storage (MB)' };

const now = () => new Date().toISOString();

function currentSubscription(tenantId) {
  return q.get(`SELECT s.*, p.name AS plan_name, p.key AS plan_key FROM tenant_subscriptions s JOIN plans p ON p.id = s.plan_id
                WHERE s.tenant_id = ? ORDER BY s.id DESC LIMIT 1`, tenantId);
}

/** Tenant is allowed to use the product when not suspended and subscription not past end date. */
function accessState(tenantId) {
  const t = q.get('SELECT status FROM tenants WHERE id = ?', tenantId);
  if (!t) return { ok: false, reason: 'tenant_not_found' };
  if (t.status === 'suspended') return { ok: false, reason: 'suspended' };
  const sub = currentSubscription(tenantId);
  if (!sub) return { ok: false, reason: 'no_subscription' };
  if (sub.end_at < now()) return { ok: false, reason: 'expired', sub };
  return { ok: true, sub };
}

function resolve(tenantId) {
  const sub = currentSubscription(tenantId);
  const features = {}, limits = {};
  for (const k of Object.keys(FEATURES)) features[k] = false;
  for (const k of Object.keys(LIMITS)) limits[k] = 0;
  if (sub) {
    for (const r of q.all('SELECT feature_key, enabled FROM plan_features WHERE plan_id = ?', sub.plan_id)) features[r.feature_key] = !!r.enabled;
    for (const r of q.all('SELECT limit_key, value FROM plan_limits WHERE plan_id = ?', sub.plan_id)) limits[r.limit_key] = r.value;
  }
  // overrides win over the plan, unless expired
  for (const o of q.all('SELECT * FROM tenant_overrides WHERE tenant_id = ?', tenantId)) {
    if (o.expires_at && o.expires_at < now()) continue;
    if (o.kind === 'feature') features[o.key] = !!o.value; else limits[o.key] = o.value;
  }
  return { features, limits, sub };
}

const hasFeature = (tenantId, key) => !!resolve(tenantId).features[key];

function requireFeature(key) {
  return (req, res, next) => {
    if (!resolve(req.user.tenant_id).features[key]) return res.status(403).json({ error: `Your plan does not include: ${FEATURES[key] || key}`, feature: key });
    next();
  };
}

/** Throws-style check for numeric limits. `count` is current usage. */
function withinLimit(tenantId, key, count) {
  const lim = resolve(tenantId).limits[key];
  return count < lim;
}

module.exports = { FEATURES, LIMITS, resolve, hasFeature, requireFeature, withinLimit, accessState, currentSubscription, now };
