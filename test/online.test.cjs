const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');

if (process.argv[2] === 'child') {
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  process.on('message', message => {
    if (message === 'stop') server.close(() => { require('../server/db').db.close(); process.exit(0); });
  });
} else {
  (async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'alkarim-online-test-'));
    let child;
    let base;
    async function start(password = 'Test-Admin-Password-Only') {
      child = fork(__filename, ['child'], { env: { ...process.env, NODE_ENV: 'production', PUBLIC_APP_URL: 'https://alkarim.test', ALKARIM_DATA: data, INITIAL_ADMIN_USERNAME: 'admin', INITIAL_ADMIN_PASSWORD: password }, silent: true });
      const startup = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Startup timed out')); }, 10000);
        child.once('message', message => { clearTimeout(timer); resolve(message); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error('Server failed to start: ' + code)); });
      });
      base = `http://127.0.0.1:${startup.port}`;
    }
    async function stop() {
      const stopped = once(child, 'exit');
      child.send('stop');
      await stopped;
      child = null;
    }
    async function api(route, body, cookie, origin = 'https://alkarim.test') {
      const response = await fetch(base + '/api' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], setCookie: response.headers.get('set-cookie') };
    }
    try {
      await start();
      assert.equal((await api('/auth/status')).data.needsSetup, false);
      const admin = await api('/auth/login', { username: 'admin', password: 'Test-Admin-Password-Only' });
      assert.equal(admin.status, 200);
      assert.match(admin.setCookie, /; Secure/);
      assert.equal((await api('/users', { name: 'Sales Staff', username: 'staff', password: 'Test-Staff-Password-Only', role: 'sales', active: true }, admin.cookie)).status, 201);
      const mobile = await api('/auth/login', { username: 'staff', password: 'Test-Staff-Password-Only' });
      assert.equal(mobile.status, 200);
      assert.equal((await api('/parties', { company: 'Shared customer', kind: 'customer' }, admin.cookie)).status, 201);
      assert.equal((await api('/parties', null, mobile.cookie)).data[0].company, 'Shared customer');
      assert.equal((await api('/users', { name: 'Forbidden' }, mobile.cookie)).status, 403);
      assert.equal((await api('/auth/setup', { username: 'intruder' })).status, 409);
      assert.equal((await api('/auth/login', { username: 'admin', password: 'Test-Admin-Password-Only' }, null, 'https://another.test')).status, 403);
      assert.equal((await fetch(base + '/')).status, 200);
      await stop();
      await start('This-must-not-reset-the-existing-password');
      const again = await api('/auth/login', { username: 'admin', password: 'Test-Admin-Password-Only' });
      assert.equal(again.status, 200);
      assert.equal((await api('/parties', null, mobile.cookie)).data[0].company, 'Shared customer');
      assert.equal((await api('/users', null, again.cookie)).data.length, 2);
      console.log('PASS: independent admin/staff sessions share records; accounts, sessions and records survive restart; initial credentials never overwrite existing accounts; HTTPS cookie, origin checks and account permissions enforced; client served.');
    } finally {
      if (child) await stop();
      fs.rmSync(data, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
