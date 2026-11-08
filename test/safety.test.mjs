import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validate, stripStringsAndComments, isSingleStatement, SafetyError, buildExecution, removeTrailingSemicolon, applyAutoLimit,
} from '../lib/safety.mjs';

const CONFIG = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')));

const ok = sql => assert.doesNotThrow(() => validate(sql, CONFIG), sql);
const rejected = (sql, re) => assert.throws(() => validate(sql, CONFIG), err => err instanceof SafetyError && (!re || re.test(err.message)), sql);

test('plain reads are allowed', () => {
  ok('SELECT 1');
  ok('select * from users where id = 1;');
  ok('WITH x AS (SELECT 1) SELECT * FROM x');
  ok('EXPLAIN ANALYZE SELECT 1');
  ok('SHOW statement_timeout');
  ok('(SELECT 1) UNION (SELECT 2)');
  ok("SELECT CASE WHEN true THEN 'a' END AS c");
});

test('a trailing semicolon or trailing comment is still one statement', () => {
  ok('SELECT 1;');
  ok('SELECT 1;   ');
  ok('SELECT 1; -- trailing note');
  ok('SELECT 1; /* note */');
});

test('two statements in one --sql are rejected (read-only escape)', () => {
  rejected("SELECT 1; COMMIT; SELECT current_setting('transaction_read_only')", /one statement/);
  rejected('SELECT 1; END; SELECT 2', /one statement/);
  rejected('SELECT 1;SELECT 2', /one statement/);
  rejected('SELECT 1;\n\nSELECT 2', /one statement/);
});

test('semicolons inside strings, identifiers, comments and dollar quotes do not count', () => {
  ok("SELECT 'a;b' AS x");
  ok("SELECT 'it''s; fine' AS x");
  ok('SELECT 1 AS "a;b"');
  ok('SELECT 1 /* ; */ AS x');
  ok('SELECT 1 -- ;\n AS x');
  ok('SELECT $$a;b$$ AS x');
  ok('SELECT $tag$a;b$tag$ AS x');
  ok("SELECT E'a\\';b' AS x");
});

test('E-strings with backslash escapes cannot hide a second statement', () => {
  rejected("SELECT E'\\''; COMMIT; DELETE FROM users; SELECT ''");
  rejected("SELECT E'\\''; COMMIT; SELECT setval('users_id_seq', 1), ''");
});

test('nested block comments are handled', () => {
  ok('SELECT 1 /* outer /* inner ; */ still comment ; */ AS x');
  rejected('SELECT 1 /* a /* b */ c */; DELETE FROM t');
});

test('forbidden keywords are rejected outside strings and identifiers', () => {
  rejected('DELETE FROM users', /starts with "DELETE"/);
  rejected('WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x', /DELETE/);
  rejected('SELECT * FROM t FOR UPDATE', /UPDATE/);
  ok("SELECT 'DELETE FROM users' AS note");
  ok('SELECT 1 AS "update"');
  ok('SELECT 1 -- DROP TABLE users');
});

test('dollar signs inside identifiers are not dollar quotes', () => {
  ok('SELECT a$b$c FROM t');
  assert.equal(isSingleStatement(stripStringsAndComments('SELECT a$b$; SELECT 1')), false);
});

test('a carriage return ends a -- comment, as in Postgres', () => {
  rejected("SELECT 1 --\r; COMMIT; SELECT current_setting('transaction_read_only')", /one statement/);
  rejected('SELECT 1 --\r; COMMIT; DELETE FROM users WHERE false');
  ok('SELECT 1 -- note\r\n AS x');
});

test('stripping keeps every character position', () => {
  for (const sql of [
    "SELECT 'a;b', E'\\'', \"x\"\"y\", $t$z$t$ /* c /* d */ */ -- e\r\nFROM t",
    "SELECT 'unterminated",
    'SELECT 1 /* unterminated',
    'SELECT $$unterminated',
  ]) {
    assert.equal(stripStringsAndComments(sql).length, sql.length, sql);
  }
});

test('trailing semicolon is removed even before a trailing comment', () => {
  assert.equal(removeTrailingSemicolon('SELECT 1;'), 'SELECT 1');
  assert.equal(removeTrailingSemicolon('SELECT 1; -- note'), 'SELECT 1 -- note');
  assert.equal(removeTrailingSemicolon("SELECT ';'"), "SELECT ';'");
  assert.equal(removeTrailingSemicolon('SELECT 1 -- ;'), 'SELECT 1 -- ;');
});

test('auto LIMIT goes on its own line after a trailing comment', () => {
  assert.deepEqual(applyAutoLimit('SELECT 1; -- note', CONFIG), { sql: 'SELECT 1 -- note\nLIMIT 100', limit: 100 });
  assert.deepEqual(applyAutoLimit('SELECT 1 LIMIT 5 -- note', CONFIG), { sql: 'SELECT 1 LIMIT 5 -- note', limit: null });
  assert.deepEqual(applyAutoLimit('SHOW server_version -- note', CONFIG), { sql: 'SHOW server_version -- note', limit: null });
  assert.deepEqual(applyAutoLimit('SELECT 1', CONFIG, { limitOverride: 5 }), { sql: 'SELECT 1\nLIMIT 5', limit: 5 });
  assert.deepEqual(applyAutoLimit('SELECT 1;', CONFIG, { autoLimit: false }), { sql: 'SELECT 1', limit: null });
});

test('buildExecution sends the read-only prelude separately from the user statement', () => {
  const exec = buildExecution('SELECT 1;', CONFIG);
  assert.equal(exec.prelude, 'BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = 10000');
  assert.equal(exec.userSql, 'SELECT 1\nLIMIT 100');
  assert.equal(exec.autoLimit, 100);
  assert.equal(buildExecution('SELECT 1', { ...CONFIG, wrapInReadOnlyTx: false }).prelude, null);
});
