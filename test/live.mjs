#!/usr/bin/env node
// Live test runner. Needs a real project with `pg` installed and .db.<target> files.
//   node test/live.mjs --project <dir> --local <target> [--remote <bastion-target>] [--baseline <old-skill-dir>]
//        [--groups A,B,C,D,E,F,G,H,I] [--table users] [--unknown-host <bastion hostname not in known_hosts>]
//        [--db-ok <db name>] [--db-denied <db name>] [--report <file.md>]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, loadTarget } from '../lib/targets.mjs';
import {
  controlPath, checkSharedConnection, closeSharedConnection, buildSshArgs, runCommand, classifySshFailure,
} from '../lib/ssh.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseCli(argv) {
  const o = { groups: 'A,B,C,D,E,F,G,H,I', table: 'users' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    o[key] = argv[++i];
  }
  if (!o.project || !o.local) {
    console.error('usage: node test/live.mjs --project <dir> --local <target> [--remote <target>] ...');
    process.exit(1);
  }
  o.groups = new Set(o.groups.split(','));
  return o;
}

const opts = parseCli(process.argv.slice(2));
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function run(args, { skillDir = SKILL_DIR, timeoutMs = 90000, env = {}, cwd = opts.project } = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(process.execPath, [path.join(skillDir, 'bin/query.mjs'), ...args], {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += '\n[live] KILLED: stdio still open after timeout'; }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - start, pid: child.pid }); });
    run.last = child;
  });
}

function sh(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
}

function check(group, name, pass, actual, expected = '') {
  results.push({ group, name, pass: Boolean(pass), actual: String(actual ?? '').replace(/\s+/g, ' ').slice(0, 220), expected });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} [${group}] ${name}${pass ? '' : `\n      expected: ${expected}\n      actual:   ${String(actual).slice(0, 400)}`}\n`);
}

const normalize = s => s
  .replace(/in \d+ms/g, 'in Nms')
  .replace(/"elapsedMs": \d+/g, '"elapsedMs": N')
  .replace(/,\n\s*"limitReached": (true|false)/g, '')
  .replace(/ \(limit \d+ reached; more rows may exist\)/g, '')
  .replace(/ {2}\(via bastion [^)]*\)/g, '');

function readTargetFile(name) {
  return fs.readFileSync(path.join(opts.project, `.db.${name}`), 'utf8');
}

function deriveTarget(base, overrides) {
  const env = parseEnv(readTargetFile(base));
  Object.assign(env, overrides);
  return Object.entries(env)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => (k === 'DB_PASSWORD' ? `${k}='${v}'` : `${k}=${v}`))
    .join('\n') + '\n';
}

async function withFixtures(files, fn) {
  const written = [];
  try {
    for (const [name, body] of Object.entries(files)) {
      const file = path.join(opts.project, `.db.${name}`);
      if (fs.existsSync(file)) throw new Error(`fixture would overwrite ${file}`);
      fs.writeFileSync(file, body, { mode: 0o600 });
      written.push(file);
    }
    return await fn();
  } finally {
    for (const f of written) fs.rmSync(f, { force: true });
  }
}

function remoteSsh() {
  return loadTarget(opts.project, opts.remote).ssh;
}

async function masterPid() {
  const res = await checkSharedConnection(remoteSsh(), { timeoutMs: 3000 });
  return res.alive ? res.pid : null;
}

async function tunnelClients(dbHost) {
  const res = await sh('pgrep', ['-f', `ssh -W ${dbHost}`]);
  return res.out.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
}

async function sharedMasters() {
  const res = await sh('pgrep', ['-f', `${controlPath(remoteSsh())} \\[mux\\]`]);
  return res.out.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
}

async function waitForNoClients(dbHost, maxMs) {
  const start = Date.now();
  let left = await tunnelClients(dbHost);
  while (left.length && Date.now() - start < maxMs) {
    await sleep(1000);
    left = await tunnelClients(dbHost);
  }
  return { left, waitedMs: Date.now() - start };
}

// ---------------------------------------------------------------- A. regression vs baseline (local)
async function groupA() {
  if (!opts.baseline) { check('A', 'baseline given', false, 'no --baseline', '--baseline <old skill dir>'); return; }
  const tmpSql = path.join(os.tmpdir(), `pgsk-live-${process.pid}.sql`);
  fs.writeFileSync(tmpSql, `SELECT id\n  FROM ${opts.table}\n ORDER BY id\n LIMIT 3\n`);
  const cases = [
    ['--list-targets'],
    ['--target', opts.local, '--list-tables'],
    ['--target', opts.local, '--describe', opts.table],
    ['--target', opts.local, '--describe', `public.${opts.table}`],
    ['--target', opts.local, '--describe', 'no_such_table_xyz'],
    ['--target', opts.local, '--sql', `SELECT id FROM ${opts.table} ORDER BY id LIMIT 5`],
    ['--target', opts.local, '--file', tmpSql],
    ['--target', opts.local, '--sql', `SELECT id FROM ${opts.table} ORDER BY id LIMIT 3`, '--format', 'json'],
    ['--target', opts.local, '--sql', `SELECT id FROM ${opts.table} ORDER BY id`, '--limit', '5'],
    ['--target', opts.local, '--sql', 'SELECT g FROM generate_series(1, 1500) g', '--no-auto-limit'],
    ['--bootstrap'],
    ['--target', 'no_such_target'],
  ];
  for (const args of cases) {
    const [oldR, newR] = [await run(args, { skillDir: opts.baseline }), await run(args)];
    const norm = args.includes('--describe') ? (t => normalize(t).replace(/ sql=.*$/gm, '')) : normalize;
    const same = oldR.code === newR.code && norm(oldR.stdout) === norm(newR.stdout);
    check('A', `same output: ${args.join(' ').slice(0, 90)}`, same,
      `old exit ${oldR.code} / new exit ${newR.code}; stdout ${norm(oldR.stdout) === norm(newR.stdout) ? 'equal' : 'DIFFERS:\n' + norm(newR.stdout).slice(0, 300)}`,
      'identical exit code and stdout');
  }
  fs.rmSync(tmpSql, { force: true });

  const t = await run(['--target', opts.local, '--sql', 'SELECT g FROM generate_series(1, 1500) g', '--no-auto-limit']);
  check('A', '--no-auto-limit is capped at maxRows', /-- 1000 rows .*\(truncated\)/.test(t.stdout), t.stdout.split('\n').at(-2), '1000 rows (truncated)');

  const oldErr = await run(['--target', opts.local, '--sql', `SELECT nme FROM ${opts.table}`], { skillDir: opts.baseline });
  const newErr = await run(['--target', opts.local, '--sql', `SELECT nme FROM ${opts.table}`]);
  check('A', 'intended change: SQL error is one ERROR line instead of a stack', oldErr.code === 1 && newErr.code === 1 &&
    /^ERROR: column "nme" does not exist \(SQLSTATE 42703\)/.test(newErr.stderr), newErr.stderr.trim(), 'exit 1, ERROR: … (SQLSTATE 42703)');

  const oldDate = await run(['--target', opts.local, '--sql', "SELECT '2026-11-02'::date AS d"], { skillDir: opts.baseline });
  const newDate = await run(['--target', opts.local, '--sql', "SELECT '2026-11-02'::date AS d"]);
  check('A', 'intended change: date printed as yyyy-MM-dd (was ISO at local midnight)', / 2026-11-02 +\|/.test(newDate.stdout),
    `old: ${oldDate.stdout.split('\n')[2]} new: ${newDate.stdout.split('\n')[2]}`, '| 2026-11-02 |');
}

// ---------------------------------------------------------------- B. data types
const TYPES_SQL = `SELECT '2026-11-02'::date AS d, '2026-11-02 10:30:00'::timestamp AS ts,
  '2026-11-02 10:30:00+00'::timestamptz AS tz, 42::int AS i, 9007199254740993::bigint AS big,
  12.50::numeric(10,2) AS num, true AS b, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS u,
  '{"a":1}'::json AS j, '{"b":[1,2]}'::jsonb AS jb, ARRAY['ON_PROGRAM','ARRIVED']::varchar[] AS arr,
  ARRAY[1,2,3] AS ints, ARRAY['2026-11-02'::date] AS dates, '\\x00ff'::bytea AS bytes,
  interval '1 day 2 hours' AS iv, NULL::text AS nul, E'line1\\nline2 | pipe – ü' AS txt, repeat('x', 200) AS long`;

async function groupB() {
  const outputs = {};
  for (const target of [opts.local, opts.remote].filter(Boolean)) {
    const r = await run(['--target', target, '--sql', TYPES_SQL, '--format', 'json']);
    let row = null;
    try { row = JSON.parse(r.stdout).rows[0]; } catch { /* reported below */ }
    const expect = {
      d: '2026-11-02', ts: '2026-11-02 10:30:00', tz: '2026-11-02T10:30:00.000Z', i: 42, big: '9007199254740993',
      num: '12.50', b: true, u: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', j: { a: 1 }, jb: { b: [1, 2] },
      arr: ['ON_PROGRAM', 'ARRIVED'], ints: [1, 2, 3], dates: '{2026-11-02}', bytes: '\\x00ff', nul: null,
      txt: 'line1\nline2 | pipe – ü',
    };
    for (const [k, v] of Object.entries(expect)) {
      check('B', `${target}: ${k}`, row && JSON.stringify(row[k]) === JSON.stringify(v), row ? JSON.stringify(row[k]) : r.stderr, JSON.stringify(v));
    }
    check('B', `${target}: long text kept in JSON`, row && row.long.length === 200, row && row.long.length, 200);
    const t = await run(['--target', target, '--sql', TYPES_SQL]);
    outputs[target] = normalize(t.stdout).replace(`target=${target}`, 'target=X');
    check('B', `${target}: table output escapes newline/pipe and truncates long cells`,
      t.code === 0 && /line1 line2 \\\| pipe/.test(t.stdout) && /x{79}…/.test(t.stdout), t.stdout.split('\n')[2], 'line1 line2 \\| pipe … x…');
  }
  if (opts.remote) {
    check('B', 'local and remote print the same table', outputs[opts.local] === outputs[opts.remote],
      outputs[opts.local] === outputs[opts.remote] ? 'equal' : 'differ', 'equal');
  }
}

// ---------------------------------------------------------------- C. safety
async function groupC() {
  for (const target of [opts.local, opts.remote].filter(Boolean)) {
    const rejected = [
      ['DELETE', [`DELETE FROM ${opts.table} WHERE id = -1`]],
      ['batch with DELETE', ['SELECT 1', `DELETE FROM ${opts.table} WHERE id = -1`]],
      ['CTE with DELETE', [`WITH x AS (DELETE FROM ${opts.table} WHERE id = -1 RETURNING *) SELECT * FROM x`]],
      ['COMMIT escape', ["SELECT 1; COMMIT; SELECT current_setting('transaction_read_only')"]],
      ['END escape', ['SELECT 1; END; SELECT 2']],
      ['E-string escape', ["SELECT E'\\''; COMMIT; SELECT ''"]],
      ['CR-terminated comment escape', ["SELECT 1 --\r; COMMIT; SELECT current_setting('transaction_read_only')"]],
    ];
    for (const [name, sqls] of rejected) {
      const r = await run(['--target', target, '--verbose', ...sqls.flatMap(s => ['--sql', s])]);
      check('C', `${target}: ${name} rejected before connecting`, r.code === 2 && !r.stderr.includes('[pg-skill] ssh '),
        `exit ${r.code}: ${r.stderr.trim().split('\n')[0]}`, 'exit 2, no ssh spawn');
    }
    const batch = await run(['--target', target, '--sql', 'SELECT 1', '--sql', `DELETE FROM ${opts.table} WHERE id = -1`]);
    check('C', `${target}: batch rejection names the query and says nothing ran`, /query 2 of 2: .*Nothing was run/.test(batch.stderr), batch.stderr.trim());

    const allowed = await run(['--target', target, '--sql', "SELECT 'DELETE FROM users' AS note, 1 AS \"update\""]);
    check('C', `${target}: keywords inside strings/identifiers allowed`, allowed.code === 0, `exit ${allowed.code} ${allowed.stderr.trim()}`, 'exit 0');

    for (const sql of ['SELECT 1 AS a LIMIT 5 -- note', 'SHOW server_version -- note', 'EXPLAIN SELECT 1 -- note', 'SELECT 1 AS a; -- note']) {
      const r = await run(['--target', target, '--sql', sql]);
      check('C', `${target}: trailing comment works: ${sql}`, r.code === 0 && !/rollback/i.test(r.stdout.split('\n')[0]), `exit ${r.code} ${r.stderr.trim() || r.stdout.split('\n')[0]}`, 'exit 0');
    }
    const dup = await run(['--target', target, '--sql', 'SELECT 1 AS id, 2 AS id']);
    const dupJ = await run(['--target', target, '--format', 'json', '--sql', 'SELECT 1 AS id, 2 AS id']);
    let dupRow = null;
    try { dupRow = JSON.parse(dupJ.stdout).rows[0]; } catch { /* reported */ }
    check('C', `${target}: duplicate column names keep their values`, /\| 1 +\| 2 +\|/.test(dup.stdout) && dupRow && dupRow.id === 1 && dupRow.id_2 === 2,
      `${dup.stdout.split('\n')[2]} json ${JSON.stringify(dupRow)}`, '| 1 | 2 |, {id:1,id_2:2}');

    const noLexer = skillCopyWithConfig({}, { readOnly: false });
    try {
      const multi = await run(['--target', target, '--sql', "SELECT 1 --\r; COMMIT; SELECT current_setting('transaction_read_only')"], { skillDir: noLexer });
      check('C', `${target}: with the lexical check off, Postgres itself refuses a second statement`, multi.code === 1 && /cannot insert multiple commands/.test(multi.stderr),
        `exit ${multi.code} ${multi.stderr.trim()}`, 'exit 1, cannot insert multiple commands into a prepared statement');
      const rw = await run(['--target', target, '--sql', "SELECT set_config('transaction_read_only', 'off', true)"], { skillDir: noLexer });
      check('C', `${target}: a statement cannot switch its transaction to read-write`, rw.code === 1 && /SQLSTATE 25001/.test(rw.stderr), rw.stderr.trim(), 'exit 1, SQLSTATE 25001');
      if (target === opts.local) {
        const del = await run(['--target', target, '--sql', `DELETE FROM ${opts.table} WHERE false`], { skillDir: noLexer });
        check('C', `${target}: with the lexical check off, a write fails in the read-only transaction`, del.code === 1 && /SQLSTATE 25006/.test(del.stderr), del.stderr.trim(), 'exit 1, SQLSTATE 25006');
      }
    } finally {
      fs.rmSync(noLexer, { recursive: true, force: true });
    }

    const seq = await run(['--target', target, '--sql', `SELECT nextval(pg_get_serial_sequence('${opts.table}', 'id'))`]);
    check('C', `${target}: nextval blocked by read-only transaction`, seq.code === 1 && /read-only transaction|SQLSTATE (25006|42501)/.test(seq.stderr),
      seq.stderr.trim(), 'exit 1, read-only transaction (25006) or permission denied (42501)');

    const explain = await run(['--target', target, '--sql', 'EXPLAIN ANALYZE SELECT 1']);
    check('C', `${target}: EXPLAIN ANALYZE SELECT works`, explain.code === 0, `exit ${explain.code}`, 'exit 0');

    const sleepR = await run(['--target', target, '--sql', 'SELECT pg_sleep(11)']);
    check('C', `${target}: statement timeout → exit 3`, sleepR.code === 3 && /TIMEOUT/.test(sleepR.stderr), `exit ${sleepR.code} in ${sleepR.ms}ms`, 'exit 3 after ~10 s');

    const probe = await run(['--target', target, '--sql', "SELECT set_config('statement_timeout', '0', true), pg_sleep(12)"]);
    check('C', `${target}: a statement cannot switch off its own timeout`, probe.code === 3, `exit ${probe.code} in ${probe.ms}ms`, 'exit 3');

    if (target === opts.remote) {
      const db = loadTarget(opts.project, opts.remote).pgConfig.host;
      const { left, waitedMs } = await waitForNoClients(db, 15000);
      check('C', 'no ssh tunnel client left after timeouts', left.length === 0, `left: ${left.join(',') || 'none'} after ${waitedMs}ms`, 'none');
    }
  }
}

// ---------------------------------------------------------------- D. several queries
async function groupD() {
  for (const target of [opts.local, opts.remote].filter(Boolean)) {
    const ok = await run(['--target', target, '--verbose', '--sql', 'SELECT 1 AS a', '--sql', 'SELECT 2 AS b', '--sql', 'SELECT 3 AS c']);
    check('D', `${target}: 3 queries ok`, ok.code === 0 && /# Query 3 of 3/.test(ok.stdout) && /-- 3 queries on one connection; target=/.test(ok.stdout),
      `exit ${ok.code} ${ok.stdout.split('\n').at(-2)}`, 'exit 0, 3 headers, footer');
    if (target === opts.remote) check('D', 'batch spawns ssh once', /ssh spawns: 1/.test(ok.stderr), ok.stderr.match(/ssh spawns: \d+/)?.[0]);

    const fail = await run(['--target', target, '--sql', 'SELECT 1 AS a', '--sql', `SELECT nme FROM ${opts.table}`, '--sql', 'SELECT 3 AS c']);
    check('D', `${target}: stops at first failure`, fail.code === 1 && /# Query 2 of 3/.test(fail.stdout) && !/# Query 3 of 3/.test(fail.stdout) &&
      /stopped at query 2 of 3; query 3 was not run/.test(fail.stderr), `exit ${fail.code} ${fail.stderr.trim()}`, 'exit 1, stopped at query 2 of 3');

    const to = await run(['--target', target, '--sql', 'SELECT 1', '--sql', 'SELECT pg_sleep(11)', '--sql', 'SELECT 3']);
    check('D', `${target}: timeout in the middle → exit 3, rest not run`, to.code === 3 && /stopped at query 2 of 3/.test(to.stderr), `exit ${to.code} ${to.stderr.trim()}`);

    const js = await run(['--target', target, '--format', 'json', '--sql', 'SELECT 1 AS a', '--sql', `SELECT nme FROM ${opts.table}`]);
    let parsed = null;
    try { parsed = JSON.parse(js.stdout); } catch { /* reported */ }
    check('D', `${target}: JSON batch shape`, js.code === 1 && parsed && parsed.results.length === 2 && parsed.results[1].error.code === '42703' && parsed.stoppedAt === 2,
      js.stdout.slice(0, 200), '{target, results[2], stoppedAt: 2}');

    const single = await run(['--target', target, '--format', 'json', '--sql', 'SELECT 1 AS a']);
    let s = null;
    try { s = JSON.parse(single.stdout); } catch { /* reported */ }
    check('D', `${target}: single --sql JSON shape unchanged`, s && JSON.stringify(Object.keys(s)) === JSON.stringify(['rows', 'rowCount', 'elapsedMs', 'target', 'truncated', 'limitReached']),
      s ? Object.keys(s).join(',') : single.stdout);

    const dj = await run(['--target', target, '--format', 'json', '--describe', opts.table]);
    let doc = null;
    try { doc = JSON.parse(dj.stdout); } catch { /* reported */ }
    check('D', `${target}: --describe --format json is one document`, dj.code === 0 && doc && doc.table === `public.${opts.table}` &&
      Array.isArray(doc.columns) && doc.columns.length > 0 && Array.isArray(doc.indexes) && Array.isArray(doc.foreignKeys),
      doc ? Object.keys(doc).join(',') : dj.stdout.slice(0, 120), '{target, table, columns, indexes, foreignKeys}');

    const lim = await run(['--target', target, '--sql', 'SELECT g FROM generate_series(1, 200) g']);
    const noLim = await run(['--target', target, '--sql', 'SELECT g FROM generate_series(1, 200) g', '--limit', '500']);
    check('D', `${target}: auto LIMIT reached is reported`, /-- 100 rows .*\(limit 100 reached; more rows may exist\)/.test(lim.stdout) && !/limit \d+ reached/.test(noLim.stdout),
      `${lim.stdout.split('\n').at(-2)} | ${noLim.stdout.split('\n').at(-2)}`);

    if (target === opts.remote) {
      const d = await run(['--target', target, '--verbose', '--describe', opts.table]);
      check('D', 'describe spawns ssh once', d.code === 0 && /ssh spawns: 1/.test(d.stderr), d.stderr.match(/ssh spawns: \d+/)?.[0]);
    }
  }
}

// ---------------------------------------------------------------- E. SSH lifecycle
function skillCopyWithConfig(patch, topPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgsk-skill-'));
  fs.cpSync(SKILL_DIR, dir, { recursive: true, filter: src => !/\/(\.git|test|plans)(\/|$)/.test(src) });
  const cfgFile = path.join(dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  Object.assign(cfg, topPatch);
  cfg.ssh = { ...cfg.ssh, ...patch };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  return dir;
}

async function groupE() {
  const T = opts.remote;
  const q = ['--target', T, '--verbose', '--sql', 'SELECT 1'];
  await closeSharedConnection(remoteSsh());

  const first = await run(q);
  const second = await run(q);
  check('E', 'first call opens the shared connection', first.code === 0 && /shared SSH connection: opened/.test(first.stderr), `${first.ms}ms ${first.stderr.match(/shared SSH connection: \w+/)?.[0]}`);
  check('E', 'second call reuses it and is faster', second.code === 0 && /shared SSH connection: reused/.test(second.stderr) && second.ms < first.ms,
    `${first.ms}ms → ${second.ms}ms`, 'reused, faster');
  check('E', 'the call returned while the shared connection stays alive', Boolean(await masterPid()) && !/KILLED/.test(second.stderr), `master pid ${await masterPid()}`);
  const timed = await run(q);
  const connectMs = Number(timed.stderr.match(/connected in (\d+)ms/)?.[1]);
  check('E', 'no exit delay: the call ends right after the query', timed.code === 0 && timed.ms - connectMs < 1500,
    `${timed.ms}ms total, connect ${connectMs}ms, rest ${timed.ms - connectMs}ms`, '< 1500 ms beyond connect (was ~2.4 s)');
  const cp = controlPath(remoteSsh());
  check('E', 'shared socket lives in ~/.ssh', cp.startsWith(path.join(os.homedir(), '.ssh') + path.sep) && fs.existsSync(cp), cp);

  const close1 = await run(['--target', T, '--close-tunnel']);
  const close2 = await run(['--target', T, '--close-tunnel']);
  check('E', '--close-tunnel closes it', /Closed the shared SSH connection/.test(close1.stdout) && !(await masterPid()), close1.stdout.trim());
  check('E', '--close-tunnel with nothing open', /Nothing closed/.test(close2.stdout), close2.stdout.trim());

  const short = skillCopyWithConfig({ controlPersistSeconds: 15 });
  try {
    await closeSharedConnection(remoteSsh());
    let opened = await run(q, { skillDir: short });
    if (!/shared SSH connection: opened/.test(opened.stderr)) opened = await run(q, { skillDir: short });
    const alive = await masterPid();
    await sleep(22000);
    const after = await masterPid();
    check('E', 'shared connection exits by itself after the idle time', alive && !after,
      `open run: exit ${opened.code}, ${opened.stderr.match(/shared SSH connection: \w+/)?.[0]}; alive=${alive} after 22s=${after}`, 'alive, then gone');
  } finally {
    fs.rmSync(short, { recursive: true, force: true });
  }

  await closeSharedConnection(remoteSsh());
  const parallel = await Promise.all([1, 2, 3, 4].map(() => run(q)));
  const db = loadTarget(opts.project, T).pgConfig.host;
  await sleep(500);
  const masters = await sharedMasters();
  const clients = await tunnelClients(db);
  check('E', '4 parallel first calls all succeed', parallel.every(r => r.code === 0), parallel.map(r => `${r.code}/${r.ms}ms`).join(' '));
  check('E', 'exactly one shared connection remains, no per-call ssh left', masters.length === 1 && masters[0] === await masterPid() && clients.length === 0,
    `masters: ${masters.join(',') || 'none'}; per-call: ${clients.join(',') || 'none'}`, 'one master, no per-call ssh');

  const frozen = await masterPid();
  if (frozen) {
    process.kill(frozen, 'SIGSTOP');
    try {
      const r = await run(q, { timeoutMs: 120000 });
      check('E', 'frozen shared connection: the call still succeeds (ssh fallback or skill retry)', r.code === 0 && r.ms < 45000,
        `exit ${r.code} in ${r.ms}ms; ${r.stderr.split('\n').filter(l => /retry|connected/.test(l)).join(' | ')}`, 'exit 0 within 45 s');
    } finally {
      try { process.kill(frozen, 'SIGCONT'); } catch { /* gone */ }
    }
  }
  await closeSharedConnection(remoteSsh(), { timeoutMs: 5000 });
  try { if (frozen) process.kill(frozen, 'SIGKILL'); } catch { /* already gone */ }

  await run(q);
  const victim = await masterPid();
  if (victim) process.kill(victim, 'SIGKILL');
  await sleep(300);
  const socketLeft = fs.existsSync(controlPath(remoteSsh()));
  const recover = await run(q);
  check('E', 'killed shared connection (stale socket) recovers', recover.code === 0, `socket left=${socketLeft}; exit ${recover.code} in ${recover.ms}ms`);

  const pending = run(['--target', T, '--sql', 'SELECT pg_sleep(8)']);
  await sleep(4000);
  const nodePid = run.last.pid;
  process.kill(nodePid, 'SIGTERM');
  await pending;
  const { left, waitedMs } = await waitForNoClients(db, 15000);
  check('E', 'node killed mid-query: its ssh client exits once the running query ends (≤ statement timeout)', left.length === 0,
    `left: ${left.join(',') || 'none'} after ${waitedMs}ms`, 'none within 15 s');
}

// ---------------------------------------------------------------- F. SSH failures
async function groupF() {
  const R = opts.remote;
  const fx = {
    live_wronguser: deriveTarget(R, { DB_SSH_USER: 'no-such-user' }),
    live_nobastion: deriveTarget(R, { DB_SSH_HOST: '10.255.255.1' }),
    live_nodbhost: deriveTarget(R, { DB_HOST: 'no-such-host.invalid' }),
    live_dbport: deriveTarget(R, { DB_PORT: '1' }),
    live_nokey: deriveTarget(R, { DB_SSH_KEY: '/no/such/key.pem' }),
  };
  await withFixtures(fx, async () => {
    const q = name => run(['--target', name, '--verbose', '--sql', 'SELECT 1'], { timeoutMs: 120000 });
    let r = await q('live_wronguser');
    check('F', 'wrong DB_SSH_USER → AUTH_FAILED', r.code === 6 && /SSH AUTH_FAILED/.test(r.stderr), `exit ${r.code} in ${r.ms}ms: ${r.stderr.split('\n').find(l => l.startsWith('SSH'))}`);
    r = await q('live_nobastion');
    check('F', 'unreachable bastion → BASTION_UNREACHABLE after one retry', r.code === 6 && /SSH BASTION_UNREACHABLE/.test(r.stderr) && /retrying once/.test(r.stderr),
      `exit ${r.code} in ${r.ms}ms`, 'exit 6, ~20 s (10 s + retry)');
    r = await q('live_nodbhost');
    check('F', 'unknown DB host → DB_UNREACHABLE fast', r.code === 6 && /SSH DB_UNREACHABLE/.test(r.stderr) && r.ms < 10000, `exit ${r.code} in ${r.ms}ms`, 'exit 6, < 10 s');
    await run(['--target', R, '--sql', 'SELECT 1']);
    r = await q('live_dbport');
    check('F', 'filtered DB port with a healthy shared connection → DB_UNREACHABLE, no retry', r.code === 6 && /SSH DB_UNREACHABLE/.test(r.stderr) && !/retrying once/.test(r.stderr) && r.ms < 30000,
      `exit ${r.code} in ${r.ms}ms`, 'exit 6 after ~20 s, no retry');
    r = await q('live_nokey');
    check('F', 'missing key file → exit 4 before connecting', r.code === 4 && /DB_SSH_KEY file not found/.test(r.stderr), `exit ${r.code}: ${r.stderr.trim()}`);
  });
}

// ---------------------------------------------------------------- G. host key
async function groupG() {
  if (!opts.unknownHost) { check('G', 'unknown host given', false, 'no --unknown-host', '--unknown-host <name>'); return; }
  const known = path.join(os.homedir(), '.ssh/known_hosts');
  const hash = () => (fs.existsSync(known) ? crypto.createHash('sha1').update(fs.readFileSync(known)).digest('hex') : 'none');
  const before = hash();
  await withFixtures({ live_newhost: deriveTarget(opts.remote, { DB_SSH_HOST: opts.unknownHost }) }, async () => {
    const r = await run(['--target', 'live_newhost', '--sql', 'SELECT 1']);
    check('G', 'unknown host key → HOST_KEY_UNKNOWN with fingerprint and accept command', r.code === 6 && /SSH HOST_KEY_UNKNOWN/.test(r.stderr) &&
      /SHA256:\S+/.test(r.stderr) && /--accept-host-key SHA256:/.test(r.stderr), r.stderr.trim());
    const wrong = await run(['--target', 'live_newhost', '--accept-host-key', 'SHA256:wrongwrongwrong']);
    check('G', 'accepting a fingerprint the bastion does not present is refused', wrong.code === 6 && /HOST_KEY_MISMATCH/.test(wrong.stderr), wrong.stderr.trim());
  });
  check('G', 'known_hosts untouched', hash() === before, hash() === before ? 'unchanged' : 'CHANGED');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgsk-hk-'));
  try {
    await sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'k')]);
    const pub = fs.readFileSync(path.join(dir, 'k.pub'), 'utf8').trim().split(/\s+/);
    const t = loadTarget(opts.project, opts.remote);
    const kh = path.join(dir, 'known_hosts');
    fs.writeFileSync(kh, `${t.ssh.host} ${pub[0]} ${pub[1]}\n`);
    const cfg = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8')).ssh;
    const { args } = buildSshArgs(t.ssh, t.pgConfig.host, t.pgConfig.port, cfg, { reuse: false });
    args.splice(args.length - 1, 0, '-o', `UserKnownHostsFile=${kh}`, '-o', 'GlobalKnownHostsFile=/dev/null');
    const r = await runCommand('ssh', args, { timeoutMs: 30000 });
    check('G', 'changed host key is detected with the skill\'s ssh options (LogLevel=ERROR, LC_ALL=C)',
      r.code === 255 && classifySshFailure(r.stderr).kind === 'HOST_KEY_CHANGED', `exit ${r.code}: ${r.stderr.trim().split('\n')[1] || r.stderr.trim()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- H. database side
async function groupH() {
  const R = opts.remote;
  const lt = await run(['--target', R, '--list-tables']);
  check('H', 'list tables', lt.code === 0 && /-- \d+ rows/.test(lt.stdout), lt.stdout.split('\n').at(-2));
  const d = await run(['--target', R, '--describe', opts.table]);
  check('H', 'describe', d.code === 0 && /— foreign keys/.test(d.stdout), `exit ${d.code}`);
  const withFk = await run(['--target', R, '--format', 'json', '--sql',
    "SELECT n.nspname || '.' || t.relname AS t FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE c.contype = 'f' ORDER BY 1 LIMIT 1"]);
  let fkTable = null;
  try { fkTable = JSON.parse(withFk.stdout).rows[0]?.t; } catch { /* reported below */ }
  if (fkTable) {
    const fd = await run(['--target', R, '--describe', fkTable]);
    const fkSection = fd.stdout.split('— foreign keys')[1] || '';
    check('H', `describe ${fkTable} lists its foreign keys even when the role does not own the table`,
      fd.code === 0 && !/\(no rows\)/.test(fkSection) && /-- [1-9]\d* rows/.test(fkSection), fkSection.trim().split('\n').at(-1));
  } else {
    check('H', 'found a table with a foreign key', false, withFk.stderr || withFk.stdout);
  }
  const big = await run(['--target', R, '--sql', `SELECT id FROM ${opts.table}`, '--no-auto-limit']);
  check('H', 'large result over the tunnel', big.code === 0, big.stdout.split('\n').at(-2));
  const fx = {};
  if (opts.dbOk) fx.live_dbok = deriveTarget(R, { DB_NAME: opts.dbOk });
  if (opts.dbDenied) fx.live_dbdenied = deriveTarget(R, { DB_NAME: opts.dbDenied });
  await withFixtures(fx, async () => {
    if (opts.dbOk) {
      const r = await run(['--target', 'live_dbok', '--sql', `SELECT count(*) FROM ${opts.table}`]);
      check('H', `${opts.dbOk} readable`, r.code === 0, r.stdout.split('\n')[2] || r.stderr);
    }
    if (opts.dbDenied) {
      const r = await run(['--target', 'live_dbdenied', '--sql', `SELECT count(*) FROM ${opts.table}`]);
      check('H', `${opts.dbDenied} without grants → clean ERROR, exit 1`, r.code === 1 && /^ERROR: permission denied/.test(r.stderr) && !/\n\s+at /.test(r.stderr), r.stderr.trim());
    }
  });
}

// ---------------------------------------------------------------- I. connection errors and CLI
async function groupI() {
  const L = opts.local;
  const fx = {
    live_nodb: deriveTarget(L, { DB_NAME: 'no_such_db_pgsk' }),
    live_blackhole: deriveTarget(L, { DB_HOST: '10.255.255.1' }),
  };
  if (opts.remote) fx.live_badpw = deriveTarget(opts.remote, { DB_PASSWORD: 'wrong-password-pgsk' });
  await withFixtures(fx, async () => {
    let r = await run(['--target', 'live_nodb', '--sql', 'SELECT 1']);
    check('I', 'unknown database → exit 5 CONNECTION with SQLSTATE 3D000', r.code === 5 && /^CONNECTION: .*\(SQLSTATE 3D000\)/.test(r.stderr), `exit ${r.code} ${r.stderr.trim()}`);
    r = await run(['--target', 'live_blackhole', '--sql', 'SELECT 1'], { timeoutMs: 60000 });
    check('I', 'unreachable direct host → exit 5 after the connect timeout', r.code === 5 && /no answer from 10\.255\.255\.1:\d+ within 10000ms/.test(r.stderr) && r.ms < 15000,
      `exit ${r.code} in ${r.ms}ms ${r.stderr.trim()}`, 'exit 5 in ~10 s');
    if (opts.remote) {
      r = await run(['--target', 'live_badpw', '--sql', 'SELECT 1']);
      check('I', 'wrong password through the bastion → exit 5 with SQLSTATE 28P01', r.code === 5 && /^CONNECTION: .*\(SQLSTATE 28P01\)/.test(r.stderr), `exit ${r.code} ${r.stderr.trim()}`);
    }
  });

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pgsk-nopg-'));
  try {
    fs.writeFileSync(path.join(bare, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(bare, '.db.demo'), 'DB_HOST=localhost\nDB_PORT=5432\nDB_USER=u\nDB_PASSWORD=p\nDB_NAME=d\n', { mode: 0o600 });
    const lt = await run(['--list-targets'], { cwd: bare });
    check('I', '--list-targets works without pg installed', lt.code === 0 && lt.stdout.trim() === 'demo', `exit ${lt.code} ${lt.stdout.trim()} ${lt.stderr.trim()}`);
    const q = await run(['--target', 'demo', '--sql', 'SELECT 1'], { cwd: bare });
    check('I', 'a query without pg installed → exit 5 with install hint', q.code === 5 && /cannot resolve 'pg'/.test(q.stderr), `exit ${q.code} ${q.stderr.split('\n')[0]}`);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }

  const two = await run(['--target', L, '--list-tables', '--sql', 'SELECT 1']);
  check('I', 'two actions in one call → usage error', two.code === 1 && /Pass one action per call/.test(two.stderr), `exit ${two.code} ${two.stderr.split('\n')[0]}`);
  const missing = await run(['--target', 'no_such_target_xyz', '--sql', 'SELECT 1']);
  check('I', 'missing target → exit 4, first line starts with TARGET:', missing.code === 4 && /^TARGET: /.test(missing.stderr), missing.stderr.split('\n')[0]);
  const trav = await run(['--target', '../x', '--sql', 'SELECT 1']);
  check('I', 'target name with a path is refused', trav.code === 4 && /^TARGET: /.test(trav.stderr), trav.stderr.split('\n')[0]);
}

const GROUPS = { A: groupA, B: groupB, C: groupC, D: groupD, E: groupE, F: groupF, G: groupG, H: groupH, I: groupI };
const NEEDS_REMOTE = new Set(['E', 'F', 'G', 'H']);
for (const [g, fn] of Object.entries(GROUPS)) {
  if (!opts.groups.has(g)) continue;
  if (NEEDS_REMOTE.has(g) && !opts.remote) continue;
  process.stdout.write(`\n=== group ${g}\n`);
  try {
    await fn();
  } catch (err) {
    check(g, 'group crashed', false, err.stack);
  }
}

const failed = results.filter(r => !r.pass);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (opts.report) {
  const lines = ['| Group | Check | Result | Actual |', '| --- | --- | --- | --- |',
    ...results.map(r => `| ${r.group} | ${r.name} | ${r.pass ? 'PASS' : '**FAIL**'} | ${r.actual.replace(/\|/g, '\\|')} |`)];
  fs.writeFileSync(opts.report, `# Live test report — ${new Date().toISOString()}\n\n${results.length - failed.length}/${results.length} passed\n\n${lines.join('\n')}\n`);
}
process.exitCode = failed.length ? 1 : 0;
