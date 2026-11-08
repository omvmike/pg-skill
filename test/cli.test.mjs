import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, UsageError } from '../lib/cli.mjs';

test('repeated --sql and --file keep their order', () => {
  const a = parseArgs(['--target', 'dev', '--sql', 'SELECT 1', '--file', 'q.sql', '--sql', 'SELECT 2']);
  assert.deepEqual(a.queries, [
    { kind: 'sql', value: 'SELECT 1' },
    { kind: 'file', value: 'q.sql' },
    { kind: 'sql', value: 'SELECT 2' },
  ]);
});

test('new flags', () => {
  const a = parseArgs(['--target', 'dev', '--accept-host-key', 'SHA256:abc', '--close-tunnel', '--verbose']);
  assert.equal(a.acceptHostKey, 'SHA256:abc');
  assert.equal(a.closeTunnel, true);
  assert.equal(a.verbose, true);
});

test('bad values are usage errors', () => {
  assert.throws(() => parseArgs(['--limit', 'abc']), UsageError);
  assert.throws(() => parseArgs(['--limit', '0']), UsageError);
  assert.throws(() => parseArgs(['--format', 'csv']), UsageError);
  assert.throws(() => parseArgs(['--sql']), UsageError);
  assert.throws(() => parseArgs(['--nope']), UsageError);
});
