#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage: node test/bench.mjs --project <dir> [--remote <bastion target>] [--local <target>]
  [--skill <path to bin/query.mjs>] [--runs 20] [--table users] [--label name] [--out results.json]

Times whole CLI invocations (wall clock, node start to exit) for:
  remote-warm-single, remote-warm-batch3, remote-warm-describe, remote-cold-single (shared SSH connection
  closed before each run), local-single. Read-only queries only.`;

function parse(argv) {
  const o = { runs: 20, table: 'users', skill: path.join(HERE, '..', 'bin', 'query.mjs') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--project') o.project = v();
    else if (k === '--remote') o.remote = v();
    else if (k === '--local') o.local = v();
    else if (k === '--skill') o.skill = path.resolve(v());
    else if (k === '--runs') o.runs = Number(v());
    else if (k === '--table') o.table = v();
    else if (k === '--label') o.label = v();
    else if (k === '--out') o.out = v();
    else { console.error(USAGE); process.exit(1); }
  }
  if (!o.project || (!o.remote && !o.local) || !(o.runs > 0)) { console.error(USAGE); process.exit(1); }
  return o;
}

const opts = parse(process.argv.slice(2));

function run(args) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn(process.execPath, [opts.skill, ...args], { cwd: opts.project, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, ms: Number(process.hrtime.bigint() - start) / 1e6, stderr }));
  });
}

function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1], mean };
}

async function scenario(name, args, { before } = {}) {
  const ms = [];
  for (let i = 0; i < opts.runs; i++) {
    if (before) await before();
    const r = await run(args);
    if (r.code !== 0) throw new Error(`${name} run ${i + 1} exited ${r.code}: ${r.stderr.trim()}`);
    ms.push(r.ms);
  }
  const st = stats(ms);
  process.stderr.write(`${name.padEnd(22)} median ${st.median.toFixed(0)} ms  p90 ${st.p90.toFixed(0)}  min ${st.min.toFixed(0)}  max ${st.max.toFixed(0)}\n`);
  return { name, args, ms, ...st };
}

const results = [];
if (opts.remote) {
  const t = ['--target', opts.remote];
  const single = [...t, '--sql', `SELECT count(*) FROM ${opts.table}`];
  await run([...t, '--close-tunnel']);
  await run(single);
  results.push(await scenario('remote-warm-single', single));
  results.push(await scenario('remote-warm-batch3', [...t,
    '--sql', `SELECT count(*) FROM ${opts.table}`,
    '--sql', 'SELECT current_database(), current_user',
    '--sql', `SELECT * FROM ${opts.table} ORDER BY 1 DESC LIMIT 3`]));
  results.push(await scenario('remote-warm-describe', [...t, '--describe', opts.table]));
  results.push(await scenario('remote-cold-single', single, { before: () => run([...t, '--close-tunnel']) }));
  await run([...t, '--close-tunnel']);
}
if (opts.local) {
  results.push(await scenario('local-single', ['--target', opts.local, '--sql', `SELECT count(*) FROM ${opts.table}`]));
}

const report = { label: opts.label || null, skill: opts.skill, runs: opts.runs, at: new Date().toISOString(), results };
if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n');
