import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTarget, describeTarget, parseEnv, listTargets } from '../lib/targets.mjs';

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgsk-targets-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

const BASE = 'DB_HOST=db.internal\nDB_PORT=5432\nDB_USER=analytic\nDB_PASSWORD=\'Ac34#d!x\'\nDB_NAME=app\n';

test('a target without DB_SSH_HOST connects directly (ssh = null)', () => {
  const dir = fixture({ '.db.local': BASE });
  const t = loadTarget(dir, 'local');
  assert.equal(t.ssh, null);
  assert.equal(t.pgConfig.password, 'Ac34#d!x');
});

test('passwords keep # and ! with or without quotes', () => {
  assert.equal(parseEnv('P=Ac34#d!x').P, 'Ac34#d!x');
  assert.equal(parseEnv("P='Ac34#d!x'").P, 'Ac34#d!x');
});

test('bastion settings are parsed, ~ expanded, reuse on by default', () => {
  const dir = fixture({ 'bastion.pem': 'k' });
  fs.writeFileSync(path.join(dir, '.db.dev'),
    `${BASE}DB_SSH_HOST=203.0.113.10\nDB_SSH_USER=ec2-user\nDB_SSH_PORT=2222\nDB_SSH_KEY=${path.join(dir, 'bastion.pem')}\n`);
  const t = loadTarget(dir, 'dev');
  assert.deepEqual(t.ssh, { host: '203.0.113.10', user: 'ec2-user', port: 2222, key: path.join(dir, 'bastion.pem'), reuse: true });

  const home = fs.mkdtempSync(path.join(os.homedir(), '.pgsk-test-'));
  fs.writeFileSync(path.join(home, 'k.pem'), 'k');
  fs.writeFileSync(path.join(dir, '.db.home'), `${BASE}DB_SSH_HOST=alias\nDB_SSH_KEY=~/${path.basename(home)}/k.pem\nDB_SSH_REUSE=false\n`);
  const h = loadTarget(dir, 'home');
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(h.ssh.key, path.join(home, 'k.pem'));
  assert.equal(h.ssh.reuse, false);
  assert.equal(h.ssh.user, null);
});

test('invalid bastion settings are rejected before connecting', () => {
  const dir = fixture({
    '.db.nokey': `${BASE}DB_SSH_HOST=203.0.113.10\nDB_SSH_KEY=/no/such/key.pem\n`,
    '.db.badport': `${BASE}DB_SSH_HOST=203.0.113.10\nDB_SSH_PORT=99999\n`,
    '.db.dash': `${BASE}DB_SSH_HOST=-oProxyCommand=touch_x\n`,
    '.db.dashuser': `${BASE}DB_SSH_HOST=203.0.113.10\nDB_SSH_USER=-x\n`,
  });
  for (const name of ['nokey', 'badport', 'dash', 'dashuser']) {
    assert.throws(() => loadTarget(dir, name), err => err.code === 'TARGET_INVALID', name);
  }
});

test('list labels show which targets go through a bastion', () => {
  const dir = fixture({
    '.db.local': BASE,
    '.db.dev': `${BASE}DB_SSH_HOST=203.0.113.10\nDB_SSH_USER=ec2-user\n`,
  });
  assert.deepEqual(listTargets(dir), ['dev', 'local']);
  assert.equal(describeTarget(dir, 'dev'), 'dev  (via bastion ec2-user@203.0.113.10)');
  assert.equal(describeTarget(dir, 'local'), 'local');
});
