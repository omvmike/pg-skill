import test from 'node:test';
import assert from 'node:assert/strict';
import { stoppedLine, batchFooter, formatSqlError, batchHeader } from '../lib/format.mjs';

test('stopped line names the queries that did not run', () => {
  assert.equal(stoppedLine(2, 3), '-- stopped at query 2 of 3; query 3 was not run');
  assert.equal(stoppedLine(1, 4), '-- stopped at query 1 of 4; queries 2–4 were not run');
  assert.equal(stoppedLine(3, 3), null);
});

test('batch header and footer', () => {
  assert.equal(batchHeader(1, 3), '# Query 1 of 3');
  assert.equal(
    batchFooter({ total: 3, target: 'dev', via: 'ec2-user@203.0.113.10', connectMs: 1812, shared: 'reused' }),
    '-- 3 queries on one connection; target=dev; via bastion ec2-user@203.0.113.10; connected in 1812ms (shared SSH connection reused)',
  );
  assert.equal(batchFooter({ total: 2, target: 'local', via: null, connectMs: 5, shared: null }),
    '-- 2 queries on one connection; target=local; connected in 5ms');
});

test('SQL errors print message, SQLSTATE and hint', () => {
  assert.equal(formatSqlError({ message: 'column "nme" does not exist', code: '42703' }),
    'ERROR: column "nme" does not exist (SQLSTATE 42703)');
  assert.equal(formatSqlError({ message: 'x', code: '42703', hint: 'Perhaps you meant "name".' }),
    'ERROR: x (SQLSTATE 42703)\nHINT: Perhaps you meant "name".');
});

test('JSON output renders bytea as hex and dates as ISO', async () => {
  const { formatJson, formatJsonDocument } = await import('../lib/format.mjs');
  const row = { bytes: Buffer.from([0, 255]), at: new Date('2026-11-02T10:30:00Z') };
  assert.deepEqual(JSON.parse(formatJson([row], {})).rows[0], { bytes: '\\x00ff', at: '2026-11-02T10:30:00.000Z' });
  assert.deepEqual(JSON.parse(formatJsonDocument({ results: [{ rows: [row] }] })).results[0].rows[0].bytes, '\\x00ff');
});

test('duplicate column names keep their own values', async () => {
  const { formatTable, rowsToObjects, columnNames } = await import('../lib/format.mjs');
  const fields = [{ name: 'id' }, { name: 'id' }, { name: 'name' }];
  const rows = [[1, 2, 'a|b\nc']];
  assert.equal(formatTable(rows, fields), '| id | id | name   |\n| -- | -- | ------ |\n| 1  | 2  | a\\|b c |');
  assert.deepEqual(columnNames(fields), ['id', 'id_2', 'name']);
  assert.deepEqual(rowsToObjects(rows, fields), [{ id: 1, id_2: 2, name: 'a|b\nc' }]);
});

test('long bytea cells are cut at the cell width, and limit reached is reported', async () => {
  const { formatTable, summaryLine } = await import('../lib/format.mjs');
  const out = formatTable([[Buffer.alloc(100)]], [{ name: 'b' }], { cellMaxLength: 10 });
  assert.match(out, /\| \\x0000000… \|$/);
  assert.equal(summaryLine({ rowCount: 100, elapsedMs: 5, target: 'dev', limitReached: true, autoLimit: 100 }),
    '-- 100 rows in 5ms from target=dev (limit 100 reached; more rows may exist)');
});
