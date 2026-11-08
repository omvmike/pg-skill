#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findProjectRoot, listTargets, loadTarget, bootstrapFromEnv, describeTarget } from '../lib/targets.mjs';
import { validate, buildExecutionSql, SafetyError } from '../lib/safety.mjs';
import {
  formatTable, formatJson, formatJsonBatch, formatSqlError, summaryLine, batchHeader, batchFooter, stoppedLine,
} from '../lib/format.mjs';
import {
  createSshTunnel, SshError, describeHostKeyFailure, acceptHostKey, closeSharedConnection, bastionLabel,
} from '../lib/ssh.mjs';
import { parseArgs, UsageError } from '../lib/cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..');
const PROJECT_ROOT = findProjectRoot(process.cwd());
const CONFIG = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8'));
const SSH_CONFIG = {
  controlPersistSeconds: 600,
  connectTimeoutSeconds: 10,
  serverAliveIntervalSeconds: 5,
  serverAliveCountMax: 2,
  pgConnectTimeoutMs: 20000,
  ...(CONFIG.ssh || {}),
};

const requireFromProject = createRequire(path.join(PROJECT_ROOT, 'package.json'));
let pg;
try {
  pg = requireFromProject('pg');
} catch (err) {
  process.stderr.write(
    `Cannot resolve 'pg' from your project (${PROJECT_ROOT}).\n` +
    `Install it with: npm install pg  (or: yarn add pg)\n` +
    `Original error: ${err.message}\n`
  );
  process.exit(5);
}
const { Client } = pg;

const RAW_TEXT_OIDS = new Set([1082, 1114, 1115, 1182]);
const TYPES = {
  getTypeParser: (oid, format) =>
    RAW_TEXT_OIDS.has(oid) && (format || 'text') === 'text' ? (v => v) : pg.types.getTypeParser(oid, format),
};

const USAGE = `Usage:
  node <SKILL>/bin/query.mjs --list-targets
  node <SKILL>/bin/query.mjs --bootstrap
  node <SKILL>/bin/query.mjs --target <name> --list-tables
  node <SKILL>/bin/query.mjs --target <name> --describe <table>
  node <SKILL>/bin/query.mjs --target <name> --sql "<query>" [--sql "<query>" ...]
  node <SKILL>/bin/query.mjs --target <name> --file <path>
  node <SKILL>/bin/query.mjs --target <name> --accept-host-key <SHA256:fingerprint>
  node <SKILL>/bin/query.mjs --target <name> --close-tunnel

  <SKILL> is this skill's install directory, e.g.:
    ~/.claude/skills/postgres   (Claude Code personal)
    .claude/skills/postgres     (Claude Code project)
    ~/.agents/skills/postgres   (Codex personal)
    .agents/skills/postgres     (Codex project)

Options:
  --format table|json    Output format (default: table)
  --limit <n>            Override defaultLimit (${CONFIG.defaultLimit})
  --no-auto-limit        Don't auto-append LIMIT to bare SELECTs
  --verbose              Print connection diagnostics to stderr

Several --sql flags run in order on one connection and stop at the first failing query.

Exit codes: 0=ok, 1=usage or SQL error, 2=safety, 3=timeout, 4=target missing/invalid, 5=connection, 6=SSH tunnel`;

const ctx = { target: null, verbose: false };

function verbose(message) {
  if (ctx.verbose) process.stderr.write(`[pg-skill] ${message}\n`);
}

function die(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function scriptPath() {
  const rel = path.relative(process.cwd(), process.argv[1]);
  return rel && !rel.startsWith('..') ? rel : process.argv[1];
}

function formatSshError(err) {
  const detail = err.stderr ? `\n${err.stderr.trim()}` : '';
  switch (err.kind) {
    case 'HOST_KEY_UNKNOWN': {
      const lines = [`SSH HOST_KEY_UNKNOWN: ${err.message}`];
      if (err.key) {
        lines.push(
          `  ${err.key.label} ${err.key.fingerprint}`,
          'Ask the user to accept or reject this host key. Do not accept it yourself.',
          `  accept: node ${scriptPath()} --target ${ctx.target} --accept-host-key ${err.key.fingerprint}`,
          '  reject: stop; do not connect.',
        );
      } else {
        lines.push("Could not read the bastion's host key to show its fingerprint. Ask the user to connect once with ssh themselves and verify the key.");
      }
      return lines.join('\n');
    }
    case 'HOST_KEY_CHANGED':
      return `SSH HOST_KEY_CHANGED: ${err.message}\n` +
        'This can mean the connection is being intercepted, or the bastion was rebuilt. Stop and tell the user. ' +
        `Do not remove or replace the stored key: the user confirms with the bastion's owner and runs \`ssh-keygen -R ${err.hostName || '<host>'}\` themselves.`;
    case 'HOST_KEY_MISMATCH':
      return `SSH HOST_KEY_MISMATCH: ${err.message}`;
    case 'AUTH_FAILED':
      return 'SSH AUTH_FAILED: the bastion rejected the login. Check DB_SSH_USER and DB_SSH_KEY in the target file; ' +
        `a passphrase-protected key must be loaded with ssh-add first.${detail}`;
    case 'KEY_PERMISSIONS':
      return `SSH KEY_PERMISSIONS: ssh refuses the key because its file permissions are too open. The user fixes it with chmod 600 <key>.${detail}`;
    case 'KEY_FILE':
      return `SSH KEY_FILE: ssh could not read the key file.${detail}`;
    case 'BASTION_UNREACHABLE':
      return `SSH BASTION_UNREACHABLE: could not reach the bastion (network, VPN, or an IP allow-list on the bastion).${detail}`;
    case 'DB_UNREACHABLE':
      return `SSH DB_UNREACHABLE: the bastion could not reach DB_HOST:DB_PORT (or does not allow port forwarding). Check those values in the target file.\n${err.message}`;
    case 'SSH_NOT_FOUND':
      return `SSH SSH_NOT_FOUND: ${err.message}`;
    default:
      return `SSH TUNNEL_FAILED: ${err.message}`;
  }
}

function exitCodeFor(err) {
  if (err instanceof UsageError) return 1;
  if (err instanceof SafetyError) return 2;
  if (err instanceof SshError) return 6;
  if (err && ['TARGET_MISSING', 'TARGET_INVALID', 'NO_ENV'].includes(err.code)) return 4;
  if (err && (err.code === '57014' || /statement timeout/i.test(err.message || ''))) return 3;
  if (err && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET'].includes(err.code)) return 5;
  return 1;
}

function describeError(err) {
  if (err instanceof UsageError) return `${err.message}\n\n${USAGE}`;
  if (err instanceof SafetyError) return `SAFETY: ${err.message}`;
  if (err instanceof SshError) return formatSshError(err);
  const code = exitCodeFor(err);
  if (code === 4) return err.message;
  if (code === 3) return `TIMEOUT: query exceeded ${CONFIG.statementTimeoutMs}ms`;
  if (code === 5) return `CONNECTION: ${err.message}`;
  if (err && err.severity) return formatSqlError(err);
  return (err && (err.stack || err.message)) || String(err);
}

function exitForError(err) {
  die(exitCodeFor(err), describeError(err));
}

async function openClient(target) {
  const base = { ...target.pgConfig };
  if (!target.ssh) {
    const client = new Client(base);
    client.on('error', () => {});
    const start = Date.now();
    await client.connect();
    return { client, tunnel: null, shared: null, connectMs: Date.now() - start };
  }

  let spawns = 0;
  const attempt = async (reuse) => {
    const tunnel = createSshTunnel(target.ssh, target.pgConfig.host, target.pgConfig.port, SSH_CONFIG, {
      reuse,
      onEvent: (event, data) => {
        if (event === 'spawn') {
          spawns++;
          verbose(`ssh ${data.args.join(' ')}`);
        }
      },
    });
    const sharedExisted = Boolean(tunnel.state.controlPath && fs.existsSync(tunnel.state.controlPath));
    const client = new Client({ ...base, stream: tunnel.factory, connectionTimeoutMillis: SSH_CONFIG.pgConnectTimeoutMs });
    client.on('error', () => {});
    const start = Date.now();
    try {
      await client.connect();
    } catch (err) {
      let explained = await tunnel.explain(err, { sharedUsed: sharedExisted });
      if (explained instanceof SshError && explained.kind === 'HOST_KEY_VERIFICATION') {
        explained = await describeHostKeyFailure(target.ssh, explained.stderr);
      }
      if (explained instanceof SshError && explained.retryable && sharedExisted) {
        await closeSharedConnection(target.ssh, { timeoutMs: 3000 }).catch(() => {});
      }
      throw explained;
    }
    const shared = !tunnel.state.controlPath ? 'off' : sharedExisted ? 'reused' : 'opened';
    return { client, tunnel, shared, connectMs: Date.now() - start };
  };

  let result;
  try {
    result = await attempt(true);
  } catch (err) {
    if (!(err instanceof SshError) || !err.retryable) throw err;
    verbose(`retrying once without the shared SSH connection after ${err.kind}: ${err.message.split('\n')[0]}`);
    result = await attempt(false);
  }
  verbose(`connected in ${result.connectMs}ms; shared SSH connection: ${result.shared}; ssh spawns: ${spawns}`);
  return result;
}

function pickSelectResult(result) {
  if (Array.isArray(result)) {
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i] && Array.isArray(result[i].rows) && result[i].fields && result[i].fields.length) {
        return result[i];
      }
    }
    return result[result.length - 1] || { rows: [], fields: [] };
  }
  return result;
}

async function closeConnection(conn) {
  if (!conn) return;
  await conn.client.end().catch(() => {});
  if (conn.tunnel) await conn.tunnel.settled(2000);
}

function translateRuntimeError(err, conn) {
  if (conn && conn.tunnel && conn.tunnel.isDead() && !(err && err.severity)) {
    return new SshError('TUNNEL_FAILED', `The connection through the bastion dropped: ${conn.tunnel.state.stderr.trim() || err.message}`);
  }
  return err;
}

function validateAll(items) {
  items.forEach((item, idx) => {
    try {
      validate(item.sql, CONFIG);
    } catch (err) {
      if (err instanceof SafetyError && items.length > 1) {
        throw new SafetyError(`query ${idx + 1} of ${items.length}: ${err.message} Nothing was run.`);
      }
      throw err;
    }
  });
}

async function runItems(target, items, args, mode) {
  validateAll(items);
  let conn;
  try {
    conn = await openClient(target);
  } catch (err) {
    exitForError(err);
  }

  const total = items.length;
  const jsonResults = [];
  let failure = null;

  for (let idx = 0; idx < total; idx++) {
    const item = items[idx];
    const { sql, finalUserSql } = buildExecutionSql(item.sql, CONFIG, {
      autoLimit: item.autoLimit ?? args.autoLimit,
      limitOverride: args.limit ?? null,
    });
    if (mode === 'batch' && args.format !== 'json') {
      if (idx > 0) process.stdout.write('\n');
      process.stdout.write(batchHeader(idx + 1, total) + '\n');
    }
    if (item.heading) process.stdout.write(item.heading + '\n');

    const start = Date.now();
    let raw;
    try {
      raw = await conn.client.query({ text: sql, types: TYPES });
    } catch (err) {
      failure = { index: idx + 1, error: translateRuntimeError(err, conn), finalUserSql };
      break;
    }
    const elapsedMs = Date.now() - start;
    const result = pickSelectResult(raw);
    let rows = result.rows || [];
    let truncated = false;
    if (rows.length > CONFIG.maxRows) {
      rows = rows.slice(0, CONFIG.maxRows);
      truncated = true;
    }
    const meta = { rowCount: rows.length, elapsedMs, target: target.name, truncated };
    if (args.format === 'json') {
      if (mode === 'batch') jsonResults.push({ query: idx + 1, sql: finalUserSql, rowCount: rows.length, elapsedMs, truncated, rows });
      else process.stdout.write(formatJson(rows, meta) + '\n');
    } else {
      process.stdout.write(formatTable(rows, result.fields, { cellMaxLength: CONFIG.cellMaxLength }) + '\n');
      process.stdout.write(summaryLine({ ...meta, finalSql: finalUserSql }) + '\n');
    }
  }

  await closeConnection(conn);

  if (mode === 'batch' && args.format === 'json') {
    const batch = { target: target.name, results: jsonResults };
    if (failure) {
      batch.results.push({
        query: failure.index,
        sql: failure.finalUserSql,
        error: { message: failure.error.message, code: failure.error.code || null },
      });
      batch.stoppedAt = failure.index;
    }
    process.stdout.write(formatJsonBatch(batch) + '\n');
  }

  if (failure) {
    const lines = [describeError(failure.error)];
    if (mode === 'batch') {
      const stopped = stoppedLine(failure.index, total);
      if (stopped) lines.push(stopped);
    }
    process.stderr.write(lines.join('\n') + '\n');
    process.exitCode = exitCodeFor(failure.error);
    return;
  }

  if (mode === 'batch' && args.format !== 'json') {
    process.stdout.write('\n' + batchFooter({
      total,
      target: target.name,
      via: target.ssh ? bastionLabel(target.ssh) : null,
      connectMs: conn.connectMs,
      shared: conn.shared,
    }) + '\n');
  }
}

function listTablesItems() {
  return [{
    sql: `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name`,
    autoLimit: false,
  }];
}

function describeItems(ident) {
  const [schema, name] = ident.includes('.') ? ident.split('.', 2) : ['public', ident];
  const safe = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return [
    {
      heading: `# ${schema}.${name} — columns`,
      sql: `
    SELECT column_name, data_type, is_nullable, column_default,
           character_maximum_length AS max_len
    FROM information_schema.columns
    WHERE table_schema = ${safe(schema)} AND table_name = ${safe(name)}
    ORDER BY ordinal_position`,
      autoLimit: false,
    },
    {
      heading: `\n# ${schema}.${name} — indexes`,
      sql: `
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = ${safe(schema)} AND tablename = ${safe(name)}
    ORDER BY indexname`,
      autoLimit: false,
    },
    {
      heading: `\n# ${schema}.${name} — foreign keys`,
      sql: `
    SELECT c.conname  AS constraint_name,
           a.attname  AS column_name,
           fn.nspname AS foreign_schema,
           ft.relname AS foreign_table,
           fa.attname AS foreign_column
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class ft ON ft.oid = c.confrelid
    JOIN pg_namespace fn ON fn.oid = ft.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fattnum
    WHERE c.contype = 'f'
      AND n.nspname = ${safe(schema)} AND t.relname = ${safe(name)}
    ORDER BY c.conname, k.ord`,
      autoLimit: false,
    },
  ];
}

function queryItems(queries) {
  return queries.map(q => {
    if (q.kind === 'sql') return { sql: q.value };
    let text;
    try {
      text = fs.readFileSync(q.value, 'utf8');
    } catch (err) {
      throw new UsageError(`Cannot read --file ${q.value}: ${err.message}`);
    }
    return { sql: text };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ctx.verbose = Boolean(args.verbose);
  if (args.help) { process.stdout.write(USAGE + '\n'); return; }

  if (args.listTargets) {
    const ts = listTargets(PROJECT_ROOT);
    process.stdout.write(ts.length ? ts.map(t => describeTarget(PROJECT_ROOT, t)).join('\n') + '\n' : '(none)\n');
    return;
  }

  if (args.bootstrap) {
    const result = bootstrapFromEnv(PROJECT_ROOT);
    if (!result.created) {
      process.stdout.write(result.reason + '\n');
      return;
    }
    process.stdout.write(`Created ${result.file}${result.rewroteHost ? ' (DB_HOST rewritten to localhost)' : ''}\n`);
    process.stdout.write(`Review the file before using it. Run --list-targets to confirm.\n`);
    return;
  }

  if (!args.target) throw new UsageError('--target is required for this command.');
  ctx.target = args.target;
  const target = loadTarget(PROJECT_ROOT, args.target);

  if (args.closeTunnel) {
    if (!target.ssh) {
      process.stdout.write(`Target "${target.name}" does not use a bastion; nothing to close.\n`);
      return;
    }
    const res = await closeSharedConnection(target.ssh);
    process.stdout.write(res.closed
      ? `Closed the shared SSH connection to ${bastionLabel(target.ssh)}.\n`
      : `Nothing closed: ${res.reason}.\n`);
    return;
  }

  if (args.acceptHostKey) {
    if (!target.ssh) throw new UsageError(`Target "${target.name}" does not use a bastion (no DB_SSH_HOST).`);
    const res = await acceptHostKey(target.ssh, args.acceptHostKey);
    process.stdout.write(`Added ${res.key.label} host key ${res.key.fingerprint} for bastion ${res.bastion} to ${res.file}.\n`);
    return;
  }

  if (args.listTables) return runItems(target, listTablesItems(), args, 'single');
  if (args.describe) return runItems(target, describeItems(args.describe), args, 'describe');
  if (args.queries.length) {
    const items = queryItems(args.queries);
    return runItems(target, items, args, items.length > 1 ? 'batch' : 'single');
  }
  throw new UsageError(`No action specified for --target ${args.target}.`);
}

main().catch(exitForError);
