// RFC 4180 records, including quoted newlines. No coercion of source identifiers.
export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const records = []; let record = []; let field = ''; let quoted = false; let closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      record.push(field); field = ''; closed = false;
      if (c !== ',') {
        if (record.some(v => v !== '')) records.push(record);
        record = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else if (c === '"' && !field && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('Malformed CSV quoting'); field += c; }
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field');
  if (field || record.length) { record.push(field); records.push(record); }
  const header = records.shift();
  if (!header?.length || new Set(header).size !== header.length) throw new Error('CSV requires unique column names');
  return { header, rows: records.map((values, i) => {
    if (values.length !== header.length) throw new Error(`CSV record ${i + 2}: expected ${header.length} fields; found ${values.length}`);
    return Object.fromEntries(header.map((key, j) => [key, values[j]]));
  }) };
}
