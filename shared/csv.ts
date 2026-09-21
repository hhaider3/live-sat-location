/** Parse CelesTrak's compact OMM CSV, including quoted names and CRLFs.
 * Reject malformed/truncated rows instead of caching a partial download.
 */
export function parseOmmCsv(input: string): Record<string, string>[] {
  const text = input.replace(/^\uFEFF/, '');
  if (!text.endsWith('\n')) throw new Error('Incomplete OMM CSV');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else field += ch;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[++i] !== '\n') throw new Error('Invalid CSV line ending');
      row.push(field); field = ''; closedQuote = false;
      if (ch !== ',') { rows.push(row); row = []; }
    } else if (ch === '"' && !field && !closedQuote) {
      quoted = true;
    } else {
      if (closedQuote || ch === '"') throw new Error('Invalid CSV quoting');
      field += ch;
    }
  }
  if (quoted || row.length || field) throw new Error('Incomplete OMM CSV');
  const headers = rows.shift();
  const required = ['NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
    'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY'];
  if (!headers || new Set(headers).size !== headers.length || !required.every(key => headers.includes(key))) {
    throw new Error('Invalid OMM CSV header');
  }
  return rows.map(values => {
    if (values.length !== headers.length) throw new Error('Incomplete OMM CSV row');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}
