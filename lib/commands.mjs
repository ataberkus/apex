/** Local verbs are inspected before resolving Pi. Never evaluate task text. */
export function parseLocalCommand(args){
 if(!['report','resume'].includes(args[0]))return null;
 const [kind,file,...options]=args;
 if(typeof file!=='string'||!file||file.startsWith('--')||file.includes('\0'))throw Error(kind+' requires a session file');
 const allowed=kind==='report'?'--json':'--apex-dry-run';
 if(options.length>1||(options.length&&options[0]!==allowed))throw Error('Unsupported '+kind+' option; use '+allowed);
 return kind==='report'?{kind,file,json:options.length===1}:{kind,file,dryRun:options.length===1};
}
export function formatSessionReport(report){
 const s=report.summary;const n=value=>value===null?'unknown':String(value);
 return ['Apex session report',`Session: ${report.header.id}; entries: ${report.entryCount}`,
 `Tokens: input ${n(s.totals.input)}, cache read ${n(s.totals.cacheRead)}, cache write ${n(s.totals.cacheWrite)}, output ${n(s.totals.output)}, thinking ${n(s.totals.thinking)} (subset of output).`,
 `Cost: ${s.cost.nativeEstimateUsd===null?'unknown':'$'+s.cost.nativeEstimateUsd.toFixed(6)} (${s.cost.label}).`,
 `Category estimates: ${JSON.stringify(s.categories)}.`,
 `Top consumers: ${JSON.stringify(s.topConsumers)}.`,
 `Completeness: ${JSON.stringify(s.completeness)}.`,
 `Resume: ${report.pendingTools.length} pending tool calls; replay is never performed by inspection.`,
 ...(report.tornTail?['Warning: incomplete final JSONL record.']:[])].join('\n');
}
