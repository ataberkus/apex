/** Local verbs are inspected before resolving Pi. Never evaluate task text. */
import {clean, renderDocument, span, table, truncateLine} from './cli-style.mjs';

export function parseLocalCommand(args){
 if(!['report','resume'].includes(args[0]))return null;
 const [kind,file,...options]=args;
 if(typeof file!=='string'||!file||file.startsWith('--')||file.includes('\0'))throw Error(kind+' requires a session file');
 const allowed=kind==='report'?'--json':'--apex-dry-run';
 if(options.length>1||(options.length&&options[0]!==allowed))throw Error('Unsupported '+kind+' option; use '+allowed);
 return kind==='report'?{kind,file,json:options.length===1}:{kind,file,dryRun:options.length===1};
}

const count = value => value === null || value === undefined ? 'unknown' : value.toLocaleString('en-US', {maximumFractionDigits: 2});
const CATEGORY_LABELS = {user: 'User', assistant: 'Assistant', thinking: 'Thinking', toolCalls: 'Tool calls', toolResults: 'Tool results',
  summaries: 'Summaries', system: 'System', custom: 'Custom', other: 'Other'};

/** Human session report: a framed, sectioned summary on a color TTY, plain sections otherwise. */
export function formatSessionReport(report, style) {
  const s = report.summary; const g = style.glyph;
  const label = text => span(text, 'muted');
  const value = amount => span(count(amount), amount === null ? 'warning' : undefined);
  const flag = (name, ok) => g ? [span(ok ? g.on : g.off, ok ? 'success' : 'error'), span(' ' + name)] : [span(`${name}: ${ok ? 'yes' : 'no'}`)];
  const bar = bytes => {
    const total = Object.keys(CATEGORY_LABELS).reduce((sum, key) => sum + s.categories[key].bytes, 0);
    return g && total > 0 && bytes > 0 ? [span(g.bar.repeat(Math.max(1, Math.round(bytes / total * 16))), 'accent')] : [];
  };
  const kv = rows => table(rows.map(([name, ...cells]) => [[label(name)], ...cells]));
  const cost = s.cost.nativeEstimateUsd === null ? span('unknown', 'warning') : span('$' + s.cost.nativeEstimateUsd.toFixed(6), 'accent', true);
  const pending = report.pendingTools.length;
  const sections = [
    {title: '', lines: kv([['Session', [span(clean(report.header.id), undefined, true)]], ['Entries', [value(report.entryCount)]]])},
    {title: 'Tokens', lines: kv([
      ['Input', [value(s.totals.input)]], ['Cache read', [value(s.totals.cacheRead)]], ['Cache write', [value(s.totals.cacheWrite)]],
      ['Output', [value(s.totals.output)]], ['Thinking', [value(s.totals.thinking), span(' (subset of output)', 'dim')]]])},
    {title: 'Cost', lines: kv([['Native estimate', [cost, span(` (${clean(s.cost.label)})`, 'dim')]]])},
    {title: 'Category estimates', note: `${clean(s.categories.estimateMethod)}; ${clean(s.categories.label)}`, lines: table([
      [[label('Category')], [label('Bytes')], [label('Est. tokens')], []],
      ...Object.entries(CATEGORY_LABELS).map(([key, name]) => {
        const {bytes, estimatedTokens} = s.categories[key];
        const tone = bytes === 0 ? 'dim' : undefined;
        return [[span(name, tone)], [span(count(bytes), tone)], [span(count(estimatedTokens), tone)], bar(bytes)];
      })], ['left', 'right', 'right'])},
    {title: 'Top consumers', lines: s.topConsumers.length ? table([
      [[label('Entry')], [label('Type')], [label('Bytes')], [label('Est. tokens')]],
      ...s.topConsumers.map(item => {
        const entry = [span(item.entryId === null ? 'unknown' : clean(item.entryId))];
        // Entry IDs may be up to 512 characters; the frame keeps the other columns visible.
        return [g ? truncateLine(style, entry, 24) : entry, [span(clean(item.type), 'muted')], [span(count(item.bytes))], [span(count(item.estimatedTokens))]];
      })], ['left', 'left', 'right', 'right']) : [[span('none', 'dim')]]},
    {title: 'Completeness', lines: [
      [...flag('usage', s.completeness.usage), span('   '), ...flag('cost', s.completeness.cost), span('   '), ...flag('thinking', s.completeness.thinking)],
      ...kv([['Issues', s.completeness.issues.length ? [span(s.completeness.issues.map(clean).join(', '), 'warning')] : [span('none', 'dim')]]])]},
    {title: 'Resume', lines: [
      [span(`${pending} pending tool call${pending === 1 ? '' : 's'}`, pending ? 'warning' : 'success'),
        span('; replay is never performed by inspection.', 'muted')],
      ...(report.tornTail ? [[span(`${g ? g.warn + ' ' : ''}Warning: incomplete final JSONL record.`, 'warning', true)]] : [])]},
  ];
  return renderDocument(style, {title: 'Apex session report', sections});
}
