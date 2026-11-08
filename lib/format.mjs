function renderCell(value, max) {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  let s;
  if (typeof value === 'object') {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  } else {
    s = String(value);
  }
  s = s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  if (max && s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

export function formatTable(rows, fields, { cellMaxLength = 80 } = {}) {
  if (!rows.length) return '(no rows)';
  const cols = fields && fields.length ? fields.map(f => f.name) : Object.keys(rows[0]);
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => renderCell(r[c], cellMaxLength).length)));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const header = '| ' + cols.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
  const sep    = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  const body   = rows.map(r =>
    '| ' + cols.map((c, i) => pad(renderCell(r[c], cellMaxLength), widths[i])).join(' | ') + ' |'
  ).join('\n');
  return `${header}\n${sep}\n${body}`;
}

export function formatJson(rows, meta) {
  return JSON.stringify({ rows, ...meta }, jsonReplacer, 2);
}

export function summaryLine({ rowCount, elapsedMs, target, truncated, finalSql }) {
  const parts = [`-- ${rowCount} rows in ${elapsedMs}ms from target=${target}`];
  if (truncated) parts.push('(truncated)');
  if (finalSql) parts.push(`sql=${finalSql.replace(/\s+/g, ' ').slice(0, 200)}`);
  return parts.join(' ');
}

function jsonReplacer(key, value) {
  const raw = this[key];
  if (raw instanceof Date) return raw.toISOString();
  if (Buffer.isBuffer(raw)) return `\\x${raw.toString('hex')}`;
  return value;
}

export function formatJsonBatch(batch) {
  return JSON.stringify(batch, jsonReplacer, 2);
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
