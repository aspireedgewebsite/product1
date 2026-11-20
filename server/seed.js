// Creates plans from the product plan, a platform admin, and a demo restaurant. Safe to re-run (skips if seeded).
const { q } = require('./db');
const { hash } = require('./auth');
const F = require('./features');

const PLANS = [
  { key: 'starter', name: 'Starter', m: 999, branches: 1, managers: 1, staff: 10, tables: 25, gb: 1,
    on: ['pos', 'kds', 'menu', 'dashboard', 'gst_reports', 'exports'] },
  { key: 'dine-in', name: 'Dine-in', m: 1999, branches: 1, managers: 2, staff: 25, tables: 50, gb: 2,
    on: ['pos', 'kds', 'menu', 'dashboard', 'gst_reports', 'exports', 'qr_ordering', 'coupons', 'reviews', 'refunds', 'own_gateway', 'analytics'] },
  { key: 'growth', name: 'Growth', m: 3499, branches: 2, managers: 4, staff: 50, tables: 100, gb: 5, on: 'all' },
  { key: 'group', name: 'Group', m: 7999, branches: 5, managers: 10, staff: 150, tables: 300, gb: 20, on: 'all' },
];

function seed() {
  if (q.get('SELECT id FROM plans LIMIT 1')) { console.log('Already seeded.'); return; }
  q.tx(() => {
    const ids = {};
    for (const p of PLANS) {
      const id = +q.run('INSERT INTO plans(key,name,price_monthly,price_yearly,trial_days) VALUES (?,?,?,?,14)', p.key, p.name, p.m, Math.round(p.m * 12 * 0.83)).lastInsertRowid;
      ids[p.key] = id;
      for (const k of Object.keys(F.FEATURES)) q.run('INSERT INTO plan_features VALUES (?,?,?)', id, k, p.on === 'all' || p.on.includes(k) ? 1 : 0);
      const lim = { branches: p.branches, managers: p.managers, staff: p.staff, tables: p.tables, storage_mb: p.gb * 1024 };
      for (const [k, v] of Object.entries(lim)) q.run('INSERT INTO plan_limits VALUES (?,?,?)', id, k, v);
    }
    q.run('INSERT INTO users(tenant_id,name,email,password_hash,role) VALUES (NULL,?,?,?,?)', 'Platform Admin', 'admin@platform.test', hash('admin123'), 'platform_admin');
    q.run("INSERT INTO platform_coupons(code,percent,usage_limit) VALUES ('LAUNCH20',20,50)");

    // Demo restaurant on the Growth plan (all modules on) with an active subscription
    const t = +q.run("INSERT INTO tenants(name,slug,status,gstin,address) VALUES ('Spice Garden','spice-garden','active','29ABCDE1234F1Z5','12 MG Road, Bengaluru')").lastInsertRowid;
    q.run('INSERT INTO tenant_subscriptions(tenant_id,plan_id,start_at,end_at,status,billing_cycle) VALUES (?,?,?,?,?,?)', t, ids.growth, F.now(), new Date(Date.now() + 30 * 864e5).toISOString(), 'active', 'monthly');
    const br = +q.run("INSERT INTO branches(tenant_id,name,address) VALUES (?,?,?)", t, 'MG Road', '12 MG Road').lastInsertRowid;
    const mk = (n, e, role) => q.run('INSERT INTO users(tenant_id,name,email,password_hash,role,branch_id) VALUES (?,?,?,?,?,?)', t, n, e, hash('demo123'), role, br);
    mk('Asha (Owner)', 'owner@spice.test', 'owner'); mk('Ravi (Manager)', 'manager@spice.test', 'manager'); mk('Kiran (Cashier)', 'cashier@spice.test', 'cashier');
    mk('Meena (Waiter)', 'waiter@spice.test', 'waiter'); mk('Chef Sam', 'kitchen@spice.test', 'kitchen');
    const cats = {};
    for (const c of ['Starters', 'Mains', 'Breads', 'Drinks', 'Desserts']) cats[c] = +q.run('INSERT INTO categories(tenant_id,branch_id,name) VALUES (?,?,?)', t, br, c).lastInsertRowid;
    const items = [
      ['Starters', 'Paneer Tikka', 240, 1, 5, [{ name: 'Extra mint chutney', price: 20 }]], ['Starters', 'Chicken 65', 280, 0, 5, []], ['Starters', 'Veg Spring Rolls', 180, 1, 5, []],
      ['Mains', 'Butter Chicken', 340, 0, 5, [{ name: 'Extra gravy', price: 40 }]], ['Mains', 'Dal Makhani', 220, 1, 5, []], ['Mains', 'Veg Biryani', 260, 1, 5, [{ name: 'Raita', price: 30 }]], ['Mains', 'Chicken Biryani', 320, 0, 5, [{ name: 'Raita', price: 30 }]],
      ['Breads', 'Butter Naan', 60, 1, 5, []], ['Breads', 'Garlic Naan', 75, 1, 5, []], ['Breads', 'Tandoori Roti', 30, 1, 5, []],
      ['Drinks', 'Masala Chai', 50, 1, 5, []], ['Drinks', 'Fresh Lime Soda', 90, 1, 5, []], ['Drinks', 'Cold Coffee', 140, 1, 18, []],
      ['Desserts', 'Gulab Jamun', 110, 1, 5, []], ['Desserts', 'Brownie with Ice Cream', 190, 1, 18, []],
    ];
    for (const [c, n, p, v, g, a] of items) q.run('INSERT INTO menu_items(tenant_id,branch_id,category_id,name,price,veg,gst_rate,addons) VALUES (?,?,?,?,?,?,?,?)', t, br, cats[c], n, p, v, g, JSON.stringify(a));
    for (let i = 1; i <= 8; i++) q.run('INSERT INTO tables_(tenant_id,branch_id,name,qr_token) VALUES (?,?,?,?)', t, br, 'T' + i, require('crypto').randomBytes(9).toString('hex'));
    q.run("INSERT INTO coupons(tenant_id,code,percent,max_discount,min_amount,usage_limit) VALUES (?,?,?,?,?,?)", t, 'WELCOME10', 10, 100, 300, 100);

    // A second tenant on the Starter plan to show feature gating
    const t2 = +q.run("INSERT INTO tenants(name,slug,status) VALUES ('Chai Point (Starter demo)','chai-point','trial')").lastInsertRowid;
    q.run('INSERT INTO tenant_subscriptions(tenant_id,plan_id,start_at,end_at,status) VALUES (?,?,?,?,?)', t2, ids.starter, F.now(), new Date(Date.now() + 14 * 864e5).toISOString(), 'trial');
    const br2 = +q.run("INSERT INTO branches(tenant_id,name) VALUES (?,?)", t2, 'Main branch').lastInsertRowid;
    q.run('INSERT INTO users(tenant_id,name,email,password_hash,role,branch_id) VALUES (?,?,?,?,?,?)', t2, 'Starter Owner', 'owner@chai.test', hash('demo123'), 'owner', br2);
  });
  console.log('Seeded. Logins:\n  admin@platform.test / admin123 (platform admin)\n  owner@spice.test, manager@spice.test, cashier@spice.test, waiter@spice.test, kitchen@spice.test / demo123\n  owner@chai.test / demo123 (Starter plan, features gated)');
}
if (require.main === module) seed();
module.exports = { seed };
