#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findProjectRoot, listTargets, loadTarget, bootstrapFromEnv } from '../lib/targets.mjs';
import { validate, buildExecutionSql, SafetyError } from '../lib/safety.mjs';
import { formatTable, formatJson, summaryLine } from '../lib/format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..');
const PROJECT_ROOT = findProjectRoot(process.cwd());
const CONFIG = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8'));

const requireFromProject = createRequire(path.join(PROJECT_ROOT, 'package.json'));
let Client;
try {
  Client = requireFromProject('pg').Client;
} catch (err) {
  process.stderr.write(
    `Cannot resolve 'pg' from your project (${PROJECT_ROOT}).\n` +
    `Install it with: npm install pg  (or: yarn add pg)\n` +
    `Original error: ${err.message}\n`
  );
  process.exit(5);
}

const USAGE = `Usage:
  node <SKILL>/bin/query.mjs --list-targets
  node <SKILL>/bin/query.mjs --bootstrap
  node <SKILL>/bin/query.mjs --target <name> --list-tables
  node <SKILL>/bin/query.mjs --target <name> --describe <table>
  node <SKILL>/bin/query.mjs --target <name> --sql "<query>"
  node <SKILL>/bin/query.mjs --target <name> --file <path>

  <SKILL> is this skill's install directory, e.g.:
    ~/.claude/skills/postgres   (Claude Code personal)
    .claude/skills/postgres     (Claude Code project)
    ~/.agents/skills/postgres   (Codex personal)
    .agents/skills/postgres     (Codex project)

Options:
  --format table|json    Output format (default: table)
  --limit <n>            Override defaultLimit (${CONFIG.defaultLimit})
  --no-auto-limit        Don't auto-append LIMIT to bare SELECTs

Exit codes: 0=ok, 1=usage, 2=safety, 3=timeout, 4=target missing, 5=connection`;

function parseArgs(argv) {
  const args = { format: 'table', autoLimit: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--list-targets': args.listTargets = true; break;
      case '--bootstrap': args.bootstrap = true; break;
      case '--target': args.target = next(); break;
      case '--list-tables': args.listTables = true; break;
      case '--describe': args.describe = next(); break;
      case '--sql': args.sql = next(); break;
      case '--file': args.file = next(); break;
      case '--format': args.format = next(); break;
      case '--limit': args.limit = parseInt(next(), 10); break;
      case '--no-auto-limit': args.autoLimit = false; break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        die(1, `Unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  return args;
}

function die(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function exitForError(err) {
  if (err instanceof SafetyError) die(2, `SAFETY: ${err.message}`);
  if (err && err.code === 'TARGET_MISSING') die(4, err.message);
  if (err && err.code === 'TARGET_INVALID') die(4, err.message);
  if (err && err.code === 'NO_ENV') die(4, err.message);
  if (err && (err.code === '57014' || /statement timeout/i.test(err.message || ''))) {
    die(3, `TIMEOUT: query exceeded ${CONFIG.statementTimeoutMs}ms`);
  }
  if (err && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(err.code)) {
    die(5, `CONNECTION: ${err.message}`);
  }
  die(1, err.stack || err.message || String(err));
}

async function withClient(target, fn) {
  const client = new Client(target.pgConfig);
  try {
    await client.connect();
  } catch (err) {
    exitForError(err);
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
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

async function runQuery(target, userSql, args) {
  validate(userSql, CONFIG);
  const { sql, finalUserSql } = buildExecutionSql(userSql, CONFIG, {
    autoLimit: args.autoLimit,
    limitOverride: args.limit ?? null,
  });
  const start = Date.now();
  const raw = await withClient(target, c => c.query(sql)).catch(exitForError);
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
    process.stdout.write(formatJson(rows, meta) + '\n');
  } else {
    process.stdout.write(formatTable(rows, result.fields, { cellMaxLength: CONFIG.cellMaxLength }) + '\n');
    process.stdout.write(summaryLine({ ...meta, finalSql: finalUserSql }) + '\n');
  }
}

async function cmdListTables(target, args) {
  const sql = `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name`;
  await runQuery(target, sql, { ...args, autoLimit: false });
}

async function cmdDescribe(target, ident, args) {
  const [schema, name] = ident.includes('.') ? ident.split('.', 2) : ['public', ident];
  const safe = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const colsSql = `
    SELECT column_name, data_type, is_nullable, column_default,
           character_maximum_length AS max_len
    FROM information_schema.columns
    WHERE table_schema = ${safe(schema)} AND table_name = ${safe(name)}
    ORDER BY ordinal_position`;
  const idxSql = `
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = ${safe(schema)} AND tablename = ${safe(name)}
    ORDER BY indexname`;
  const fkSql = `
    SELECT tc.constraint_name,
           kcu.column_name,
           ccu.table_schema AS foreign_schema,
           ccu.table_name   AS foreign_table,
           ccu.column_name  AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu USING (constraint_schema, constraint_name)
    JOIN information_schema.constraint_column_usage ccu USING (constraint_schema, constraint_name)
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = ${safe(schema)} AND tc.table_name = ${safe(name)}
    ORDER BY tc.constraint_name`;

  process.stdout.write(`# ${schema}.${name} — columns\n`);
  await runQuery(target, colsSql, { ...args, autoLimit: false });
  process.stdout.write(`\n# ${schema}.${name} — indexes\n`);
  await runQuery(target, idxSql, { ...args, autoLimit: false });
  process.stdout.write(`\n# ${schema}.${name} — foreign keys\n`);
  await runQuery(target, fkSql, { ...args, autoLimit: false });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); return; }

  if (args.listTargets) {
    const ts = listTargets(PROJECT_ROOT);
    process.stdout.write(ts.length ? ts.join('\n') + '\n' : '(none)\n');
    return;
  }

  if (args.bootstrap) {
    try {
      const result = bootstrapFromEnv(PROJECT_ROOT);
      if (!result.created) {
        process.stdout.write(result.reason + '\n');
        return;
      }
      process.stdout.write(`Created ${result.file}${result.rewroteHost ? ' (DB_HOST rewritten to localhost)' : ''}\n`);
      process.stdout.write(`Review the file before using it. Run --list-targets to confirm.\n`);
    } catch (err) {
      exitForError(err);
    }
    return;
  }

  if (!args.target) die(1, `--target is required for this command.\n\n${USAGE}`);

  let target;
  try {
    target = loadTarget(PROJECT_ROOT, args.target);
  } catch (err) {
    exitForError(err);
  }

  if (args.listTables) return cmdListTables(target, args);
  if (args.describe) return cmdDescribe(target, args.describe, args);
  if (args.sql) return runQuery(target, args.sql, args);
  if (args.file) {
    const sqlText = fs.readFileSync(args.file, 'utf8');
    return runQuery(target, sqlText, args);
  }
  die(1, `No action specified for --target ${args.target}.\n\n${USAGE}`);
}

main().catch(exitForError);
