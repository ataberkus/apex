import {realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {truncateHead} from '@earendil-works/pi-coding-agent';
import {confinedPath} from '../apex-core/control.mjs';

const textResult = (text, details) => ({content: [{type: 'text', text}], structuredContent: {text}, details});
const clip = (value, chars) => value.length > chars ? `${value.slice(0, chars)}…` : value;
const string = (value, name, chars) => {
  if (value !== undefined && (typeof value !== 'string' || value.length > chars)) throw new Error(`${name} must be a string of at most ${chars} characters`);
};

/** Structural search over files under cwd (port of omp tools/ast-grep.ts), via the pinned native ast-grep binding. */
export function createAstGrepTool({cwd}) {
  return {
    name: 'ast_grep', label: 'ast_grep',
    description: 'Structural code search with an ast-grep pattern (e.g. `console.log($$$ARGS)`, `function $NAME($$$) { $$$ }`). Language is inferred per file unless lang is set. Returns file, line:col and first matched line; page with skip.',
    parameters: {type: 'object', properties: {
      pattern: {type: 'string', description: 'ast-grep pattern'},
      path: {type: 'string', description: 'File or directory under cwd (default: .)'},
      lang: {type: 'string', description: 'Language override, e.g. ts, js, py, rust'},
      glob: {type: 'string', description: 'Glob filter relative to path'},
      limit: {type: 'number', description: 'Max matches, 1-200 (default 50)'},
      skip: {type: 'number', description: 'Matches to skip (paging)'},
    }, required: ['pattern'], additionalProperties: false},
    outputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
    annotations: {readOnlyHint: true},
    async execute(_id, input, signal, _update, ctx) {
      const {pattern, lang, glob} = input ?? {};
      if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 2000) throw new Error('pattern must be a nonempty string of at most 2000 characters');
      string(input.path, 'path', 4096);
      string(lang, 'lang', 40);
      string(glob, 'glob', 500);
      const limit = input.limit ?? 50, skip = input.skip ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200');
      if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('skip must be a non-negative integer');
      if (signal?.aborted) throw new Error('Operation aborted');
      const root = ctx?.cwd || cwd;
      const target = await confinedPath(root, input.path ?? '.', {readOnly: true});
      const shownRoot = await realpath(root).catch(() => path.resolve(root));
      let base;
      try { base = (await stat(target)).isDirectory() ? target : path.dirname(target); }
      catch { throw new Error(`Path not found: ${input.path ?? '.'}`); }
      // Lazy: registering the tool must not load the native addon.
      const {astGrep} = await import('@oh-my-pi/pi-natives');
      let result;
      try {
        result = await astGrep({patterns: [pattern.trim()], path: target, lang: lang || undefined, glob: glob || undefined, limit, offset: skip, timeoutMs: 15000});
      } catch (error) {
        throw new Error(`ast_grep failed: ${clip(error instanceof Error ? error.message : String(error), 500)}`);
      }
      if (signal?.aborted) throw new Error('Operation aborted');
      const groups = new Map();
      for (const match of result.matches) {
        const file = path.relative(shownRoot, path.resolve(base, match.path)).replaceAll('\\', '/') || path.basename(match.path);
        if (!groups.has(file)) groups.set(file, []);
        groups.get(file).push(`  ${match.startLine}:${match.startColumn}: ${clip(match.text.split('\n')[0], 300)}`);
      }
      const body = [...groups].map(([file, rows]) => `${file}:\n${rows.join('\n')}`).join('\n');
      const bounded = truncateHead(body, {maxLines: 80, maxBytes: 8192});
      const parseErrors = result.parseErrors ?? [], missing = result.missingGrammars ?? [];
      const notes = [`[${result.totalMatches} matches in ${result.filesWithMatches} of ${result.filesSearched} files searched${result.limitReached ? `; next page skip=${skip + result.matches.length}` : ''}]`];
      if (bounded.truncated) notes.push('[Output truncated; narrow path/glob or lower limit.]');
      if (parseErrors.length) notes.push(`[Parse issues (${parseErrors.length}); results may be incomplete:\n${parseErrors.slice(0, 5).map(error => `  ${clip(error, 200)}`).join('\n')}]`);
      if (missing.length) notes.push(`[Grammars unavailable, files skipped: ${clip(missing.join(', '), 200)}]`);
      const text = `${bounded.content || 'No matches found'}\n${notes.join('\n')}`;
      return textResult(text, {apexAst: {matches: result.matches.length, totalMatches: result.totalMatches, filesWithMatches: result.filesWithMatches,
        filesSearched: result.filesSearched, limitReached: result.limitReached, skip, limit, truncated: bounded.truncated,
        parseErrors: parseErrors.length, missingGrammars: missing.slice(0, 20)}});
    },
  };
}
