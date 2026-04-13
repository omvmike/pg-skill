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
  return JSON.stringify({ rows, ...meta }, (_k, v) => {
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`;
    return v;
  }, 2);
}

export function summaryLine({ rowCount, elapsedMs, target, truncated, finalSql }) {
  const parts = [`-- ${rowCount} rows in ${elapsedMs}ms from target=${target}`];
  if (truncated) parts.push('(truncated)');
  if (finalSql) parts.push(`sql=${finalSql.replace(/\s+/g, ' ').slice(0, 200)}`);
  return parts.join(' ');
}
