import fs from 'node:fs';
import path from 'node:path';

const TARGET_FILE_RE = /^\.db\.([a-z0-9_-]+)$/i;
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
      return m ? m[1].toLowerCase() : null;
    })
    .filter(Boolean)
    .sort();
}

export function loadTarget(projectRoot, name) {
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
    pgConfig: buildPgConfig(env),
  };
}

function buildPgConfig(env) {
  const sslEnabled = String(env.DB_SSL || '').toLowerCase() === 'true';
  const cfg = {
    host: env.DB_HOST,
    port: parseInt(env.DB_PORT, 10),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  };
  if (sslEnabled) {
    const reject = String(env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false';
    cfg.ssl = { rejectUnauthorized: reject };
  }
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
