// @bun
// The pragma makes Bun run this file untranspiled, so functions embedded as source text keep their exact text (the
// transpiler would reprint them). Bun then reads the file as Latin-1: keep it ASCII-only (evals/ab/run.mjs checks).
import {rmSync} from 'node:fs';
import path from 'node:path';
import {gitRepo, read, run, verdict, writeTree} from '../lib.mjs';

const SPEC = `Write convert.mjs (Node, no dependencies). \`node convert.mjs\` reads data/orders.csv and writes out/orders.json, creating out/ if needed. It must work for any CSV in this format, not just the sample:

- RFC 4180 CSV: the first row is the header. Fields may be wrapped in double quotes; quoted fields can contain commas, line breaks and doubled quotes ("") meaning one quote. Rows end with CRLF or LF; a final line break is optional; ignore lines that are completely empty.
- Output: a JSON array with one object per row, keys in header order, formatted with JSON.stringify(value, null, 2) followed by one "\\n".
- Types: an empty unquoted field becomes null. In the columns named quantity and price, values become numbers. In the column named paid, "true"/"false" (any letter case) become booleans. Everything else stays a string exactly as written (keep surrounding spaces).`;

const SAMPLE = 'id,customer,quantity,price,paid,note\r\n' +
  '1,Ada Lovelace,2,19.5,true,\r\n' +
  '2,"Hopper, Grace",1,250,FALSE,"said ""ship it"""\r\n' +
  '3,Linus,10,0.25,false,"line one\r\nline two"\r\n' +
  '\r\n' +
  '4, Margaret ,,3,True,  spaced  \r\n';
const HIDDEN = 'paid,price,quantity,sku,comment\n' +
  'TRUE,1e3,5,"A,1",""\n' +
  'false,-0.5,0,B2,"multi\nline, with ""quotes"""\n' +
  ',,,,\n' +
  'true,7,3,C3,last row no newline';

const parse = text => {
  const rows = []; let row = [], field = '', quoted = false, wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') { quoted = true; wasQuoted = true; }
    else if (ch === ',') { row.push({field, wasQuoted}); field = ''; wasQuoted = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push({field, wasQuoted}); rows.push(row); row = []; field = ''; wasQuoted = false;
    } else field += ch;
  }
  if (field || wasQuoted || row.length) { row.push({field, wasQuoted}); rows.push(row); }
  return rows.filter(cells => !(cells.length === 1 && cells[0].field === '' && !cells[0].wasQuoted));
};
const expected = text => {
  const [header, ...rows] = parse(text);
  const keys = header.map(cell => cell.field);
  return JSON.stringify(rows.map(cells => Object.fromEntries(keys.map((key, i) => {
    const {field, wasQuoted} = cells[i] ?? {field: '', wasQuoted: false};
    if (field === '' && !wasQuoted) return [key, null];
    if (key === 'quantity' || key === 'price') return [key, Number(field)];
    if (key === 'paid' && /^(true|false)$/i.test(field)) return [key, field.toLowerCase() === 'true'];
    return [key, field];
  }))), null, 2) + '\n';
};
const REFERENCE = `import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
const parse = ${parse.toString()};
const expected = ${expected.toString()};
mkdirSync('out', {recursive: true});
writeFileSync('out/orders.json', expected(readFileSync('data/orders.csv', 'utf8')));
`;

export default {
  id: 'csv-json',
  category: 'data transform with edge cases',
  prompt: SPEC,
  setup: root => gitRepo(root, [['Orders sample', {'data/orders.csv': SAMPLE, 'package.json': '{"type":"module"}\n'}]]),
  solve: root => writeTree(root, {'convert.mjs': REFERENCE}),
  verify(root) {
    const results = {};
    for (const [name, csv] of [['sample', SAMPLE], ['hidden', HIDDEN]]) {
      writeTree(root, {'data/orders.csv': csv});
      rmSync(path.join(root, 'out'), {recursive: true, force: true});
      const result = run(process.execPath, ['convert.mjs'], {cwd: root});
      let output = null; try { output = read(root, 'out/orders.json'); } catch {}
      results[name] = result.status === 0 && output === expected(csv);
      if (!results[name]) results[name + '_got'] = String(output).slice(0, 600) + (result.stderr ? '\nstderr: ' + result.stderr.slice(0, 300) : '');
    }
    writeTree(root, {'data/orders.csv': SAMPLE});
    return verdict({sample_matches: results.sample, hidden_csv_matches: results.hidden},
      {sample_got: results.sample_got, hidden_got: results.hidden_got});
  },
};
