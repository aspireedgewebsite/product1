# Restaurant Billing System

Multi-tenant SaaS for restaurants: POS billing, KOT, kitchen display, QR table ordering, payments, loyalty, reports —
with a platform-level admin panel that controls plans, limits and modules per customer.
Built from *Product Plan v2.0*. Covers the MVP (phases 1–3) and the growth modules (phase 4).

## Run it

```bash
npm install
npm start            # http://localhost:3000  (seeds plans + demo data on first run)
npm test             # 32 end-to-end API checks on a throwaway database
```
Requires **Node 22.5+** (uses the built-in `node:sqlite`; it prints an "experimental" warning, which is expected).

| Login | Password | What you see |
|---|---|---|
| admin@platform.test | admin123 | Platform admin panel |
| owner@spice.test | demo123 | Demo restaurant on **Growth** plan (all modules) |
| manager@ / cashier@ / waiter@ / kitchen@spice.test | demo123 | Role-limited screens |
| owner@chai.test | demo123 | **Starter** plan: QR, coupons, analytics etc. locked |

Guest QR menu: Team & tables → **QR** button on a table → open the link (`/m/<token>`).

## How the plan maps to the code

| Plan section | Where |
|---|---|
| 2 / 6 Four control layers, feature flags, **override → plan → deny** | `server/features.js` (`resolve`, `requireFeature`, `withinLimit`), tables in `server/db.js` |
| 3 POS, KOT, split/merge/transfer, takeaway tokens | `server/routes/tenant.js` (orders, tables) · `public/app.js` (POS) |
| Kitchen display New → Preparing → Ready, live timers, waiter notification | `/api/kds`, Socket.IO `order:ready` |
| Real-time sync | `server/lib/rt.js` — rooms per tenant+branch |
| Offline POS | `public/app.js` queue + `client_ops` idempotency table; `public/sw.js` caches the shell |
| QR ordering, sold-out switch, order tracking | `server/routes/public.js`, `public/menu.html` |
| GST invoices, CGST/SGST, refunds + credit notes | `server/lib/billing.js`, `/api/invoices/*` |
| Razorpay (platform or tenant's own account) | `server/lib/razorpay.js` — **mock mode** when no keys |
| Coupons (time-slot, limits), coins loyalty, reviews, complaints | `tenant.js`, `billing.js` |
| Reports: dashboard, analytics, GST summary, CSV, cross-branch | `/api/reports/*` |
| 5 Platform admin: tenants, plan builder, overrides w/ expiry, subscriptions + proration, coupons, impersonation, MRR, audit | `server/routes/platform.js`, `public/admin.html` |
| Plans & prices (Starter ₹999 … Group ₹7,999, ~17% yearly discount) | `server/seed.js` |

## Configuration
`PORT`, `JWT_SECRET` (**required in production**), `DB_PATH`, `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (platform gateway).

## Known gaps / next steps
- **Database:** SQLite for easy local running. The plan suggests PostgreSQL; the SQL is plain and `server/db.js` is the only adapter to swap. Tenant isolation is by `tenant_id` on every query (covered by a test).
- **Not built:** split-bill by guest, Excel/PDF export (CSV + print-to-PDF only), Zomato/Swiggy/WhatsApp/Tally, desktop app, renewal-reminder emails/SMS (banner only), direct thermal-printer drivers (80mm print pages go through the browser/OS printer), rate limiting, password-reset email flow.
- Razorpay is verified against the mock only; test with real test-mode keys before launch.
- Offline mode queues new orders only; billing/payment need a connection.
- Sections 10–18 of the plan (budget, GTM, risks…) are business content and are not software.
