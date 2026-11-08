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
  const a = parseArgs(['--target', 'dev', '--accept-host-key', 'SHA256:abc', '--verbose']);
  assert.equal(a.acceptHostKey, 'SHA256:abc');
  assert.equal(a.verbose, true);
  assert.equal(parseArgs(['--target', 'dev', '--close-tunnel']).closeTunnel, true);
});

test('one action per call', () => {
  assert.throws(() => parseArgs(['--target', 'dev', '--list-tables', '--sql', 'SELECT 1']), /--list-tables and --sql\/--file/);
  assert.throws(() => parseArgs(['--target', 'dev', '--describe', 'users', '--close-tunnel']), UsageError);
  assert.doesNotThrow(() => parseArgs(['--target', 'dev', '--sql', 'SELECT 1', '--file', 'q.sql']));
});

test('bad values are usage errors', () => {
  assert.throws(() => parseArgs(['--limit', 'abc']), UsageError);
  assert.throws(() => parseArgs(['--limit', '0']), UsageError);
  assert.throws(() => parseArgs(['--format', 'csv']), UsageError);
  assert.throws(() => parseArgs(['--sql']), UsageError);
  assert.throws(() => parseArgs(['--nope']), UsageError);
});
