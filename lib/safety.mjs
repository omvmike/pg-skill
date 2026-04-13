export class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SAFETY_VIOLATION';
  }
}

export function stripStringsAndComments(sql) {
  let s = sql;
  s = s.replace(/--[^\n]*/g, ' ');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, " '' ");
  s = s.replace(/'(?:[^']|'')*'/g, " '' ");
  return s;
}

export function getLeadingKeyword(stripped) {
  const m = stripped.match(/^\s*\(*\s*([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : null;
}

export function containsKeyword(stripped, keyword) {
  return new RegExp(`\\b${keyword}\\b`, 'i').test(stripped);
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
  for (const kw of config.forbiddenKeywords) {
    if (containsKeyword(stripped, kw)) {
      throw new SafetyError(`Forbidden keyword "${kw.toUpperCase()}" found in statement.`);
    }
  }
}

export function maybeAppendLimit(sql, config, { autoLimit = true, limitOverride = null } = {}) {
  if (!autoLimit) return sql;
  const stripped = stripStringsAndComments(sql);
  const leading = getLeadingKeyword(stripped);
  if (leading !== 'SELECT' && leading !== 'WITH') return sql;
  if (containsKeyword(stripped, 'LIMIT')) return sql;
  const limit = limitOverride ?? config.defaultLimit;
  const trimmed = sql.replace(/;\s*$/, '');
  return `${trimmed}\nLIMIT ${limit}`;
}

export function buildExecutionSql(userSql, config, { autoLimit = true, limitOverride = null } = {}) {
  const finalUserSql = maybeAppendLimit(userSql, config, { autoLimit, limitOverride });
  const noTrailingSemi = finalUserSql.replace(/;\s*$/, '');
  if (!config.wrapInReadOnlyTx) {
    return { sql: noTrailingSemi, wrapped: false, finalUserSql: noTrailingSemi };
  }
  const sql =
    `BEGIN TRANSACTION READ ONLY;\n` +
    `SET LOCAL statement_timeout = ${config.statementTimeoutMs};\n` +
    `${noTrailingSemi};\n` +
    `ROLLBACK;`;
  return { sql, wrapped: true, finalUserSql: noTrailingSemi };
}
