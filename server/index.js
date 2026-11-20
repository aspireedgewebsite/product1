const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { q } = require('./db');
const rt = require('./lib/rt');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const platform = require('./routes/platform');
  app.use('/api', platform);
  app.use('/api/public', require('./routes/public'));
  app.use('/api', require('./routes/tenant'));

  app.use('/uploads', express.static(path.join(__dirname, '..', 'data', 'uploads')));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/m/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'menu.html')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });
  return app;
}

function attachSockets(server) {
  const io = new Server(server);
  rt.setIO(io);
  const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
  io.on('connection', (socket) => {
    // Staff join their branch room with a JWT; guests join by table QR token.
    socket.on('join', ({ token, branch_id }) => {
      try {
        const u = q.get('SELECT * FROM users WHERE id=? AND active=1', jwt.verify(token, SECRET).id);
        if (!u?.tenant_id) return;
        let bid = u.branch_id;
        if (u.role === 'owner' && branch_id && q.get('SELECT id FROM branches WHERE id=? AND tenant_id=?', +branch_id, u.tenant_id)) bid = +branch_id;
        socket.join(rt.room(u.tenant_id, bid));
      } catch {}
    });
    socket.on('join-table', ({ qr }) => {
      const t = q.get('SELECT tenant_id,branch_id FROM tables_ WHERE qr_token=?', String(qr || ''));
      if (t) socket.join(rt.room(t.tenant_id, t.branch_id));
    });
  });
  return io;
}

if (require.main === module) {
  require('./seed').seed(); // first run: plans + demo data (no-op once seeded)
  const app = createApp();
  const server = http.createServer(app);
  attachSockets(server);
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`Restaurant Billing System running on http://localhost:${port}`));
}
module.exports = { createApp, attachSockets };
