import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSshArgs, controlPath, classifySshFailure, hashHostName, knownHostsName, preferredKey, runCommand, bastionLabel,
} from '../lib/ssh.mjs';

const CFG = { controlPersistSeconds: 600, connectTimeoutSeconds: 10, serverAliveIntervalSeconds: 5, serverAliveCountMax: 2 };
const SSH = { host: '203.0.113.10', user: 'ec2-user', port: null, key: '/keys/bastion.pem', reuse: true };

test('ssh args: forward to the DB, non-interactive, shared connection, key', () => {
  const { args, controlPath: cp } = buildSshArgs(SSH, 'db.internal', 5432, CFG, { dir: '/home/u/.ssh' });
  assert.deepEqual(args.slice(0, 2), ['-W', 'db.internal:5432']);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ConnectTimeout=10'));
  assert.ok(args.includes('ControlMaster=auto'));
  assert.ok(args.includes(`ControlPath=${cp}`));
  assert.ok(args.includes('ControlPersist=600'));
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 4), ['-i', '/keys/bastion.pem', '-o', 'IdentitiesOnly=yes']);
  assert.equal(args.at(-1), 'ec2-user@203.0.113.10');
  assert.ok(!args.includes('-p'));
});

test('ssh args: reuse off (flag or target opt-out) disables multiplexing', () => {
  const off = buildSshArgs(SSH, 'db', 5432, CFG, { reuse: false }).args;
  assert.ok(off.includes('ControlPath=none'));
  assert.ok(!off.includes('ControlMaster=auto'));
  const optOut = buildSshArgs({ ...SSH, reuse: false }, 'db', 5432, CFG).args;
  assert.ok(optOut.includes('ControlPath=none'));
});

test('ssh args: alias without user/key, custom port, IPv6 DB host', () => {
  const { args } = buildSshArgs({ host: 'my-bastion', user: null, port: 2222, key: null, reuse: true }, '::1', 5432, CFG);
  assert.deepEqual(args.slice(0, 2), ['-W', '[::1]:5432']);
  assert.deepEqual(args.slice(-3), ['-p', '2222', 'my-bastion']);
  assert.ok(!args.includes('-i'));
});

test('control socket path is short, stable and per bastion', () => {
  const a = controlPath(SSH, '/var/folders/wg/y4krrkn175d0t99s9y1nw06c0000gn/T');
  assert.equal(a, controlPath(SSH, '/var/folders/wg/y4krrkn175d0t99s9y1nw06c0000gn/T'));
  assert.notEqual(a, controlPath({ ...SSH, user: 'other' }, '/var/folders/wg/y4krrkn175d0t99s9y1nw06c0000gn/T'));
  assert.notEqual(a, controlPath({ ...SSH, port: 2222 }, '/var/folders/wg/y4krrkn175d0t99s9y1nw06c0000gn/T'));
  assert.ok(Buffer.byteLength(a) + 17 < 104);
  assert.equal(controlPath(SSH, '/x'.repeat(50)), null);
});

const STDERR = {
  hostKeyUnknown: 'Host key verification failed.\r\n',
  hostKeyChanged: [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Host key for 203.0.113.10 has changed and you have requested strict checking.',
    'Host key verification failed.',
  ].join('\r\n'),
  authFailed: 'no-such-user@203.0.113.10: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).\r\n',
  keyPermissionsSynthetic: [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    "Permissions 0644 for '/keys/bastion.pem' are too open.",
    'bad permissions: ignore key: /keys/bastion.pem',
    'ec2-user@203.0.113.10: Permission denied (publickey).',
  ].join('\r\n'),
  dbHostUnknown: 'channel 0: open failed: connect failed: Name or service not known\r\nstdio forwarding failed\r\n',
  dbHostUnknownViaShared: 'Stdio forwarding request failed: Session open refused by peer\r\n',
  bastionTimeout: 'ssh: connect to host 203.0.113.10 port 22: Operation timed out\r\n',
  bastionRefused: 'ssh: connect to host 203.0.113.10 port 22: Connection refused\r\n',
  bastionDns: 'ssh: Could not resolve hostname bastion.invalid: nodename nor servname provided, or not known\r\n',
  muxBroken: 'mux_client_request_session: read from master failed: Broken pipe\r\n',
};

test('ssh failures are classified (real captured stderr unless marked synthetic)', () => {
  assert.deepEqual(classifySshFailure(STDERR.hostKeyUnknown), { kind: 'HOST_KEY_VERIFICATION', retryable: false });
  assert.deepEqual(classifySshFailure(STDERR.hostKeyChanged), { kind: 'HOST_KEY_CHANGED', retryable: false });
  assert.deepEqual(classifySshFailure(STDERR.authFailed), { kind: 'AUTH_FAILED', retryable: false });
  assert.deepEqual(classifySshFailure(STDERR.keyPermissionsSynthetic), { kind: 'KEY_PERMISSIONS', retryable: false });
  assert.deepEqual(classifySshFailure(STDERR.dbHostUnknown), { kind: 'DB_UNREACHABLE', retryable: false });
  assert.deepEqual(classifySshFailure(STDERR.dbHostUnknownViaShared), { kind: 'DB_UNREACHABLE', retryable: false });
  assert.deepEqual(classifySshFailure(STDERR.bastionTimeout), { kind: 'BASTION_UNREACHABLE', retryable: true });
  assert.deepEqual(classifySshFailure(STDERR.bastionRefused), { kind: 'BASTION_UNREACHABLE', retryable: false });
  assert.deepEqual(classifySshFailure(STDERR.bastionDns), { kind: 'BASTION_UNREACHABLE', retryable: false });
  assert.deepEqual(classifySshFailure(STDERR.muxBroken), { kind: 'TUNNEL_FAILED', retryable: true });
  assert.deepEqual(classifySshFailure('something new'), { kind: 'TUNNEL_FAILED', retryable: false });
});

test('known_hosts name uses [host]:port only for non-22 ports and honours HostKeyAlias', () => {
  assert.equal(knownHostsName({ hostname: '203.0.113.10', port: 22 }), '203.0.113.10');
  assert.equal(knownHostsName({ hostname: '203.0.113.10', port: 2222 }), '[203.0.113.10]:2222');
  assert.equal(knownHostsName({ hostname: '203.0.113.10', hostKeyAlias: 'bastion', port: 22 }), 'bastion');
});

test('preferred key follows ssh HostKeyAlgorithms order', () => {
  const keys = [
    { keyType: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:ec' },
    { keyType: 'ssh-ed25519', fingerprint: 'SHA256:ed' },
    { keyType: 'ssh-rsa', fingerprint: 'SHA256:rsa' },
  ];
  const algs = ['ssh-ed25519-cert-v01@openssh.com', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512'];
  assert.equal(preferredKey(keys, algs).fingerprint, 'SHA256:ed');
  assert.equal(preferredKey(keys.filter(k => k.keyType !== 'ssh-ed25519'), algs).fingerprint, 'SHA256:ec');
  assert.equal(preferredKey([keys[2]], algs).fingerprint, 'SHA256:rsa');
});

test('hashed known_hosts entries are found by ssh-keygen -F', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgsk-test-'));
  const file = path.join(dir, 'known_hosts');
  fs.writeFileSync(file, `${hashHostName('[203.0.113.10]:2222')} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII3hOkYg8x5vXq7m1n5vXq7m1n5vXq7m1n5vXq7m1n5v\n`);
  const found = await runCommand('ssh-keygen', ['-F', '[203.0.113.10]:2222', '-f', file]);
  const missing = await runCommand('ssh-keygen', ['-F', '203.0.113.11', '-f', file]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(found.code, 0);
  assert.match(found.stdout, /ssh-ed25519/);
  assert.notEqual(missing.code, 0);
});

test('bastion label', () => {
  assert.equal(bastionLabel(SSH), 'ec2-user@203.0.113.10');
  assert.equal(bastionLabel({ host: 'b', user: null, port: 2222 }), 'b:2222');
});

test('ssh args pin the log level; the shared socket lives in ~/.ssh', async () => {
  const { args } = buildSshArgs(SSH, 'db', 5432, CFG);
  assert.ok(args.includes('LogLevel=ERROR'));
  assert.equal(path.dirname(controlPath(SSH)), path.join(os.homedir(), '.ssh'));
  const { SSH_ENV } = await import('../lib/ssh.mjs');
  assert.equal(SSH_ENV.LC_ALL, 'C');
});
