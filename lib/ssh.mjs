import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UNIX_SOCKET_PATH_MAX = 104;
const SSH_SOCKET_SUFFIX_LENGTH = 17;

export class SshError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.code = 'SSH_ERROR';
    this.kind = kind;
    Object.assign(this, details);
  }
}

export function expandHome(p) {
  return p ? p.replace(/^~(?=$|\/)/, os.homedir()) : p;
}

export function sshDestination(ssh) {
  return ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host;
}

export function bastionLabel(ssh) {
  return ssh.port ? `${sshDestination(ssh)}:${ssh.port}` : sshDestination(ssh);
}

export const SSH_ENV = { ...process.env, LC_ALL: 'C' };

export function defaultControlDir() {
  return path.join(os.homedir(), '.ssh');
}

export function controlPath(ssh, dir = defaultControlDir()) {
  const id = crypto
    .createHash('sha1')
    .update(`${ssh.user || ''}@${ssh.host}:${ssh.port || ''}`)
    .digest('hex')
    .slice(0, 10);
  const p = path.join(dir, `pgsk-${id}`);
  return Buffer.byteLength(p) + SSH_SOCKET_SUFFIX_LENGTH < UNIX_SOCKET_PATH_MAX ? p : null;
}

function forwardTarget(host, port) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
}

export function buildSshArgs(ssh, dbHost, dbPort, cfg, { reuse = true, dir } = {}) {
  const args = [
    '-W', forwardTarget(dbHost, dbPort),
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    '-o', `ConnectTimeout=${cfg.connectTimeoutSeconds}`,
    '-o', `ServerAliveInterval=${cfg.serverAliveIntervalSeconds}`,
    '-o', `ServerAliveCountMax=${cfg.serverAliveCountMax}`,
  ];
  const cp = reuse && ssh.reuse !== false ? controlPath(ssh, dir) : null;
  if (cp) {
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${cp}`, '-o', `ControlPersist=${cfg.controlPersistSeconds}`);
  } else {
    args.push('-o', 'ControlPath=none');
  }
  if (ssh.key) args.push('-i', ssh.key, '-o', 'IdentitiesOnly=yes');
  if (ssh.port) args.push('-p', String(ssh.port));
  args.push(sshDestination(ssh));
  return { args, controlPath: cp };
}

export function classifySshFailure(stderr) {
  const s = stderr || '';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) return { kind: 'HOST_KEY_CHANGED', retryable: false };
  if (/Host key verification failed/i.test(s)) return { kind: 'HOST_KEY_VERIFICATION', retryable: false };
  if (/UNPROTECTED PRIVATE KEY FILE|bad permissions/i.test(s)) return { kind: 'KEY_PERMISSIONS', retryable: false };
  if (/Identity file .* not accessible|no such identity/i.test(s)) return { kind: 'KEY_FILE', retryable: false };
  if (/Permission denied \(|Too many authentication failures/i.test(s)) return { kind: 'AUTH_FAILED', retryable: false };
  if (/open failed: |stdio forwarding failed|forwarding request failed|open refused by peer/i.test(s)) return { kind: 'DB_UNREACHABLE', retryable: false };
  if (/Could not resolve hostname/i.test(s)) return { kind: 'BASTION_UNREACHABLE', retryable: false };
  if (/timed out/i.test(s)) return { kind: 'BASTION_UNREACHABLE', retryable: true };
  if (/Connection refused|No route to host|Network is unreachable/i.test(s)) return { kind: 'BASTION_UNREACHABLE', retryable: false };
  if (/mux_client|master|Control socket|Connection reset|Broken pipe|Connection closed/i.test(s)) return { kind: 'TUNNEL_FAILED', retryable: true };
  return { kind: 'TUNNEL_FAILED', retryable: false };
}

export function runCommand(cmd, args, { input, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: SSH_ENV });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: err.message, error: err });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr || err.message, error: err }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function createSshTunnel(ssh, dbHost, dbPort, cfg, { reuse = true, onEvent = () => {} } = {}) {
  const { args, controlPath: cp } = buildSshArgs(ssh, dbHost, dbPort, cfg, { reuse });
  const state = { args, controlPath: cp, stderr: '', child: null, closed: null, killedByUs: false };
  if (cp) fs.mkdirSync(path.dirname(cp), { recursive: true, mode: 0o700 });

  const factory = () => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: SSH_ENV });
    state.child = child;
    state.closed = new Promise(resolve => child.on('close', (code, signal) => {
      state.exitCode = code;
      state.signal = signal;
      resolve();
    }));
    onEvent('spawn', { args });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { state.stderr += d; });
    child.stdin.on('error', () => {});
    const duplex = Duplex.from({ readable: child.stdout, writable: child.stdin });
    duplex.setNoDelay = () => duplex;
    duplex.setKeepAlive = () => duplex;
    duplex.connect = () => {
      child.once('spawn', () => duplex.emit('connect'));
      return duplex;
    };
    child.on('error', err => {
      state.spawnError = err;
      duplex.destroy(err);
    });
    child.on('exit', (code, signal) => {
      if ((code || signal) && !duplex.destroyed) duplex.destroy(new Error(`ssh exited with ${code ? `code ${code}` : signal}`));
    });
    duplex.on('close', () => {
      if (child.exitCode === null && child.signalCode === null) {
        state.killedByUs = true;
        child.kill();
      }
    });
    return duplex;
  };

  async function settled(waitMs = 3000) {
    if (!state.closed) return;
    let timer;
    await Promise.race([state.closed, new Promise(r => { timer = setTimeout(r, waitMs); })]);
    clearTimeout(timer);
  }

  function sshFailed() {
    if (state.exitCode !== undefined && state.exitCode !== null) return state.exitCode !== 0;
    return Boolean(state.signal) && !state.killedByUs;
  }

  async function explain(err, { sharedUsed = false } = {}) {
    await settled();
    if (state.spawnError && state.spawnError.code === 'ENOENT') {
      return new SshError('SSH_NOT_FOUND', 'OpenSSH client `ssh` was not found in PATH.');
    }
    if (sshFailed()) {
      const { kind, retryable } = classifySshFailure(state.stderr);
      return new SshError(kind, state.stderr.trim() || `ssh exited with ${state.exitCode ? `code ${state.exitCode}` : state.signal}`, {
        retryable,
        stderr: state.stderr,
      });
    }
    if (err && /timeout expired/i.test(err.message || '')) {
      const stalled = sharedUsed && !(await checkSharedConnection(ssh, { timeoutMs: 3000 })).alive;
      return new SshError(
        'DB_UNREACHABLE',
        stalled
          ? `No answer within ${cfg.pgConnectTimeoutMs}ms and the shared SSH connection is not responding`
          : `No answer from ${dbHost}:${dbPort} through the bastion within ${cfg.pgConnectTimeoutMs}ms`,
        { retryable: stalled, stderr: state.stderr },
      );
    }
    return err;
  }

  function isDead() {
    const child = state.child;
    if (!child) return false;
    if (child.exitCode !== null) return child.exitCode !== 0;
    return child.signalCode !== null && !state.killedByUs;
  }

  return { factory, state, explain, settled, isDead };
}

function parseSshG(stdout) {
  const cfg = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(' ');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (cfg[key] === undefined) cfg[key] = value;
  }
  return cfg;
}

export async function sshEffectiveConfig(ssh) {
  const args = ['-G'];
  if (ssh.key) args.push('-i', ssh.key);
  if (ssh.port) args.push('-p', String(ssh.port));
  args.push(sshDestination(ssh));
  const res = await runCommand('ssh', args);
  if (res.code !== 0) {
    throw new SshError('TUNNEL_FAILED', `ssh -G failed: ${res.stderr.trim()}`);
  }
  const cfg = parseSshG(res.stdout);
  const port = parseInt(cfg.port || '22', 10);
  return {
    hostname: cfg.hostname || ssh.host,
    hostKeyAlias: cfg.hostkeyalias && cfg.hostkeyalias !== 'none' ? cfg.hostkeyalias : null,
    port,
    knownHostsFiles: (cfg.userknownhostsfile || '~/.ssh/known_hosts').split(/\s+/).filter(Boolean).map(expandHome),
    hashKnownHosts: (cfg.hashknownhosts || 'no').toLowerCase() === 'yes',
    hostKeyAlgorithms: (cfg.hostkeyalgorithms || '').split(',').filter(Boolean),
    viaProxy: ['proxyjump', 'proxycommand'].some(k => cfg[k] && cfg[k] !== 'none'),
  };
}

export function knownHostsName(eff) {
  const name = eff.hostKeyAlias || eff.hostname;
  return eff.port && eff.port !== 22 ? `[${name}]:${eff.port}` : name;
}

export async function isHostKnown(eff) {
  const name = knownHostsName(eff);
  for (const file of eff.knownHostsFiles) {
    if (!fs.existsSync(file)) continue;
    const res = await runCommand('ssh-keygen', ['-F', name, '-f', file]);
    if (res.code === 0 && res.stdout.trim()) return true;
  }
  return false;
}

const KEY_TYPE_FOR_ALGORITHM = [
  [/^ssh-ed25519/, 'ssh-ed25519'],
  [/^ecdsa-sha2-nistp256/, 'ecdsa-sha2-nistp256'],
  [/^ecdsa-sha2-nistp384/, 'ecdsa-sha2-nistp384'],
  [/^ecdsa-sha2-nistp521/, 'ecdsa-sha2-nistp521'],
  [/^(rsa-sha2-|ssh-rsa)/, 'ssh-rsa'],
];

export function preferredKey(keys, hostKeyAlgorithms) {
  for (const alg of hostKeyAlgorithms) {
    if (alg.includes('-cert-')) continue;
    const entry = KEY_TYPE_FOR_ALGORITHM.find(([re]) => re.test(alg));
    if (!entry) continue;
    const key = keys.find(k => k.keyType === entry[1]);
    if (key) return key;
  }
  return keys[0] || null;
}

export async function scanHostKeys(eff) {
  const res = await runCommand('ssh-keyscan', ['-T', '10', '-p', String(eff.port), eff.hostname], { timeoutMs: 20000 });
  const keys = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [, keyType, keyData] = parts;
    const fp = await runCommand('ssh-keygen', ['-lf', '-'], { input: `${line.trim()}\n` });
    const m = /^(\d+)\s+(SHA256:\S+)\s+.*\(([^)]+)\)\s*$/m.exec(fp.stdout);
    if (!m) continue;
    keys.push({ keyType, keyData, fingerprint: m[2], label: m[3], bits: Number(m[1]) });
  }
  return keys;
}

export function hashHostName(name, salt = crypto.randomBytes(20)) {
  const hmac = crypto.createHmac('sha1', salt).update(name).digest('base64');
  return `|1|${salt.toString('base64')}|${hmac}`;
}

export async function describeHostKeyFailure(ssh, stderr) {
  const eff = await sshEffectiveConfig(ssh);
  const bastion = `${eff.hostname}:${eff.port}`;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr || '') || (await isHostKnown(eff))) {
    return new SshError('HOST_KEY_CHANGED',
      `The host key of bastion ${bastion} does not match the one stored in ${eff.knownHostsFiles[0]}.`,
      { bastion, knownHostsFile: eff.knownHostsFiles[0], hostName: knownHostsName(eff) });
  }
  if (eff.viaProxy) {
    return new SshError('HOST_KEY_UNKNOWN',
      `Bastion ${bastion} is not in ${eff.knownHostsFiles[0]}, and it is reached through ProxyJump/ProxyCommand, so the skill cannot scan its key.`,
      { bastion, knownHostsFile: eff.knownHostsFiles[0], key: null, viaProxy: true });
  }
  const keys = await scanHostKeys(eff);
  const key = preferredKey(keys, eff.hostKeyAlgorithms);
  return new SshError('HOST_KEY_UNKNOWN',
    `Bastion ${bastion} is not in ${eff.knownHostsFiles[0]}.`,
    { bastion, knownHostsFile: eff.knownHostsFiles[0], key });
}

export async function acceptHostKey(ssh, fingerprint) {
  const eff = await sshEffectiveConfig(ssh);
  const bastion = `${eff.hostname}:${eff.port}`;
  if (await isHostKnown(eff)) {
    throw new SshError('HOST_KEY_CHANGED',
      `Bastion ${bastion} already has a key in ${eff.knownHostsFiles[0]}; refusing to add another. If the bastion was rebuilt, confirm with its owner and remove the old key yourself (ssh-keygen -R ${knownHostsName(eff)}).`,
      { bastion });
  }
  if (eff.viaProxy) {
    throw new SshError('HOST_KEY_MISMATCH',
      `Bastion ${bastion} is reached through ProxyJump/ProxyCommand; the skill cannot scan its key along that route. Nothing was written. The user connects once with ssh and verifies the key.`,
      { bastion });
  }
  const keys = await scanHostKeys(eff);
  const match = keys.find(k => k.fingerprint === fingerprint);
  if (!match) {
    const seen = keys.map(k => `${k.label} ${k.fingerprint}`).join(', ') || 'none (scan failed)';
    throw new SshError('HOST_KEY_MISMATCH',
      `Bastion ${bastion} does not currently present a key with fingerprint ${fingerprint} (it presents: ${seen}). Nothing was written.`,
      { bastion });
  }
  const file = eff.knownHostsFiles[0];
  const name = knownHostsName(eff);
  const hostField = eff.hashKnownHosts ? hashHostName(name) : name;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefix = '';
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.length && !content.endsWith('\n')) prefix = '\n';
  }
  fs.appendFileSync(file, `${prefix}${hostField} ${match.keyType} ${match.keyData}\n`, { mode: 0o600 });
  return { file, key: match, bastion };
}

export async function checkSharedConnection(ssh, { timeoutMs = 3000 } = {}) {
  const cp = controlPath(ssh);
  if (!cp || !fs.existsSync(cp)) return { alive: false };
  const args = ['-O', 'check', '-o', `ControlPath=${cp}`];
  if (ssh.port) args.push('-p', String(ssh.port));
  args.push(sshDestination(ssh));
  const res = await runCommand('ssh', args, { timeoutMs });
  const m = /pid=(\d+)/.exec(res.stderr + res.stdout);
  return { alive: res.code === 0, pid: m ? Number(m[1]) : null };
}

export async function closeSharedConnection(ssh, { timeoutMs = 10000 } = {}) {
  const cp = controlPath(ssh);
  if (!cp || !fs.existsSync(cp)) return { closed: false, reason: 'no shared SSH connection is open' };
  const args = ['-O', 'exit', '-o', `ControlPath=${cp}`];
  if (ssh.port) args.push('-p', String(ssh.port));
  args.push(sshDestination(ssh));
  const res = await runCommand('ssh', args, { timeoutMs });
  if (res.code === 0) return { closed: true };
  return { closed: false, reason: res.stderr.trim() || `ssh -O exit returned ${res.code}` };
}
