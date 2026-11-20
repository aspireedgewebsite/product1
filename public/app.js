// Staff app: POS, kitchen display, orders, menu, coupons, reviews, customers, reports, team, settings.
let me, view, socket, refreshers = {};
let branchId = null;
const q = (p) => (branchId ? p + (p.includes('?') ? '&' : '?') + 'branch_id=' + branchId : p);
const can = (perm) => ({ owner: 1, manager: ['orders', 'pos', 'kds', 'tables', 'menu', 'coupons', 'reviews', 'reports', 'refunds', 'staff_view', 'customers'], cashier: ['orders', 'pos', 'tables'], waiter: ['orders', 'pos', 'tables'], kitchen: ['kds'] }[me.role] === 1 || ({ manager: ['orders', 'pos', 'kds', 'tables', 'menu', 'coupons', 'reviews', 'reports', 'refunds', 'staff_view', 'customers'], cashier: ['orders', 'pos', 'tables'], waiter: ['orders', 'pos', 'tables'], kitchen: ['kds'] }[me.role] || []).includes(perm));
const F = () => me.features;

// Menu of screens: shown only when role allows AND the plan has the module (frontend hides what backend would block anyway)
const SCREENS = [
  ['pos', 'POS', () => can('pos') && F().pos], ['kitchen', 'Kitchen', () => can('kds') && F().kds], ['orders', 'Orders & bills', () => can('orders')],
  ['menu', 'Menu', () => can('menu') && F().menu], ['coupons', 'Coupons', () => can('coupons') && F().coupons], ['reviews', 'Reviews', () => can('reviews') && F().reviews],
  ['customers', 'Customers', () => can('customers') && F().loyalty], ['reports', 'Reports', () => can('reports') && F().dashboard],
  ['team', 'Team & tables', () => can('staff_view') || me.role === 'owner'], ['settings', 'Settings', () => me.role === 'owner'],
];

async function boot() {
  if (!token) return (location.href = '/');
  me = await get('/auth/me').catch(() => null); if (!me) return;
  if (me.role === 'platform_admin') return (location.href = '/admin.html');
  $('#brand').textContent = me.tenant.name; $('#who').textContent = `${me.name} · ${me.role}`;
  if (me.impersonated) $('#banner').innerHTML = '<div class="banner">Support session: you are signed in as this restaurant\'s owner. Every action is audited. <a href="/admin.html" onclick="store.del(\'rbs_token\')">Exit</a></div>';
  else if (me.access !== 'ok') $('#banner').innerHTML = `<div class="banner">Your account is <b>${esc(me.access)}</b>. Contact support or renew your plan to continue.</div>`;
  else if (me.subscription?.status === 'trial') { const d = Math.ceil((new Date(me.subscription.end_at) - Date.now()) / 864e5); $('#banner').innerHTML = `<div class="banner">Free trial — ${d} day(s) left on the ${esc(me.subscription.plan_name)} plan. Renewal reminders are sent at 7, 3 and 1 days.</div>`; }
  else { const d = Math.ceil((new Date(me.subscription.end_at) - Date.now()) / 864e5); if (d <= 7) $('#banner').innerHTML = `<div class="banner">Your plan renews in ${d} day(s). Contact us to extend.</div>`; }
  if (me.role === 'owner' && me.branches.length > 1) {
    const s = $('#branchSel'); s.style.display = ''; s.innerHTML = me.branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    branchId = +(store.get('rbs_branch') || me.branches[0].id); s.value = branchId;
    s.onchange = () => { branchId = +s.value; store.set('rbs_branch', branchId); joinRoom(); go(view); };
  }
  const ok = SCREENS.filter((s) => s[2]());
  $('#nav').innerHTML = ok.map(([k, l]) => `<a data-v="${k}">${l}</a>`).join('');
  $('#nav').onclick = (e) => e.target.dataset.v && go(e.target.dataset.v);
  socket = io(); socket.on('connect', joinRoom);
  ['orders:changed', 'tables:changed', 'menu:changed'].forEach((ev) => socket.on(ev, () => refreshers.live && refreshers.live()));
  socket.on('order:ready', (d) => { if (me.role === 'waiter' || me.role === 'cashier' || me.role === 'manager' || me.role === 'owner') toast(`🔔 Ready: ${d.table ? 'Table ' + d.table : 'Token ' + d.token}`, 5000); });
  window.addEventListener('online', () => { $('#offline').style.display = 'none'; flushQueue(); }); window.addEventListener('offline', () => $('#offline').style.display = 'block');
  if (!navigator.onLine) $('#offline').style.display = 'block'; flushQueue(); setInterval(flushQueue, 15000);
  go(location.hash.slice(1) || ok[0]?.[0]);
}
const joinRoom = () => socket.emit('join', { token, branch_id: branchId });
function go(v) {
  const ok = SCREENS.filter((s) => s[2]()); if (!ok.find((s) => s[0] === v)) v = ok[0]?.[0];
  view = v; location.hash = v; refreshers = {};
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.v === v));
  $('#main').innerHTML = '<p class="muted">Loading…</p>'; (V[v] || (() => {}))().catch((e) => { $('#main').innerHTML = `<div class="card b-bad">${esc(e.message)}</div>`; });
}

// ---------- offline queue (POS keeps working when the internet drops) ----------
const getQueue = () => { try { return JSON.parse(store.get('rbs_queue') || '[]'); } catch { return []; } };
const setQueue = (x) => store.set('rbs_queue', JSON.stringify(x));
let flushing = false;
async function flushQueue() {
  if (flushing || !token) return; flushing = true;
  try {
    let list = getQueue(), changed = false;
    for (const item of [...list]) {
      try { await post('/orders', item); list = list.filter((x) => x.client_id !== item.client_id); setQueue(list); changed = true; }
      catch (e) { if (e instanceof NetError) break; list = list.filter((x) => x.client_id !== item.client_id); setQueue(list); toast('Dropped an offline order: ' + e.message, 5000); }
    }
    if (changed) { toast('Offline orders synced'); refreshers.live && refreshers.live(); }
  } finally { flushing = false; }
  $('#offline').textContent = getQueue().length ? `${getQueue().length} order(s) waiting to sync` : 'Offline — orders are saved on this device and will sync when the internet returns.';
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random());

const V = {};
// ---------- POS ----------
V.pos = async () => {
  let tables = [], menu = { categories: [], items: [] }, sel = null /* table id or 'take' */, cart = [], cat = 'all', cust = { name: '', phone: '' }, orders = {};
  try { menu = await get(q('/menu')); store.set('rbs_menu_cache', JSON.stringify(menu)); } catch { try { menu = JSON.parse(store.get('rbs_menu_cache')); } catch {} }
  async function load() {
    try { tables = await get(q('/tables')); const open = await get(q('/orders')); orders = Object.fromEntries(open.map((o) => [o.table_id || 'take' + o.id, o])); } catch {}
    draw();
  }
  const openOrder = () => (sel && sel !== 'take' ? orders[sel] : null);
  function draw() {
    const items = menu.items.filter((i) => cat === 'all' || i.category_id === cat);
    const o = openOrder(), cartSub = cart.reduce((s, c) => s + (c.item.price + c.addons.reduce((a, n) => a + (c.item.addons.find((x) => x.name === n)?.price || 0), 0)) * c.qty, 0);
    $('#main').innerHTML = `<div class="pos"><div>
      <div class="row"><h2 class="grow">Tables</h2><button class="sm ${sel === 'take' ? 'primary' : ''}" data-take>＋ Takeaway</button></div>
      <div class="grid g4">${tables.map((t) => `<div class="tbl ${t.status} ${sel === t.id ? 'sel' : ''}" data-t="${t.id}"><b>${esc(t.name)}</b><div class="small muted">${t.status === 'occupied' ? 'Occupied' : 'Free'}${t.waiter_name ? ' · ' + esc(t.waiter_name) : ''}</div></div>`).join('') || '<p class="muted">No tables yet — add some in Team &amp; tables.</p>'}</div>
      <h2 class="mt">Menu</h2><div class="chips"><span class="chip ${cat === 'all' ? 'on' : ''}" data-c="all">All</span>${menu.categories.map((c) => `<span class="chip ${cat === c.id ? 'on' : ''}" data-c="${c.id}">${esc(c.name)}</span>`).join('')}</div>
      <div class="items">${items.map((i) => `<button class="item ${i.available ? '' : 'off'}" data-i="${i.id}" ${i.available ? '' : 'disabled'}><span class="dot ${i.veg ? 'veg' : 'nonveg'}"></span>${esc(i.name)}<div class="small muted">${inr(i.price)}${i.available ? '' : ' · sold out'}</div></button>`).join('')}</div></div>
      <div class="card" style="align-self:start;position:sticky;top:70px"><h2>${sel === 'take' ? 'Takeaway order' : sel ? 'Table ' + esc(tables.find((t) => t.id === sel)?.name) : 'Pick a table'}</h2>
        ${o ? `<div class="small muted">Sent to kitchen (${esc(o.status)}):</div><table>${o.items.map((i) => `<tr style="${i.deleted ? 'text-decoration:line-through;opacity:.5' : ''}"><td>${i.qty}× ${esc(i.name)}${i.addons.length ? `<div class="small muted">+ ${esc(i.addons.map((a) => a.name).join(', '))}</div>` : ''}</td><td class="right">${inr(i.line)}</td><td><button class="sm" data-del="${i.id}" data-restore="${i.deleted}">${i.deleted ? '↺' : '✕'}</button></td></tr>`).join('')}</table>
        <div class="row"><b class="grow">Bill (ex-GST)</b><b>${inr(o.bill.subtotal)}</b></div><div class="row mt"><button class="sm" data-kot="${o.id}">Print KOT</button><button class="primary grow" data-bill="${o.id}">Bill & pay</button></div><hr>` : ''}
        ${cart.length ? `<div class="small muted">New items (not yet sent):</div><table>${cart.map((c, n) => `<tr><td>${esc(c.item.name)}${c.addons.length ? `<div class="small muted">+ ${esc(c.addons.join(', '))}</div>` : ''}${c.note ? `<div class="small muted">“${esc(c.note)}”</div>` : ''}</td><td><button class="sm" data-q="${n}:-1">−</button> ${c.qty} <button class="sm" data-q="${n}:1">＋</button></td></tr>`).join('')}</table>
        ${sel === 'take' || (sel && !o) ? `<label>Customer phone (for coins)</label><input id="cph" value="${esc(cust.phone)}" inputmode="numeric"><label>Name</label><input id="cnm" value="${esc(cust.name)}">` : ''}
        <div class="row mt"><b class="grow">${inr(cartSub)}</b><button data-clear>Clear</button><button class="primary" data-send>Send to kitchen</button></div>` : `<p class="muted small">${sel ? 'Tap menu items to add them.' : 'Select a table or takeaway.'}</p>`}
      </div></div>`;
    const m = $('#main');
    m.querySelectorAll('[data-t]').forEach((e) => e.onclick = () => { sel = +e.dataset.t; draw(); });
    m.querySelector('[data-take]').onclick = () => { sel = 'take'; draw(); };
    m.querySelectorAll('[data-c]').forEach((e) => e.onclick = () => { cat = e.dataset.c === 'all' ? 'all' : +e.dataset.c; draw(); });
    m.querySelectorAll('[data-i]').forEach((e) => e.onclick = () => addItem(+e.dataset.i));
    m.querySelectorAll('[data-q]').forEach((e) => e.onclick = () => { const [n, d] = e.dataset.q.split(':').map(Number); cart[n].qty += d; if (cart[n].qty < 1) cart.splice(n, 1); draw(); });
    m.querySelectorAll('[data-del]').forEach((e) => e.onclick = guard(async () => { await post(`/orders/${o.id}/items/${e.dataset.del}/delete`, { restore: e.dataset.restore === '1' }); load(); }));
    m.querySelector('[data-clear]')?.addEventListener('click', () => { cart = []; draw(); });
    m.querySelector('[data-send]')?.addEventListener('click', send);
    m.querySelector('[data-kot]')?.addEventListener('click', () => openPrint(`/orders/${o.id}/kot`));
    m.querySelector('[data-bill]')?.addEventListener('click', () => billModal(o));
    ['cph', 'cnm'].forEach((id) => { const el = $('#' + id); if (el) el.oninput = () => { cust[id === 'cph' ? 'phone' : 'name'] = el.value; }; });
  }
  function addItem(id) {
    if (!sel) return toast('Select a table or takeaway first');
    const item = menu.items.find((i) => i.id === id);
    const add = (addons, note) => { const ex = cart.find((c) => c.item.id === id && c.addons.join() === addons.join() && c.note === note); ex ? ex.qty++ : cart.push({ item, qty: 1, addons, note }); draw(); };
    if (!item.addons.length) return add([], '');
    modal(`<h3>${esc(item.name)}</h3>${item.addons.map((a, n) => `<label class="row"><input type="checkbox" style="width:auto" value="${esc(a.name)}"> ${esc(a.name)} (+${inr(a.price)})</label>`).join('')}<label>Note</label><input id="nt"><div class="row mt"><button class="primary" id="ok">Add</button></div>`,
      (md) => md.querySelector('#ok').onclick = () => { add([...md.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value), md.querySelector('#nt').value); md.remove(); });
  }
  async function send() {
    const body = { type: sel === 'take' ? 'takeaway' : 'dine_in', table_id: sel === 'take' ? null : sel, customer_phone: cust.phone.replace(/\D/g, '').slice(-10) || undefined, customer_name: cust.name || undefined,
      client_id: uid(), items: cart.map((c) => ({ item_id: c.item.id, qty: c.qty, addons: c.addons, note: c.note })) };
    try { await post('/orders', body); toast('Sent to kitchen'); }
    catch (e) { if (!(e instanceof NetError)) return toast(e.message); setQueue([...getQueue(), body]); toast('Offline: order saved and will sync automatically'); flushQueue(); }
    cart = []; if (sel === 'take') sel = null; load();
  }
  function billModal(o) {
    let coupon = '', coins = 0, prev = o.bill;
    const m = modal('', null);
    const paint = () => { m.firstChild.innerHTML = `<h3>Bill — ${o.table_name ? 'Table ' + esc(o.table_name) : 'Token ' + o.token}</h3>
      <table>${o.items.filter((i) => !i.deleted).map((i) => `<tr><td>${i.qty}× ${esc(i.name)}</td><td class="right">${inr(i.line)}</td></tr>`).join('')}</table>
      <div class="row mt"><div class="grow"><label>Coupon</label><input id="cp" value="${esc(coupon)}" placeholder="optional" style="text-transform:uppercase"></div>
      ${F().loyalty && o.customer_phone ? `<div class="grow"><label>Use coins (₹1 each)</label><input id="co" type="number" min="0" value="${coins}"></div>` : ''}<button id="ap" style="align-self:flex-end">Apply</button></div>
      <table class="mt"><tr><td>Subtotal</td><td class="right">${inr(prev.subtotal)}</td></tr>${prev.discount ? `<tr><td>Discount</td><td class="right">−${inr(prev.discount)}</td></tr>` : ''}<tr><td>CGST</td><td class="right">${inr(prev.cgst)}</td></tr><tr><td>SGST</td><td class="right">${inr(prev.sgst)}</td></tr><tr><td><b>Total</b></td><td class="right stat">${inr(prev.total)}</td></tr></table>
      <div class="row mt"><button class="primary grow" data-pay="cash">Cash</button><button class="primary grow" data-pay="upi">UPI</button><button class="primary grow" data-pay="card">Card</button></div>`;
      m.querySelector('#ap').onclick = guard(async () => { coupon = m.querySelector('#cp').value; coins = +(m.querySelector('#co')?.value || 0); prev = await post(`/orders/${o.id}/preview-bill`, { coupon_code: coupon || undefined, coins }); paint(); });
      m.querySelectorAll('[data-pay]').forEach((b) => b.onclick = guard(async () => { const inv = await post(`/orders/${o.id}/bill`, { payment_method: b.dataset.pay, coupon_code: coupon || undefined, coins }); m.remove(); toast('Paid · ' + inv.number); openPrint(`/invoices/${inv.id}/print`); sel = null; load(); }));
    }; paint();
  }
  refreshers.live = load; await load();
};

// ---------- Kitchen display ----------
V.kitchen = async () => {
  async function load() {
    const t = await get(q('/kds'));
    $('#main').innerHTML = `<div class="row"><h2 class="grow">Kitchen display</h2><span class="muted small">${t.length} active ticket(s) · live</span></div><div class="kds mt">${t.map((o) => {
      const min = Math.floor(o.age_sec / 60);
      return `<div class="card ticket ${o.status} ${min >= 15 && o.status !== 'ready' ? 'late' : ''}"><div class="row"><b class="grow">${o.table_name ? 'Table ' + esc(o.table_name) : 'Token ' + o.token}</b><span class="badge ${min >= 15 ? 'b-bad' : 'b-mute'}">${min}m</span></div>
      <div class="small muted">#${o.id} · ${esc(o.source === 'qr' ? 'QR guest' : 'POS')} · ${esc(o.status)}</div><hr>${o.items.filter((i) => !i.deleted).map((i) => `<div><b>${i.qty}×</b> ${esc(i.name)}${i.addons.length ? `<div class="small muted">+ ${esc(i.addons.map((a) => a.name).join(', '))}</div>` : ''}${i.note ? `<div class="small b-warn">“${esc(i.note)}”</div>` : ''}</div>`).join('')}
      <div class="row mt">${o.status === 'new' ? `<button class="primary grow" data-s="${o.id}:preparing">Start preparing</button>` : o.status === 'preparing' ? `<button class="primary grow" data-s="${o.id}:ready">Mark ready</button>` : `<button class="grow" data-s="${o.id}:served">Served</button>`}</div></div>`; }).join('') || '<p class="muted">No active tickets. 🎉</p>'}</div>`;
    $('#main').querySelectorAll('[data-s]').forEach((b) => b.onclick = guard(async () => { const [id, s] = b.dataset.s.split(':'); await post(`/orders/${id}/status`, { status: s }); load(); }));
  }
  refreshers.live = load; await load(); const iv = setInterval(() => (view === 'kitchen' ? load() : clearInterval(iv)), 30000);
};

// ---------- Orders & bills ----------
V.orders = async () => {
  const invs = await get(q('/invoices'));
  $('#main').innerHTML = `<h2>Recent bills</h2><div class="card"><table><tr><th>Invoice</th><th>Date</th><th>Paid by</th><th class="right">Total</th><th>Status</th><th></th></tr>${invs.map((i) => `<tr><td>${esc(i.number)}</td><td>${esc(i.created_at)}</td><td>${esc(i.payment_method)}</td><td class="right">${inr(i.total)}</td><td><span class="badge ${i.payment_status === 'paid' ? 'b-ok' : 'b-warn'}">${esc(i.payment_status)}</span>${i.refunded ? ` <span class="small muted">−${inr(i.refunded)}</span>` : ''}</td>
    <td><button class="sm" data-p="${i.id}">Print</button> ${F().refunds && can('refunds') && i.total > i.refunded ? `<button class="sm danger" data-r="${i.id}:${(i.total - i.refunded).toFixed(2)}">Refund</button>` : ''}</td></tr>`).join('') || '<tr><td colspan=6 class="muted">No bills yet.</td></tr>'}</table></div>`;
  $('#main').querySelectorAll('[data-p]').forEach((b) => b.onclick = () => openPrint(`/invoices/${b.dataset.p}/print`));
  $('#main').querySelectorAll('[data-r]').forEach((b) => b.onclick = () => { const [id, max] = b.dataset.r.split(':'); modal(`<h3>Refund (max ${inr(max)})</h3><label>Amount</label><input id="am" type="number" step="0.01" value="${max}"><label>Reason</label><input id="rs"><div class="row mt"><button class="primary" id="go">Issue credit note</button></div>`,
    (md) => md.querySelector('#go').onclick = guard(async () => { const r = await post(`/invoices/${id}/refund`, { amount: md.querySelector('#am').value, reason: md.querySelector('#rs').value }); md.remove(); toast('Credit note ' + r.credit_note); V.orders(); })); });
};

// ---------- Menu management ----------
V.menu = async () => {
  const m = await get(q('/menu')); const canEdit = can('menu');
  $('#main').innerHTML = `<div class="row"><h2 class="grow">Menu</h2>${canEdit ? '<button id="addc">＋ Category</button><button id="addi" class="primary">＋ Item</button><button id="imp">Bulk import (CSV)</button>' : ''}</div>
  ${m.categories.concat([{ id: null, name: 'Uncategorised' }]).map((c) => { const its = m.items.filter((i) => i.category_id === c.id); if (!its.length && c.id === null) return ''; return `<div class="card mt"><div class="row"><h3 class="grow">${esc(c.name)}</h3>${canEdit && c.id ? `<button class="sm danger" data-dc="${c.id}">Delete category</button>` : ''}</div><table>${its.map((i) => `<tr><td><span class="dot ${i.veg ? 'veg' : 'nonveg'}"></span>${esc(i.name)}${i.image_path ? ` <img src="${esc(i.image_path)}" height="24" alt="">` : ''}<div class="small muted">GST ${i.gst_rate}%${i.addons.length ? ' · add-ons: ' + esc(i.addons.map((a) => a.name).join(', ')) : ''}${i.available_from ? ` · ${i.available_from}–${i.available_to}` : ''}</div></td><td class="right">${inr(i.price)}</td>
    <td class="right"><label class="row" style="justify-content:flex-end;margin:0"><input type="checkbox" style="width:auto" data-av="${i.id}" ${i.available ? 'checked' : ''}> in stock</label></td>${canEdit ? `<td class="right"><button class="sm" data-e="${i.id}">Edit</button> <button class="sm danger" data-d="${i.id}">✕</button></td>` : '<td></td>'}</tr>`).join('')}</table></div>`; }).join('')}`;
  const R = $('#main');
  R.querySelectorAll('[data-av]').forEach((c) => c.onchange = guard(async () => { await post(`/menu/items/${c.dataset.av}/available`, { available: c.checked }); toast(c.checked ? 'Back on all menus' : 'Hidden from QR menu'); }));
  R.querySelectorAll('[data-d]').forEach((b) => b.onclick = guard(async () => { if (confirm('Delete this item?')) { await del('/menu/items/' + b.dataset.d); V.menu(); } }));
  R.querySelectorAll('[data-dc]').forEach((b) => b.onclick = guard(async () => { if (confirm('Delete category? Items stay uncategorised.')) { await del('/menu/categories/' + b.dataset.dc); V.menu(); } }));
  $('#addc') && ($('#addc').onclick = guard(async () => { const n = prompt('Category name'); if (n) { await post(q('/menu/categories'), { name: n }); V.menu(); } }));
  const form = (it = {}) => modal(`<h3>${it.id ? 'Edit' : 'New'} item</h3><label>Name</label><input id="n" value="${esc(it.name || '')}"><div class="row"><div class="grow"><label>Price (ex-GST ₹)</label><input id="p" type="number" step="0.01" value="${it.price ?? ''}"></div><div class="grow"><label>GST %</label><select id="g">${[0, 5, 12, 18, 28].map((g) => `<option ${(it.gst_rate ?? 5) === g ? 'selected' : ''}>${g}</option>`).join('')}</select></div></div>
    <div class="row"><div class="grow"><label>Category</label><select id="c"><option value="">—</option>${m.categories.map((c) => `<option value="${c.id}" ${it.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div><div class="grow"><label>Type</label><select id="v"><option value="1">Veg</option><option value="0" ${it.veg === 0 ? 'selected' : ''}>Non-veg</option></select></div></div>
    <label>Add-ons (one per line: name, price)</label><textarea id="a" rows="3">${esc((it.addons || []).map((a) => `${a.name}, ${a.price}`).join('\n'))}</textarea>
    <div class="row"><div class="grow"><label>Available from</label><input id="f" type="time" value="${it.available_from || ''}"></div><div class="grow"><label>to</label><input id="t" type="time" value="${it.available_to || ''}"></div></div>
    ${it.id ? '<label>Photo (PNG/JPEG/WebP, max 2 MB; counts toward plan storage)</label><input id="img" type="file" accept="image/*">' : ''}<div class="row mt"><button class="primary" id="s">Save</button></div>`, (md) => {
    md.querySelector('#s').onclick = guard(async () => {
      const body = { name: md.querySelector('#n').value, price: md.querySelector('#p').value, gst_rate: +md.querySelector('#g').value, category_id: md.querySelector('#c').value || null, veg: md.querySelector('#v').value === '1',
        addons: md.querySelector('#a').value.split('\n').map((l) => l.split(',')).filter((x) => x[0].trim()).map((x) => ({ name: x[0].trim(), price: +x[1] || 0 })), available_from: md.querySelector('#f').value, available_to: md.querySelector('#t').value };
      const r = it.id ? await put('/menu/items/' + it.id, body) : await post(q('/menu/items'), body);
      const f = md.querySelector('#img')?.files[0];
      if (f) { const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); }); await post(`/menu/items/${it.id}/image`, { data }); }
      md.remove(); V.menu(); });
  });
  $('#addi') && ($('#addi').onclick = () => form()); R.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => form(m.items.find((i) => i.id == b.dataset.e)));
  $('#imp') && ($('#imp').onclick = () => modal(`<h3>Bulk import</h3><p class="small muted">Export your Excel sheet as CSV with a header row: <code>category,name,price,veg,gst_rate</code> (veg/gst_rate optional). Paste below.</p><textarea id="csv" rows="8" placeholder="category,name,price,veg,gst_rate\nStarters,Paneer Tikka,240,1,5"></textarea><div class="row mt"><button class="primary" id="go">Import</button></div>`,
    (md) => md.querySelector('#go').onclick = guard(async () => { const r = await post(q('/menu/import'), { csv: md.querySelector('#csv').value }); toast(`Imported ${r.added} item(s)${r.errors.length ? ' · ' + r.errors.length + ' skipped' : ''}`, 4000); md.remove(); V.menu(); })));
};

// ---------- Coupons ----------
V.coupons = async () => {
  const c = await get('/coupons');
  $('#main').innerHTML = `<h2>Offers & coupons</h2><div class="card"><div class="row"><input id="code" placeholder="CODE" style="width:120px;text-transform:uppercase"><input id="pc" type="number" placeholder="% off" style="width:90px"><input id="mx" type="number" placeholder="Max ₹ off" style="width:110px"><input id="mn" type="number" placeholder="Min bill ₹" style="width:110px"><input id="ul" type="number" placeholder="Usage limit" style="width:110px"><input id="sh" type="number" min="0" max="24" placeholder="From hr" style="width:90px"><input id="eh" type="number" min="0" max="24" placeholder="To hr" style="width:90px"><button class="primary" id="add">Add</button></div><p class="small muted">Time-slot: set From/To hour (24h) to limit when the code works, e.g. 14 → 17 for an afternoon happy hour. Blank = all day / unlimited.</p></div>
  <div class="card mt"><table><tr><th>Code</th><th>Discount</th><th>Min bill</th><th>Used</th><th>Window</th><th></th></tr>${c.filter((x) => x.active).map((x) => `<tr><td><b>${esc(x.code)}</b></td><td>${x.percent}%${x.max_discount ? ` (max ${inr(x.max_discount)})` : ''}</td><td>${x.min_amount ? inr(x.min_amount) : '—'}</td><td>${x.used}${x.usage_limit ? ' / ' + x.usage_limit : ''}</td><td>${x.start_hour}:00–${x.end_hour}:00</td><td><button class="sm danger" data-d="${x.id}">Disable</button></td></tr>`).join('')}</table></div>`;
  $('#add').onclick = guard(async () => { await post('/coupons', { code: $('#code').value, percent: $('#pc').value, max_discount: $('#mx').value, min_amount: $('#mn').value, usage_limit: $('#ul').value, start_hour: $('#sh').value, end_hour: $('#eh').value }); V.coupons(); });
  $('#main').querySelectorAll('[data-d]').forEach((b) => b.onclick = guard(async () => { await del('/coupons/' + b.dataset.d); V.coupons(); }));
};

// ---------- Reviews & complaints ----------
V.reviews = async () => {
  const d = await get('/reviews');
  $('#main').innerHTML = `<h2>Reviews</h2><div class="card"><table>${d.reviews.map((r) => `<tr><td>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</td><td>${esc(r.text)}<div class="small muted">${esc(r.customer_name || 'Guest')} · ${esc(r.created_at)}${r.reply ? ' · Reply: ' + esc(r.reply) : ''}</div></td><td><span class="badge ${r.status === 'approved' ? 'b-ok' : r.status === 'rejected' ? 'b-bad' : 'b-warn'}">${esc(r.status)}</span></td>
  <td><button class="sm" data-a="${r.id}:approved">Approve</button> <button class="sm" data-a="${r.id}:rejected">Reject</button> <button class="sm" data-r="${r.id}">Reply</button></td></tr>`).join('') || '<tr><td class="muted">No reviews yet.</td></tr>'}</table></div>
  <h2 class="mt">Complaint desk</h2><div class="card"><table>${d.complaints.map((c) => `<tr><td>${esc(c.text)}<div class="small muted">${esc(c.customer_name || 'Guest')} · ${esc(c.created_at)}</div></td><td><span class="badge ${c.status === 'open' ? 'b-bad' : 'b-ok'}">${esc(c.status)}</span></td><td><button class="sm" data-c="${c.id}:${c.status === 'open' ? 'resolved' : 'open'}">Mark ${c.status === 'open' ? 'resolved' : 'open'}</button></td></tr>`).join('') || '<tr><td class="muted">No complaints.</td></tr>'}</table></div>`;
  const R = $('#main');
  R.querySelectorAll('[data-a]').forEach((b) => b.onclick = guard(async () => { const [id, s] = b.dataset.a.split(':'); await post('/reviews/' + id, { status: s }); V.reviews(); }));
  R.querySelectorAll('[data-r]').forEach((b) => b.onclick = guard(async () => { const t = prompt('Reply'); if (t) { await post('/reviews/' + b.dataset.r, { reply: t }); V.reviews(); } }));
  R.querySelectorAll('[data-c]').forEach((b) => b.onclick = guard(async () => { const [id, s] = b.dataset.c.split(':'); await post('/complaints/' + id, { status: s }); V.reviews(); }));
};

// ---------- Customers ----------
V.customers = async () => {
  const c = await get('/customers');
  $('#main').innerHTML = `<h2>Customers</h2><div class="card"><table><tr><th>Name</th><th>Phone</th><th>Visits</th><th class="right">Spend</th><th class="right">Coins</th><th>Last visit</th></tr>${c.map((x) => `<tr><td>${esc(x.name || '—')}</td><td>${esc(x.phone)}</td><td>${x.visits}</td><td class="right">${inr(x.total_spend)}</td><td class="right">${x.coins}</td><td>${esc(x.last_visit)}</td></tr>`).join('') || '<tr><td colspan=6 class="muted">No customers yet. Coins are earned on paid QR orders when the guest enters a phone number.</td></tr>'}</table></div>`;
};

// ---------- Reports ----------
V.reports = async () => {
  const today = new Date().toISOString().slice(0, 10), from0 = new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10);
  const range = { from: from0, to: today }; let scope = branchId || '';
  async function load() {
    const qs = `from=${range.from}&to=${range.to}${scope === 'all' ? '&branch_id=all' : scope ? '&branch_id=' + scope : ''}`;
    const d = await get('/reports/dashboard?' + qs); const a = F().analytics ? await get('/reports/analytics?' + qs) : null; const g = F().gst_reports ? await get('/reports/gst?' + qs) : null;
    const max = (arr, k) => Math.max(1, ...arr.map((x) => x[k]));
    $('#main').innerHTML = `<div class="row"><h2 class="grow">Dashboard</h2>${me.role === 'owner' && me.branches.length > 1 ? `<select id="sc" style="width:auto"><option value="all" ${scope === 'all' ? 'selected' : ''}>All branches</option>${me.branches.map((b) => `<option value="${b.id}" ${+scope === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>` : ''}<input type="date" id="f" value="${range.from}" style="width:auto"><input type="date" id="t" value="${range.to}" style="width:auto"></div>
    <div class="grid g4 mt"><div class="card"><div class="stat">${inr(d.today_sales)}</div><div class="stat-l">Today's sales</div></div><div class="card"><div class="stat">${d.today_bills}</div><div class="stat-l">Bills today</div></div><div class="card"><div class="stat">${inr(d.avg_bill)}</div><div class="stat-l">Average bill</div></div><div class="card"><div class="stat">${d.open_orders}</div><div class="stat-l">Open orders</div></div><div class="card"><div class="stat">${d.tables_occupied}/${d.tables_total}</div><div class="stat-l">Tables occupied</div></div></div>
    ${a ? `<div class="grid g2 mt"><div class="card"><h3>Sales by day</h3>${a.sales_by_day.map((x) => `<div class="row small"><span style="width:80px">${x.d.slice(5)}</span><div class="grow"><div class="bar" style="width:${(x.sales / max(a.sales_by_day, 'sales')) * 100}%"></div></div><span style="width:90px" class="right">${inr(x.sales)}</span></div>`).join('') || '<p class="muted">No sales in range.</p>'}</div>
    <div class="card"><h3>Bestsellers</h3><table>${a.bestsellers.map((x) => `<tr><td>${esc(x.name)}</td><td class="right">${x.qty}</td><td class="right">${inr(x.revenue)}</td></tr>`).join('')}</table></div>
    <div class="card"><h3>Peak hours</h3>${a.peak_hours.map((x) => `<div class="row small"><span style="width:50px">${String(x.hour).padStart(2, '0')}:00</span><div class="grow"><div class="bar" style="width:${(x.bills / max(a.peak_hours, 'bills')) * 100}%"></div></div><span style="width:50px" class="right">${x.bills}</span></div>`).join('') || '<p class="muted">No data.</p>'}</div>
    <div class="card"><h3>Staff performance</h3><table>${a.staff.map((x) => `<tr><td>${esc(x.name)} <span class="muted small">${esc(x.role)}</span></td><td class="right">${x.bills} bills</td><td class="right">${inr(x.sales)}</td></tr>`).join('')}</table>${a.by_branch ? `<h3 class="mt">By branch</h3><table>${a.by_branch.map((x) => `<tr><td>${esc(x.name)}</td><td class="right">${x.bills}</td><td class="right">${inr(x.sales)}</td></tr>`).join('')}</table>` : ''}</div></div>` : '<div class="card mt muted">Analytics is not part of your plan.</div>'}
    ${g ? `<div class="card mt"><div class="row"><h3 class="grow">GST summary</h3>${F().exports ? '<button class="sm" id="csv">Download CSV</button>' : ''}</div><p class="small muted">${g.invoices} invoice(s) · Taxable ${inr(g.taxable)} · CGST ${inr(g.cgst)} · SGST ${inr(g.sgst)} · Refunds ${inr(g.refunds)} · Gross ${inr(g.total)}</p><table><tr><th>GST rate</th><th class="right">Taxable value</th><th class="right">Tax</th></tr>${g.by_rate.map((x) => `<tr><td>${x.rate}%</td><td class="right">${inr(x.taxable)}</td><td class="right">${inr(x.tax)}</td></tr>`).join('')}</table></div>` : ''}`;
    $('#f').onchange = () => { range.from = $('#f').value; load(); }; $('#t').onchange = () => { range.to = $('#t').value; load(); }; $('#sc') && ($('#sc').onchange = () => { scope = $('#sc').value; load(); });
    $('#csv') && ($('#csv').onclick = () => download(`/reports/export.csv?${qs}`, `invoices_${range.from}_${range.to}.csv`));
  }
  refreshers.live = load; await load();
};

// ---------- Team & tables ----------
V.team = async () => {
  const [users, tables, storage] = await Promise.all([can('staff_view') ? get('/users') : [], get(q('/tables')), get('/storage')]);
  const L = me.limits, waiters = users.filter((u) => u.role === 'waiter');
  $('#main').innerHTML = `<div class="grid g2"><div class="card"><h2>Team</h2><p class="small muted">Plan limits — managers ${users.filter((u) => u.role === 'manager').length}/${L.managers}, staff ${users.filter((u) => ['cashier', 'waiter', 'kitchen'].includes(u.role)).length}/${L.staff}</p>
  <table>${users.map((u) => `<tr><td>${esc(u.name)}<div class="small muted">${esc(u.email)}</div></td><td>${esc(u.role)}</td><td>${u.role === 'waiter' ? `<label class="row" style="margin:0"><input type="checkbox" style="width:auto" data-av="${u.id}" ${u.available ? 'checked' : ''}> on shift</label>` : ''}${me.role === 'owner' && u.role !== 'owner' ? ` <button class="sm" data-act="${u.id}:${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}</td></tr>`).join('')}</table>
  ${me.role === 'owner' ? `<h3 class="mt">Add staff</h3><div class="row"><input id="un" placeholder="Name" style="width:130px"><input id="ue" placeholder="Email" style="width:170px"><input id="up" placeholder="Password" style="width:120px"><select id="ur" style="width:auto"><option>manager</option><option selected>cashier</option><option>waiter</option><option>kitchen</option></select><button class="primary" id="ua">Add</button></div>` : ''}
  ${me.role === 'owner' ? `<h3 class="mt">Branches</h3><div class="small muted">${me.branches.map((b) => esc(b.name)).join(', ')} (limit ${L.branches})</div><div class="row mt"><input id="bn" placeholder="New branch name" style="width:180px"><button id="ba">Add branch</button></div>` : ''}</div>
  <div class="card"><h2>Tables (${tables.length}/${L.tables})</h2><table>${tables.map((t) => `<tr><td><b>${esc(t.name)}</b> <span class="badge ${t.status === 'occupied' ? 'b-warn' : 'b-ok'}">${esc(t.status)}</span></td>
  <td><select data-w="${t.id}" style="width:auto"><option value="">No waiter</option>${waiters.map((w) => `<option value="${w.id}" ${t.waiter_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></td>
  <td>${F().qr_ordering ? `<button class="sm" data-qr="${t.qr_token}" data-n="${esc(t.name)}">QR</button>` : ''} ${t.open_order_id ? `<button class="sm" data-tr="${t.id}">Move/merge</button>` : ''} <button class="sm" data-cl="${t.id}">Clear</button> <button class="sm danger" data-dt="${t.id}">✕</button></td></tr>`).join('')}</table>
  <div class="row mt"><input id="tn" placeholder="T9, T10, T11 (comma separated)" class="grow"><button class="primary" id="ta">Add tables</button></div><p class="small muted mt">Photo storage: ${storage.used_mb} MB of ${storage.quota_mb} MB used.</p></div></div>`;
  const R = $('#main');
  R.querySelectorAll('[data-av]').forEach((c) => c.onchange = guard(() => api('PATCH', '/users/' + c.dataset.av, { available: c.checked })));
  R.querySelectorAll('[data-act]').forEach((b) => b.onclick = guard(async () => { const [id, a] = b.dataset.act.split(':'); await api('PATCH', '/users/' + id, { active: a === '1' }); V.team(); }));
  $('#ua') && ($('#ua').onclick = guard(async () => { await post(q('/users'), { name: $('#un').value, email: $('#ue').value, password: $('#up').value, role: $('#ur').value }); V.team(); }));
  $('#ba') && ($('#ba').onclick = guard(async () => { await post('/branches', { name: $('#bn').value }); toast('Branch added — reload to switch'); }));
  $('#ta').onclick = guard(async () => { await post(q('/tables'), { names: $('#tn').value }); V.team(); });
  R.querySelectorAll('[data-w]').forEach((s) => s.onchange = guard(() => post(`/tables/${s.dataset.w}/waiter`, { waiter_id: s.value || null })));
  R.querySelectorAll('[data-cl]').forEach((b) => b.onclick = guard(async () => { if (confirm('Clear this table? An unbilled order will be cancelled (audited).')) { await post(`/tables/${b.dataset.cl}/clear`); V.team(); } }));
  R.querySelectorAll('[data-dt]').forEach((b) => b.onclick = guard(async () => { if (confirm('Delete table?')) { await del('/tables/' + b.dataset.dt); V.team(); } }));
  R.querySelectorAll('[data-tr]').forEach((b) => b.onclick = () => modal(`<h3>Move or merge order</h3><p class="small muted">If the target table has an open order, items are merged into it.</p><select id="to">${tables.filter((t) => t.id != b.dataset.tr).map((t) => `<option value="${t.id}">${esc(t.name)} (${t.status})</option>`).join('')}</select><div class="row mt"><button class="primary" id="go">Move</button></div>`,
    (md) => md.querySelector('#go').onclick = guard(async () => { const r = await post(`/tables/${b.dataset.tr}/transfer`, { to_table_id: +md.querySelector('#to').value }); md.remove(); toast(r.merged ? 'Merged' : 'Moved'); V.team(); })));
  R.querySelectorAll('[data-qr]').forEach((b) => b.onclick = () => { const url = `${location.origin}/m/${b.dataset.qr}`; modal(`<h3>Table ${esc(b.dataset.n)} QR link</h3><p>Print this as a QR code for the table (any QR generator works):</p><input value="${esc(url)}" readonly onclick="this.select()"><div class="row mt"><a href="${esc(url)}" target="_blank">Open guest menu</a></div>`); });
};

// ---------- Settings ----------
V.settings = async () => {
  const s = await get('/settings'), audit = await get('/audit');
  $('#main').innerHTML = `<div class="grid g2"><div class="card"><h2>Restaurant</h2><label>Name</label><input id="n" value="${esc(s.name)}"><label>GSTIN</label><input id="g" value="${esc(s.gstin || '')}"><label>Address</label><input id="a" value="${esc(s.address || '')}">
  ${F().own_gateway ? `<h3 class="mt">Your Razorpay account</h3><p class="small muted">Online QR payments will settle to your own account.</p><label>Key ID</label><input id="k" value="${esc(s.razorpay_key_id || '')}"><label>Key secret ${s.has_secret ? '(saved — leave blank to keep)' : ''}</label><input id="ks" type="password" autocomplete="off">` : '<p class="small muted mt">Connecting your own payment gateway is not part of your plan.</p>'}
  <div class="row mt"><button class="primary" id="sv">Save</button></div></div>
  <div class="card"><h2>Plan</h2><p><b>${esc(me.subscription?.plan_name)}</b> · ${esc(me.subscription?.status)} · ends ${esc((me.subscription?.end_at || '').slice(0, 10))}</p><table>${Object.entries(me.features).map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td class="right"><span class="badge ${v ? 'b-ok' : 'b-mute'}">${v ? 'included' : 'not in plan'}</span></td></tr>`).join('')}</table></div></div>
  <div class="card mt"><h2>Audit trail</h2><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>${audit.map((a) => `<tr><td class="small">${esc(a.created_at)}</td><td>${esc(a.user_name || 'guest/system')}</td><td>${esc(a.action)}</td><td class="small muted">${esc(a.detail)}</td></tr>`).join('')}</table></div>`;
  $('#sv').onclick = guard(async () => { const b = { name: $('#n').value, gstin: $('#g').value, address: $('#a').value }; if ($('#k')) { b.razorpay_key_id = $('#k').value; b.razorpay_key_secret = $('#ks').value; } await put('/settings', b); toast('Saved'); });
};
boot();
