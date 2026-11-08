import fs from 'node:fs';
import path from 'node:path';
import { expandHome, bastionLabel } from './ssh.mjs';

const TARGET_FILE_RE = /^\.db\.([a-z0-9_-]+)$/i;
const TARGET_NAME_RE = /^[a-z0-9_-]+$/i;
const DB_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_SSL', 'DB_SSL_REJECT_UNAUTHORIZED'];
const ROOT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];

export function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*export\s+/, '');
    if (!line || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[m[1]] = val;
  }
  return env;
}

export function findProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

export function listTargets(projectRoot) {
  return fs.readdirSync(projectRoot)
    .map(name => {
      const m = name.match(TARGET_FILE_RE);
      return m ? m[1] : null;
    })
    .filter(Boolean)
    .sort();
}

export function loadTarget(projectRoot, name) {
  if (!TARGET_NAME_RE.test(String(name))) {
    throw invalid(name, 'target names may contain only letters, digits, "_" and "-".');
  }
  const file = path.join(projectRoot, `.db.${name}`);
  if (!fs.existsSync(file)) {
    const available = listTargets(projectRoot);
    const hint = available.length
      ? `Available: ${available.join(', ')}`
      : 'No targets exist. Run --bootstrap to create .db.local from .env.';
    const err = new Error(`Target "${name}" not found (expected ${file}). ${hint}`);
    err.code = 'TARGET_MISSING';
    throw err;
  }
  const env = parseEnv(fs.readFileSync(file, 'utf8'));
  const missing = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter(k => !env[k]);
  if (missing.length) {
    const err = new Error(`Target "${name}" is missing required keys: ${missing.join(', ')}`);
    err.code = 'TARGET_INVALID';
    throw err;
  }
  return {
    name,
    file,
    pgConfig: buildPgConfig(env, name),
    ssh: env.DB_SSH_HOST ? buildSshConfig(env, name) : null,
  };
}

export function describeTarget(projectRoot, name) {
  try {
    const env = parseEnv(fs.readFileSync(path.join(projectRoot, `.db.${name}`), 'utf8'));
    if (!env.DB_SSH_HOST) return name;
    const port = env.DB_SSH_PORT ? parseInt(env.DB_SSH_PORT, 10) : null;
    return `${name}  (via bastion ${bastionLabel({ host: env.DB_SSH_HOST, user: env.DB_SSH_USER, port })})`;
  } catch {
    return name;
  }
}

function invalid(name, message) {
  const err = new Error(`Target "${name}": ${message}`);
  err.code = 'TARGET_INVALID';
  return err;
}

const SAFE_SSH_TOKEN = /^[^\s-][^\s]*$/;

function buildSshConfig(env, name) {
  const host = env.DB_SSH_HOST.trim();
  if (!SAFE_SSH_TOKEN.test(host)) throw invalid(name, `DB_SSH_HOST "${host}" must not contain spaces or start with "-".`);
  const user = env.DB_SSH_USER ? env.DB_SSH_USER.trim() : null;
  if (user && !SAFE_SSH_TOKEN.test(user)) throw invalid(name, `DB_SSH_USER "${user}" must not contain spaces or start with "-".`);
  let port = null;
  if (env.DB_SSH_PORT) port = parsePort(name, 'DB_SSH_PORT', env.DB_SSH_PORT);
  let key = null;
  if (env.DB_SSH_KEY) {
    key = path.resolve(expandHome(env.DB_SSH_KEY.trim()));
    if (!fs.existsSync(key) || !fs.statSync(key).isFile()) throw invalid(name, `DB_SSH_KEY file not found: ${key}`);
  }
  const reuse = String(env.DB_SSH_REUSE || 'true').toLowerCase() !== 'false';
  return { host, user, port, key, reuse };
}

function parsePort(name, key, raw) {
  const port = Number(String(raw).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid(name, `${key} "${raw}" is not a valid port.`);
  return port;
}

function parseBool(name, key, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw invalid(name, `${key} must be true or false, got "${raw}".`);
}

function buildPgConfig(env, name) {
  const sslEnabled = parseBool(name, 'DB_SSL', env.DB_SSL, false);
  const reject = parseBool(name, 'DB_SSL_REJECT_UNAUTHORIZED', env.DB_SSL_REJECT_UNAUTHORIZED, true);
  const cfg = {
    host: env.DB_HOST,
    port: parsePort(name, 'DB_PORT', env.DB_PORT),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  };
  if (sslEnabled) cfg.ssl = { rejectUnauthorized: reject };
  return cfg;
}

export function bootstrapFromEnv(projectRoot) {
  const existing = listTargets(projectRoot);
  if (existing.length) {
    return { created: false, reason: `Targets already exist: ${existing.join(', ')}. Refusing to overwrite.` };
  }
  const envFile = path.join(projectRoot, '.env');
  if (!fs.existsSync(envFile)) {
    const err = new Error(`Cannot bootstrap: no .env file at ${envFile}. Create .db.local manually with DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME.`);
    err.code = 'NO_ENV';
    throw err;
  }
  const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
  const lines = [];
  let rewroteHost = false;
  for (const key of DB_KEYS) {
    if (env[key] === undefined) continue;
    let value = env[key];
    if (key === 'DB_HOST' && value === 'db') {
      value = 'localhost';
      rewroteHost = true;
    }
    lines.push(`${key}=${value}`);
  }
  if (!lines.some(l => l.startsWith('DB_HOST='))) {
    lines.unshift('DB_HOST=localhost');
    rewroteHost = true;
  }
  const out = path.join(projectRoot, '.db.local');
  fs.writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 });
  return { created: true, file: out, rewroteHost };
}
