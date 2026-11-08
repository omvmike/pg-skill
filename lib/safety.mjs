export class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SAFETY_VIOLATION';
  }
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

function readDollarTag(sql, i) {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
  return m ? m[0] : null;
}

function placeholder(length, quote) {
  if (!quote) return ' '.repeat(length);
  return length >= 2 ? quote + ' '.repeat(length - 2) + quote : quote.repeat(length);
}

export function stripStringsAndComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    const start = i;

    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out += placeholder(i - start);
      continue;
    }

    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      out += placeholder(Math.min(i, n) - start);
      i = Math.min(i, n);
      continue;
    }

    const prevIsIdent = i > 0 && IDENT_CHAR.test(sql[i - 1]);

    if ((c === 'E' || c === 'e') && next === "'" && !prevIsIdent) {
      i += 2;
      while (i < n) {
        if (sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      i = Math.min(i, n);
      out += ' ' + placeholder(i - start - 1, "'");
      continue;
    }

    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      i = Math.min(i, n);
      out += placeholder(i - start, "'");
      continue;
    }

    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      i = Math.min(i, n);
      out += placeholder(i - start, '"');
      continue;
    }

    if (c === '$' && !prevIsIdent) {
      const tag = readDollarTag(sql, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += placeholder(i - start, "'");
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

export function getLeadingKeyword(stripped) {
  const m = stripped.match(/^\s*\(*\s*([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : null;
}

export function containsKeyword(stripped, keyword) {
  return new RegExp(`\\b${keyword}\\b`, 'i').test(stripped);
}

export function isSingleStatement(stripped) {
  return !/;\s*\S/.test(stripped);
}

export function validate(sql, config) {
  if (!config.readOnly) return;
  const stripped = stripStringsAndComments(sql);
  const leading = getLeadingKeyword(stripped);
  if (!leading) {
    throw new SafetyError('Empty or unparseable statement.');
  }
  if (!config.allowedLeadingKeywords.map(k => k.toUpperCase()).includes(leading)) {
    throw new SafetyError(
      `Statement starts with "${leading}" — only ${config.allowedLeadingKeywords.join('/')} are allowed.`
    );
  }
  if (!isSingleStatement(stripped)) {
    throw new SafetyError('Only one statement per --sql / --file is allowed. Pass each statement as its own --sql.');
  }
  for (const kw of config.forbiddenKeywords) {
    if (containsKeyword(stripped, kw)) {
      throw new SafetyError(`Forbidden keyword "${kw.toUpperCase()}" found in statement.`);
    }
  }
}

export function removeTrailingSemicolon(sql) {
  const stripped = stripStringsAndComments(sql);
  const m = /;(\s*)$/.exec(stripped);
  if (!m) return sql;
  return sql.slice(0, m.index) + sql.slice(m.index + 1);
}

export function applyAutoLimit(sql, config, { autoLimit = true, limitOverride = null } = {}) {
  const statement = removeTrailingSemicolon(sql);
  if (!autoLimit) return { sql: statement, limit: null };
  const stripped = stripStringsAndComments(statement);
  const leading = getLeadingKeyword(stripped);
  if (leading !== 'SELECT' && leading !== 'WITH') return { sql: statement, limit: null };
  if (containsKeyword(stripped, 'LIMIT')) return { sql: statement, limit: null };
  const limit = limitOverride ?? config.defaultLimit;
  return { sql: `${statement.replace(/\s+$/, '')}\nLIMIT ${limit}`, limit };
}

export function maybeAppendLimit(sql, config, opts) {
  return applyAutoLimit(sql, config, opts).sql;
}

export function buildExecution(userSql, config, opts = {}) {
  const { sql, limit } = applyAutoLimit(userSql, config, opts);
  const prelude = config.wrapInReadOnlyTx
    ? `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = ${Number(config.statementTimeoutMs)}`
    : null;
  return { prelude, userSql: sql, autoLimit: limit };
}
