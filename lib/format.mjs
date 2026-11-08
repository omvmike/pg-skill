function renderCell(value, max) {
  if (value === null || value === undefined) return 'NULL';
  let s;
  if (value instanceof Date) s = value.toISOString();
  else if (Buffer.isBuffer(value)) s = `\\x${value.toString('hex')}`;
  else if (typeof value === 'object') {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  } else {
    s = String(value);
  }
  s = s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  if (max && s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

export function columnNames(fields) {
  const seen = new Map();
  return fields.map(f => {
    const count = (seen.get(f.name) || 0) + 1;
    seen.set(f.name, count);
    return count === 1 ? f.name : `${f.name}_${count}`;
  });
}

export function rowsToObjects(rows, fields) {
  const names = columnNames(fields);
  return rows.map(r => Object.fromEntries(names.map((name, i) => [name, r[i]])));
}

export function formatTable(rows, fields, { cellMaxLength = 80 } = {}) {
  if (!rows.length) return '(no rows)';
  const cols = fields.map(f => f.name);
  const cells = rows.map(r => cols.map((_, i) => renderCell(r[i], cellMaxLength)));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map(row => row[i].length)));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const line = values => '| ' + values.map((v, i) => pad(v, widths[i])).join(' | ') + ' |';
  const header = line(cols);
  const sep = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  return [header, sep, ...cells.map(line)].join('\n');
}

export function formatJson(rows, meta) {
  return JSON.stringify({ rows, ...meta }, jsonReplacer, 2);
}

export function summaryLine({ rowCount, elapsedMs, target, truncated, limitReached, autoLimit, finalSql }) {
  const parts = [`-- ${rowCount} rows in ${elapsedMs}ms from target=${target}`];
  if (truncated) parts.push('(truncated)');
  if (limitReached) parts.push(`(limit ${autoLimit} reached; more rows may exist)`);
  if (finalSql) parts.push(`sql=${finalSql.replace(/\s+/g, ' ').slice(0, 200)}`);
  return parts.join(' ');
}

function jsonReplacer(key, value) {
  const raw = this[key];
  if (raw instanceof Date) return raw.toISOString();
  if (Buffer.isBuffer(raw)) return `\\x${raw.toString('hex')}`;
  return value;
}

export function formatJsonDocument(doc) {
  return JSON.stringify(doc, jsonReplacer, 2);
}

export function formatSqlError(err) {
  const lines = [`ERROR: ${err.message}${err.code ? ` (SQLSTATE ${err.code})` : ''}`];
  if (err.detail) lines.push(`DETAIL: ${err.detail}`);
  if (err.hint) lines.push(`HINT: ${err.hint}`);
  return lines.join('\n');
}

export function batchHeader(index, total) {
  return `# Query ${index} of ${total}`;
}

export function stoppedLine(index, total) {
  if (index >= total) return null;
  const rest = index + 1 === total ? `query ${total} was not run` : `queries ${index + 1}–${total} were not run`;
  return `-- stopped at query ${index} of ${total}; ${rest}`;
}

export function batchFooter({ total, target, via, connectMs, shared }) {
  const parts = [`-- ${total} queries on one connection; target=${target}`];
  if (via) parts.push(`via bastion ${via}`);
  let connected = `connected in ${connectMs}ms`;
  if (shared === 'reused') connected += ' (shared SSH connection reused)';
  else if (shared === 'opened') connected += ' (shared SSH connection opened)';
  parts.push(connected);
  return parts.join('; ');
}
