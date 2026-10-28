'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const online = require('./online');
online.configure();
const { DB_FILE } = require('./db');
const { requireAuth, HttpError } = require('./auth');
const { ensureDefaults } = require('./util');
const core = require('./routes/core');

ensureDefaults();
online.initializeAdmin();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(online.protectRequests);
app.use(express.json({ limit: '60mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', core.pub);
app.use('/api', requireAuth);
app.use('/api', core.r);
app.use('/api', require('./routes/master'));
app.use('/api', require('./routes/sales').router);
app.use('/api', require('./routes/ops'));
app.use('/api', require('./routes/reports'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

// Built client
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('*', (req, res) => res.status(503).send('Client not built. Run "npm run build:client".'));
}

// Errors → consistent JSON
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  const msg = String((err && err.message) || err);
  if (/FOREIGN KEY constraint failed/i.test(msg)) return res.status(409).json({ error: 'This record is linked to other records and cannot be changed that way.' });
  if (/UNIQUE constraint failed/i.test(msg)) return res.status(409).json({ error: 'A record with the same code or number already exists.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. The change was not saved.' });
});

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log('\n  Alkarim Packages · Operations platform');
    console.log(`  Database: ${DB_FILE}`);
    console.log(`  Open on this PC:   http://localhost:${PORT}`);
    if (process.env.NODE_ENV === 'production') console.log(`  Shared app: ${process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL}`);
    else lan.forEach((ip) => console.log(`  Open on the LAN:   http://${ip}:${PORT}`));
    console.log('  Press Ctrl+C to stop.\n');
  });
}
module.exports = app;
