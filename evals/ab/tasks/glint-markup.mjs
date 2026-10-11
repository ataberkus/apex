import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw (no backticks or dollar-brace inside). md() turns \` into a backtick.
const md = text => text.replaceAll('\\`', '`');

/** Replace each anchor, which must occur exactly once, so a drifting anchor fails loudly at import time. */
function patch(text, pairs) {
  for (const [from, to] of pairs) {
    if (text.split(from).length !== 2) throw Error('glint-markup: patch anchor not unique: ' + from);
    text = text.replace(from, () => to);
  }
  return text;
}

const SPEC = md(String.raw`# Glint markup

Glint is a small markup language. This document is the complete specification of \`render(source)\` in \`src/index.js\`, which converts a Glint document (a string) to HTML (a string). Every string is a valid document: \`render\` never throws for a string.

In this document a *space* is only U+0020. Other whitespace characters, such as the no-break space U+00A0, are ordinary characters. LF is U+000A.

## 1. Lines

The source is split into lines at every LF, every CR LF pair and every CR that is not followed by LF. A source that ends with a line break therefore ends with an empty line.

Then, in every line, each tab is replaced by one to four spaces, up to the next column that is a multiple of 4. Columns are counted from 0 at the start of the line, one per code point (after earlier tabs of the line have been replaced). So \`a\tb\` becomes \`a\` and three spaces and \`b\`, and a tab at the start of a line becomes four spaces. This happens before anything else, so it also applies inside code blocks.

A *blank* line is empty or contains only spaces.

## 2. Blocks

A *line sequence* is parsed into a list of blocks. The whole document is a line sequence; so are the contents of quotes (2.4) and list items (2.5), which are parsed the same way, recursively.

The lines are processed from the first one. Blank lines between blocks are skipped. A non-blank line starts a block according to the first of these rules that matches it:

1. **Code fence**: \`~~~\`, then optional spaces, then an optional language (one or more of the characters \`A-Z\`, \`a-z\`, \`0-9\`, \`_\`, \`+\`, \`-\`), then optional spaces, and nothing else.
2. **Heading**: one to four \`=\`, followed by a space or by the end of the line.
3. **Rule**: three or more \`-\`, followed only by optional spaces.
4. **Quote**: the line starts with \`>\`.
5. **List item**: a *bullet item* starts with \`-\` followed by a space or by the end of the line; a *numbered item* starts with one to nine digits \`0-9\`, then \`.\`, followed by a space or by the end of the line.
6. **Paragraph**: any other non-blank line.

Every rule looks at the very first character of the line. A line that starts with a space never starts a code fence, heading, rule, quote or list item; it always starts or continues a paragraph.

### 2.1 Code blocks

The fence line is followed by the code lines, up to a closing line that consists of \`~~~\` followed only by optional spaces. Neither the fence line nor the closing line is code. If no closing line follows, the code block runs to the end of the line sequence. Code lines are taken exactly as they are, including blank lines and leading spaces.

Output: \`<pre><code class="language-LANG">CODE</code></pre>\`, without the \`class\` attribute when the fence has no language. CODE is the code lines joined with LF and escaped (section 4); there is no LF after the last line.

### 2.2 Headings

The level is the number of \`=\`. The content is the rest of the line after the \`=\` run, without its leading and trailing spaces; it may be empty. Output: \`<hN id="ID">INLINE</hN>\`, where N is the level, INLINE is the content rendered as inline text (section 3), and ID is described in section 5.

### 2.3 Rules

Output: \`<hr>\`.

### 2.4 Quotes

A quote is a maximal run of consecutive lines that start with \`>\`. A blank line, or any line that does not start with \`>\`, ends it: there is no lazy continuation. From each line of the run, the \`>\` is removed, and then one space if the line continues with a space. The resulting lines are a line sequence and are parsed into the quote's blocks, so quotes can contain any block, including quotes (\`>> x\`).

Output: \`<blockquote>\`, LF, the quote's blocks, LF, \`</blockquote>\`. A quote without blocks is \`<blockquote>\`, LF, \`</blockquote>\`.

### 2.5 Lists

The *marker width* W of an item is 2 for a bullet item and the number of digits plus 2 for a numbered item. The item's content is a line sequence:

- its first line is the item's line without the first W characters (empty if the line is shorter);
- it continues with every following line that is blank or starts with at least W spaces, with the first W characters removed (a blank line becomes an empty line);
- it ends before the first following line that is neither. Blank lines at the end of the content are not part of it.

The content is parsed into the item's blocks.

A list is a run of items of the same kind (bullet or numbered) that follow each other directly or are separated only by blank lines. An item of the other kind ends the list and starts a new one. A bullet list is \`<ul>\`; a numbered list is \`<ol>\`, or \`<ol start="N">\` when the number of its first item is not 1, N being that number in decimal without leading zeros. The numbers of the other items do not matter.

Output: the opening tag, LF, the items joined with LF, LF, the closing tag. An item whose blocks are exactly one paragraph is \`<li>INLINE</li>\` (INLINE being the paragraph's text rendered as inline text, without \`<p>\`); an item without blocks is \`<li></li>\`; any other item is \`<li>\`, LF, its blocks, LF, \`</li>\`.

### 2.6 Paragraphs

A paragraph is its first line and the following lines up to (not including) the first blank line, the first line that matches one of rules 1 to 5 (so a heading, rule, quote, list item of either kind or code fence interrupts a paragraph), or the end of the line sequence. Leading and trailing spaces are removed from every line, and the lines are joined with LF; this is the paragraph's text.

Output: \`<p>INLINE</p>\`.

### 2.7 Output

The blocks of a line sequence are joined with LF. The HTML of the document is its blocks joined with LF, followed by one LF. A document without blocks is the empty string.

## 3. Inline text

Paragraph texts and heading contents are inline text. Inline text is read from left to right; at each position, the first matching rule applies:

1. **Backslash.** A backslash followed by an ASCII punctuation character (one of \`!"#$%&'()*+,-./:;<=>?@[\]^_{|}~\` and the backtick) is that character as literal text; it never has any of the meanings below. A backslash followed by LF is a hard line break: the output is \`<br>\` followed by the LF. Any other backslash, including one at the end of the text, is literal text.
2. **Code span.** A backtick starts a code span that ends at the next backtick. The text between the two backticks, with every LF replaced by a space and then escaped, is output as \`<code>TEXT</code>\`. Nothing inside a code span has any special meaning (there are no backslash escapes). If there is no later backtick, or the next backtick comes immediately after this one (empty code), this backtick is literal text and reading continues with the next character.
3. **Link.** A \`[\` starts a link when all of the following hold. The *link text* runs up to the first \`]\` that is not escaped; while looking for it, a backslash and the character after it are skipped together. The link text contains no \`[\` that is not escaped this way. Directly after the \`]\` comes \`(\`, then the *target*: one or more characters other than space, LF, \`(\` and \`)\`, then \`)\`. Otherwise the \`[\` is literal text and reading continues with the next character. The search for the \`]\` comes first, so a \`]\` inside backticks still ends the link text.
   - The link text is rendered as inline text on its own, as if it were a complete text: its delimiters (rule 4) never pair with delimiters outside it.
   - The target is taken literally (backslashes are not escapes). It has a *scheme* if it matches \`[A-Za-z][A-Za-z0-9+.-]*:\` at its start; the scheme is the part before that \`:\`. If the target has no scheme, or its scheme is \`http\`, \`https\` or \`mailto\` in any combination of upper and lower case, the output is \`<a href="TARGET">TEXT</a>\` with the target escaped. Any other scheme (\`javascript:\`, \`data:\`, \`c:\`, ...) outputs only TEXT, without an \`<a>\` element.
4. **Delimiters.** \`*\` is strong (\`<strong>\`), \`_\` is emphasis (\`<em>\`) and \`~\` is deletion (\`<del>\`). For a delimiter character, *prev* is the character just before it in the text and *next* the character just after it, as written in the source text, even when those characters are part of a backslash escape or a code span. A *word character* is a Unicode letter or number (\`\p{L}\` or \`\p{N}\`); *whitespace* is a space or LF.
   - The delimiter *can open* if next exists and is not whitespace, and prev does not exist or is not a word character.
   - It *can close* if prev exists and is not whitespace, and next does not exist or is not a word character.
   - If it can close, and there is an unclosed opener of the same character, and the most recent such opener is not immediately before it (at least one character lies between them), it closes that opener: everything output between the two becomes the content of the element. Unclosed openers between the two, of any character, become literal text and can no longer be closed.
   - Otherwise, if it can open, it becomes an unclosed opener. Otherwise it is literal text.
   - Openers that are still unclosed at the end of the text are literal text.
5. Any other character is literal text.

Literal text is escaped (section 4).

## 4. Escaping

In literal text, code spans, code blocks and link targets, \`&\` is output as \`&amp;\`, \`<\` as \`&lt;\`, \`>\` as \`&gt;\` and \`"\` as \`&quot;\`. Nothing else is changed.

## 5. Heading ids

The *plain text* of a heading is what its inline content displays, before escaping: literal text, the text of code spans (after the LF replacement), and the plain text of link texts and of strong, emphasis and deletion contents. Hard line breaks contribute nothing.

The *slug* of a heading is its plain text converted with JavaScript's \`toLowerCase()\`, in which every maximal run of characters other than \`a-z\` and \`0-9\` is replaced by a single \`-\`, and then a \`-\` at the start and a \`-\` at the end are removed. Characters such as \`é\` are not kept. An empty slug is \`section\`.

Ids are unique in the document. Headings get their ids in document order (the order of their lines in the source, headings inside quotes and list items included). A heading's id is its slug if no earlier heading has that id; otherwise it is the slug followed by \`-2\`, or by \`-3\` if that is taken too, and so on: the first one that no earlier heading has as its id. For example, headings \`A\`, \`A\` and \`A-2\` get the ids \`a\`, \`a-2\` and \`a-2-2\`.
`);

const ESCAPE_JS = String.raw`const ENTITIES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'};

/** docs/GLINT.md section 4. */
export const escapeHtml = text => text.replace(/[&<>"]/g, c => ENTITIES[c]);
`;

const LINES_JS = String.raw`/** Lines of a source with tabs expanded (docs/GLINT.md section 1). */
export function splitLines(source) {
  return source.split(/\r\n|\r|\n/).map(line => {
    let out = '';
    let column = 0;
    for (const c of line) {
      if (c === '\t') {
        const n = 4 - column % 4;
        out += ' '.repeat(n);
        column += n;
      } else {
        out += c;
        column++;
      }
    }
    return out;
  });
}
`;

const BLOCKS_JS = String.raw`const FENCE = /^~~~ *([A-Za-z0-9_+-]*) *$/;
const CLOSING = /^~~~ *$/;
const HEADING = /^(={1,4})(?: (.*))?$/;
const RULE = /^-{3,} *$/;
const BLANK = /^ *$/;
const trim = line => line.replace(/^ +| +$/g, '');

function itemMarker(line) {
  if (/^-( |$)/.test(line)) return {kind: 'ul', width: 2};
  const m = /^([0-9]{1,9})\.( |$)/.exec(line);
  return m ? {kind: 'ol', width: m[1].length + 2, number: Number(m[1])} : null;
}

const startsBlock = line => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || line.startsWith('>') || itemMarker(line) !== null;

/**
 * Parse a line sequence into blocks (docs/GLINT.md section 2): {type: 'paragraph' | 'heading', text, level},
 * {type: 'code', language, text}, {type: 'rule'}, {type: 'quote', blocks}, {type: 'list', kind, start, items: [blocks]}.
 */
export function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (BLANK.test(line)) {
      i++;
    } else if ((m = FENCE.exec(line))) {
      const code = [];
      i++;
      while (i < lines.length && !CLOSING.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({type: 'code', language: m[1], text: code.join('\n')});
    } else if ((m = HEADING.exec(line))) {
      blocks.push({type: 'heading', level: m[1].length, text: trim(m[2] ?? '')});
      i++;
    } else if (RULE.test(line)) {
      blocks.push({type: 'rule'});
      i++;
    } else if (line.startsWith('>')) {
      const inner = [];
      while (i < lines.length && lines[i].startsWith('>')) inner.push(lines[i++].replace(/^> ?/, ''));
      blocks.push({type: 'quote', blocks: parseBlocks(inner)});
    } else if (itemMarker(line)) {
      const first = itemMarker(line);
      const list = {type: 'list', kind: first.kind, start: first.number, items: []};
      for (;;) {
        const marker = itemMarker(lines[i]);
        const indent = ' '.repeat(marker.width);
        const content = [lines[i].slice(marker.width)];
        let end = ++i;
        for (let j = i; j < lines.length && (BLANK.test(lines[j]) || lines[j].startsWith(indent)); j++) {
          if (!BLANK.test(lines[j])) end = j + 1;
        }
        for (; i < end; i++) content.push(BLANK.test(lines[i]) ? '' : lines[i].slice(marker.width));
        list.items.push(parseBlocks(content));
        let next = i;
        while (next < lines.length && BLANK.test(lines[next])) next++;
        if (next === lines.length || itemMarker(lines[next])?.kind !== list.kind) break;
        i = next;
      }
      blocks.push(list);
    } else {
      const text = [trim(line)];
      i++;
      while (i < lines.length && !BLANK.test(lines[i]) && !startsBlock(lines[i])) text.push(trim(lines[i++]));
      blocks.push({type: 'paragraph', text: text.join('\n')});
    }
  }
  return blocks;
}
`;

const INLINE_JS = String.raw`const BACKTICK = '\x60';
const PUNCTUATION = /^[!-\/:-@\[-\x60{-~]$/;
const WORD = /^[\p{L}\p{N}]$/u;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const SAFE_SCHEMES = ['http', 'https', 'mailto'];
const TAGS = {'*': 'strong', _: 'em', '~': 'del'};

const isSpace = c => c === ' ' || c === '\n';
const isWord = c => c !== undefined && WORD.test(c);

function readLink(chars, start) {
  let k = start + 1;
  for (;;) {
    if (k >= chars.length || chars[k] === '[') return null;
    if (chars[k] === ']') break;
    k += chars[k] === '\\' && k + 1 < chars.length ? 2 : 1;
  }
  if (chars[k + 1] !== '(') return null;
  let m = k + 2;
  while (m < chars.length && !' \n()'.includes(chars[m])) m++;
  if (m === k + 2 || chars[m] !== ')') return null;
  const target = chars.slice(k + 2, m).join('');
  const scheme = SCHEME.exec(target);
  const allowed = !scheme || SAFE_SCHEMES.includes(scheme[1].toLowerCase());
  return {node: {type: 'link', href: allowed ? target : null, children: parseInline(chars.slice(start + 1, k).join(''))}, end: m + 1};
}

/**
 * Inline text of docs/GLINT.md section 3 as a list of nodes: strings (literal text), {type: 'br'},
 * {type: 'code', text}, {type: 'link', href, children} (href null when the scheme is not allowed),
 * {type: 'strong' | 'em' | 'del', children}.
 */
export function parseInline(text) {
  const chars = Array.from(text);
  const nodes = [];
  const openers = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\\') {
      const next = chars[i + 1];
      if (next !== undefined && PUNCTUATION.test(next)) {
        nodes.push(next);
        i += 2;
      } else {
        nodes.push(next === '\n' ? {type: 'br'} : c);
        i++;
      }
    } else if (c === BACKTICK) {
      const end = chars.indexOf(BACKTICK, i + 1);
      if (end > i + 1) {
        nodes.push({type: 'code', text: chars.slice(i + 1, end).join('').replaceAll('\n', ' ')});
        i = end + 1;
      } else {
        nodes.push(c);
        i++;
      }
    } else if (c === '[') {
      const link = readLink(chars, i);
      if (link) {
        nodes.push(link.node);
        i = link.end;
      } else {
        nodes.push(c);
        i++;
      }
    } else if (Object.hasOwn(TAGS, c)) {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      const canOpen = next !== undefined && !isSpace(next) && !isWord(prev);
      const canClose = prev !== undefined && !isSpace(prev) && !isWord(next);
      let s = openers.length - 1;
      while (s >= 0 && openers[s].char !== c) s--;
      if (canClose && s >= 0 && openers[s].index < nodes.length - 1) {
        const {index} = openers[s];
        for (const opener of openers.slice(s + 1)) nodes[opener.index] = opener.char;
        openers.length = s;
        nodes[index] = {type: TAGS[c], children: nodes.splice(index + 1)};
      } else if (canOpen) {
        openers.push({char: c, index: nodes.length});
        nodes.push({type: 'opener'});
      } else nodes.push(c);
      i++;
    } else {
      nodes.push(c);
      i++;
    }
  }
  for (const opener of openers) nodes[opener.index] = opener.char;
  return nodes;
}
`;

const SLUG_JS = String.raw`/** docs/GLINT.md section 5. */
export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}

/** The first of base, base-2, base-3, ... not in used; it is added to used. */
export function uniqueId(base, used) {
  let id = base;
  for (let n = 2; used.has(id); n++) id = base + '-' + n;
  used.add(id);
  return id;
}
`;

const RENDER_JS = String.raw`import {escapeHtml} from './escape.js';
import {parseInline} from './inline.js';
import {slugify, uniqueId} from './slug.js';

export function renderInline(nodes) {
  return nodes.map(node => {
    if (typeof node === 'string') return escapeHtml(node);
    if (node.type === 'br') return '<br>';
    if (node.type === 'code') return '<code>' + escapeHtml(node.text) + '</code>';
    if (node.type === 'link') {
      const text = renderInline(node.children);
      return node.href === null ? text : '<a href="' + escapeHtml(node.href) + '">' + text + '</a>';
    }
    return '<' + node.type + '>' + renderInline(node.children) + '</' + node.type + '>';
  }).join('');
}

export function plainText(nodes) {
  return nodes.map(node => typeof node === 'string' ? node : node.type === 'br' ? '' : node.type === 'code' ? node.text : plainText(node.children)).join('');
}

function renderItem(blocks, used) {
  if (blocks.length === 0) return '<li></li>';
  if (blocks.length === 1 && blocks[0].type === 'paragraph') return '<li>' + renderInline(parseInline(blocks[0].text)) + '</li>';
  return '<li>\n' + renderBlocks(blocks, used) + '\n</li>';
}

function renderBlock(block, used) {
  if (block.type === 'paragraph') return '<p>' + renderInline(parseInline(block.text)) + '</p>';
  if (block.type === 'heading') {
    const nodes = parseInline(block.text);
    const tag = 'h' + block.level;
    return '<' + tag + ' id="' + escapeHtml(uniqueId(slugify(plainText(nodes)), used)) + '">' + renderInline(nodes) + '</' + tag + '>';
  }
  if (block.type === 'rule') return '<hr>';
  if (block.type === 'code') {
    const attribute = block.language ? ' class="language-' + escapeHtml(block.language) + '"' : '';
    return '<pre><code' + attribute + '>' + escapeHtml(block.text) + '</code></pre>';
  }
  if (block.type === 'quote') return '<blockquote>\n' + (block.blocks.length ? renderBlocks(block.blocks, used) + '\n' : '') + '</blockquote>';
  const open = block.kind === 'ol' && block.start !== 1 ? '<ol start="' + block.start + '">' : '<' + block.kind + '>';
  return open + '\n' + block.items.map(item => renderItem(item, used)).join('\n') + '\n</' + block.kind + '>';
}

/** HTML of a block list (docs/GLINT.md sections 2 and 5); used holds the heading ids given so far. */
export function renderBlocks(blocks, used) {
  return blocks.map(block => renderBlock(block, used)).join('\n');
}
`;

const INDEX_JS = String.raw`import {parseBlocks} from './blocks.js';
import {splitLines} from './lines.js';
import {renderBlocks} from './render.js';

/** Convert a Glint document to HTML (docs/GLINT.md). */
export function render(source) {
  const blocks = parseBlocks(splitLines(source));
  return blocks.length ? renderBlocks(blocks, new Set()) + '\n' : '';
}
`;

// ---- The fixture: an early version that is incomplete and deviates from the spec in places. ----

const FIXTURE_LINES = String.raw`/** Lines of a source (docs/GLINT.md section 1). */
export function splitLines(source) {
  return source.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}
`;

const FIXTURE_BLOCKS = String.raw`const FENCE = /^~~~(.*)$/;
const HEADING = /^(={1,6}) (.*)$/;
const RULE = /^---+$/;
const BULLET = /^- (.*)$/;
const NUMBERED = /^[0-9]+\. (.*)$/;

const isBlank = line => line.trim() === '';
const interrupts = line => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || line.startsWith('>') || BULLET.test(line);

/**
 * Parse a line sequence into blocks (docs/GLINT.md section 2): {type: 'paragraph' | 'heading', text, level},
 * {type: 'code', language, text}, {type: 'rule'}, {type: 'quote', blocks}, {type: 'list', kind, start, items: [blocks]}.
 */
export function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (isBlank(line)) {
      i++;
    } else if ((m = FENCE.exec(line))) {
      const code = [];
      i++;
      while (i < lines.length && lines[i] !== '~~~') code.push(lines[i++]);
      i++;
      blocks.push({type: 'code', language: m[1].trim(), text: code.join('\n')});
    } else if ((m = HEADING.exec(line))) {
      blocks.push({type: 'heading', level: m[1].length, text: m[2].trim()});
      i++;
    } else if (RULE.test(line)) {
      blocks.push({type: 'rule'});
      i++;
    } else if (line.startsWith('>')) {
      const inner = [];
      while (i < lines.length && lines[i].startsWith('>')) inner.push(lines[i++].replace(/^>\s*/, ''));
      blocks.push({type: 'quote', blocks: parseBlocks(inner)});
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const kind = BULLET.test(line) ? 'ul' : 'ol';
      const pattern = kind === 'ul' ? BULLET : NUMBERED;
      const items = [];
      while (i < lines.length && pattern.test(lines[i])) {
        const text = [pattern.exec(lines[i])[1].trim()];
        i++;
        while (i < lines.length && lines[i].startsWith('  ') && !isBlank(lines[i])) text.push(lines[i++].trim());
        items.push([{type: 'paragraph', text: text.join('\n')}]);
      }
      blocks.push({type: 'list', kind, start: 1, items});
    } else {
      const text = [line.trim()];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !interrupts(lines[i])) text.push(lines[i++].trim());
      blocks.push({type: 'paragraph', text: text.join('\n')});
    }
  }
  return blocks;
}
`;

const FIXTURE_INLINE = String.raw`const BACKTICK = '\x60';
const ESCAPABLE = ['\\', '*', '_', '~', '[', ']', '(', ')', BACKTICK];
const LINK = /^\[([^\]]*)\]\(([^)\s]+)\)/;
const TAGS = {'*': 'strong', _: 'em', '~': 'del'};

/**
 * Inline text of docs/GLINT.md section 3 as a list of nodes: strings (literal text), {type: 'br'},
 * {type: 'code', text}, {type: 'link', href, children} (href null when the scheme is not allowed),
 * {type: 'strong' | 'em' | 'del', children}.
 */
export function parseInline(text) {
  const chars = Array.from(text);
  const nodes = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\\' && ESCAPABLE.includes(chars[i + 1])) {
      nodes.push(chars[i + 1]);
      i += 2;
      continue;
    }
    if (c === BACKTICK) {
      const end = chars.indexOf(BACKTICK, i + 1);
      if (end > i + 1) {
        nodes.push({type: 'code', text: chars.slice(i + 1, end).join('')});
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const m = LINK.exec(chars.slice(i).join(''));
      if (m) {
        nodes.push({type: 'link', href: m[2], children: parseInline(m[1])});
        i += Array.from(m[0]).length;
        continue;
      }
    }
    if (Object.hasOwn(TAGS, c)) {
      const end = chars.indexOf(c, i + 1);
      if (end > i + 1 && chars[i + 1] !== ' ' && chars[end - 1] !== ' ') {
        nodes.push({type: TAGS[c], children: parseInline(chars.slice(i + 1, end).join(''))});
        i = end + 1;
        continue;
      }
    }
    nodes.push(c);
    i++;
  }
  return nodes;
}
`;

const FIXTURE_SLUG = String.raw`/** docs/GLINT.md section 5. */
export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function uniqueId(base) {
  return base;
}
`;

const VISIBLE = `import test from 'node:test';
import assert from 'node:assert/strict';
import {render} from '../src/index.js';

test('headings and paragraphs', () => {
  assert.equal(render('= Hello World\\n\\nSome *bold* and _em_ text.\\nSecond line.\\n'),
    '<h1 id="hello-world">Hello World</h1>\\n<p>Some <strong>bold</strong> and <em>em</em> text.\\nSecond line.</p>\\n');
});

test('lists', () => {
  assert.equal(render('- one\\n- two\\n\\n1. first\\n2. second'),
    '<ul>\\n<li>one</li>\\n<li>two</li>\\n</ul>\\n<ol>\\n<li>first</li>\\n<li>second</li>\\n</ol>\\n');
});

test('code blocks', () => {
  assert.equal(render('~~~\\nlet a = 1 < 2;\\n~~~\\ntext'), '<pre><code>let a = 1 &lt; 2;</code></pre>\\n<p>text</p>\\n');
});

test('quotes', () => {
  assert.equal(render('> quoted *text*\\n> more'), '<blockquote>\\n<p>quoted <strong>text</strong>\\nmore</p>\\n</blockquote>\\n');
});

test('code spans, links and escaping', () => {
  assert.equal(render('Use \\x60a<b>\\x60 or [docs](https://x.test/?a=1&b=2) & \\\\*not bold\\\\*'),
    '<p>Use <code>a&lt;b&gt;</code> or <a href="https://x.test/?a=1&amp;b=2">docs</a> &amp; *not bold*</p>\\n');
});

test('rules and empty documents', () => {
  assert.equal(render('---'), '<hr>\\n');
  assert.equal(render(''), '');
});
`;

const files = {
  'package.json': JSON.stringify({name: 'glint', version: '0.2.0', private: true, type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'README.md': '# glint\n\nA small markup language that renders to HTML. The language is specified in docs/GLINT.md.\n\n```js\nimport {render} from \'./src/index.js\';\nrender(\'= Title\\n\\nSome *bold* text.\'); // \'<h1 id="title">Title</h1>\\n<p>Some <strong>bold</strong> text.</p>\\n\'\n```\n',
  'docs/GLINT.md': SPEC,
  'src/index.js': INDEX_JS,
  'src/escape.js': ESCAPE_JS,
  'src/lines.js': FIXTURE_LINES,
  'src/blocks.js': FIXTURE_BLOCKS,
  'src/inline.js': FIXTURE_INLINE,
  'src/slug.js': FIXTURE_SLUG,
  'src/render.js': RENDER_JS,
  'test/glint.test.js': VISIBLE,
};

const REFERENCE = {
  'src/index.js': INDEX_JS, 'src/escape.js': ESCAPE_JS, 'src/lines.js': LINES_JS, 'src/blocks.js': BLOCKS_JS,
  'src/inline.js': INLINE_JS, 'src/slug.js': SLUG_JS, 'src/render.js': RENDER_JS,
};

const ul = (...items) => '<ul>\n' + items.join('\n') + '\n</ul>';

// [name, source, expected HTML]
const CASES = [
  ['tabs expand to the next multiple of four', 'a\tb\n\tc\nab\t\tx', '<p>a   b\nc\nab      x</p>\n'],
  ['tabs inside code blocks', '~~~\n\tx\nab\tc\n~~~', '<pre><code>    x\nab  c</code></pre>\n'],
  ['tab after a list marker', '-\tx', ul('<li>x</li>') + '\n'],
  ['lone CR and CR LF', 'a\rb\r\n\r\nc', '<p>a\nb</p>\n<p>c</p>\n'],
  ['no-break space is not a space', '\u00a0\n- x\n\u00a0- y', '<p>\u00a0</p>\n' + ul('<li>x</li>') + '\n<p>\u00a0- y</p>\n'],
  ['block starts need column 0', 'para\n - not a list\n  > not a quote\n = not a heading\n ~~~', '<p>para\n- not a list\n&gt; not a quote\n= not a heading\n~~~</p>\n'],
  ['an indented line starts a paragraph', '  = x\n\n   1. y', '<p>= x</p>\n<p>1. y</p>\n'],
  ['heading levels', '= a\n== b\n=== c\n==== d\n===== e\n==f\n=',
    '<h1 id="a">a</h1>\n<h2 id="b">b</h2>\n<h3 id="c">c</h3>\n<h4 id="d">d</h4>\n<p>===== e\n==f</p>\n<h1 id="section"></h1>\n'],
  ['heading content is trimmed', '==   Title  with  spaces   ', '<h2 id="title-with-spaces">Title  with  spaces</h2>\n'],
  ['headings interrupt paragraphs', 'a\n= b\nc', '<p>a</p>\n<h1 id="b">b</h1>\n<p>c</p>\n'],
  ['rules', '---\n-----   \n--\n- - -',
    '<hr>\n<hr>\n<p>--</p>\n<ul>\n<li>\n<ul>\n<li>\n<ul>\n<li></li>\n</ul>\n</li>\n</ul>\n</li>\n</ul>\n'],
  ['a rule is only dashes', '---x\n--- -', '<p>---x\n--- -</p>\n'],
  ['fence language and spaces', '~~~  c++  \nint x;\n~~~   \nafter', '<pre><code class="language-c++">int x;</code></pre>\n<p>after</p>\n'],
  ['not a fence', '~~~ two words\nx', '<p>~~~ two words\nx</p>\n'],
  ['unterminated fence keeps blank lines', '~~~\na\n\n  b\n', '<pre><code>a\n\n  b\n</code></pre>\n'],
  ['closing fence must be exact', '~~~\nx\n ~~~\n~~~~\n~~~ js\n~~~', '<pre><code>x\n ~~~\n~~~~\n~~~ js</code></pre>\n'],
  ['fences interrupt paragraphs', 'text\n~~~\ncode', '<p>text</p>\n<pre><code>code</code></pre>\n'],
  ['code blocks are escaped', '~~~ html\n<a href="x">&amp;</a>\n~~~', '<pre><code class="language-html">&lt;a href=&quot;x&quot;&gt;&amp;amp;&lt;/a&gt;</code></pre>\n'],
  ['empty code block', '~~~\n~~~', '<pre><code></code></pre>\n'],
  ['quote prefixes', '>a\n>  b\n> > c\n>> d', '<blockquote>\n<p>a\nb</p>\n<blockquote>\n<p>c\nd</p>\n</blockquote>\n</blockquote>\n'],
  ['a quote removes one space', '> a\n>   - b\n> - c', '<blockquote>\n<p>a\n- b</p>\n' + ul('<li>c</li>') + '\n</blockquote>\n'],
  ['no lazy continuation', '> a\nb', '<blockquote>\n<p>a</p>\n</blockquote>\n<p>b</p>\n'],
  ['a blank line separates quotes', '> a\n\n> b', '<blockquote>\n<p>a</p>\n</blockquote>\n<blockquote>\n<p>b</p>\n</blockquote>\n'],
  ['empty quote', '>\n>  ', '<blockquote>\n</blockquote>\n'],
  ['quote with a list and code', '> - a\n>   b\n> ~~~\n> x', '<blockquote>\n' + ul('<li>a\nb</li>') + '\n<pre><code>x</code></pre>\n</blockquote>\n'],
  ['nested lists are blocks of the item', '- a\n  - b\n  - c\n- d', ul('<li>\n<p>a</p>\n' + ul('<li>b</li>', '<li>c</li>') + '\n</li>', '<li>d</li>') + '\n'],
  ['continuation and blank lines in items', '- a\n  more\n\n  second\n\n- b\n\nafter',
    ul('<li>\n<p>a\nmore</p>\n<p>second</p>\n</li>', '<li>b</li>') + '\n<p>after</p>\n'],
  ['too little indentation ends the item', '- a\n b', ul('<li>a</li>') + '\n<p>b</p>\n'],
  ['numbered marker width', '10. ten\n    cont\n   no', '<ol start="10">\n<li>ten\ncont</li>\n</ol>\n<p>no</p>\n'],
  ['start attribute without leading zeros', '007. a\n1. b', '<ol start="7">\n<li>a</li>\n<li>b</li>\n</ol>\n'],
  ['only the first number counts', '1. a\n5. b\n\n\n3. c', '<ol>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n</ol>\n'],
  ['start zero', '0. z', '<ol start="0">\n<li>z</li>\n</ol>\n'],
  ['a new kind starts a new list', '- a\n1. b\n\n- c', ul('<li>a</li>') + '\n<ol>\n<li>b</li>\n</ol>\n' + ul('<li>c</li>') + '\n'],
  ['numbered items interrupt paragraphs', 'In\n2024. A year', '<p>In</p>\n<ol start="2024">\n<li>A year</li>\n</ol>\n'],
  ['not numbered items', '1234567890. x\n1.x\n1) y', '<p>1234567890. x\n1.x\n1) y</p>\n'],
  ['empty items', '-\n- \n1.', ul('<li></li>', '<li></li>') + '\n<ol>\n<li></li>\n</ol>\n'],
  ['content starting on the next line', '-\n  a\n\n-\n\n  b', ul('<li>a</li>', '<li>b</li>') + '\n'],
  ['a fence inside an item ends with the item', '- ~~~\n  x\n\n  y\nz', ul('<li>\n<pre><code>x\n\ny</code></pre>\n</li>') + '\n<p>z</p>\n'],
  ['item with a heading', '- = T\n- *a*', ul('<li>\n<h1 id="t">T</h1>\n</li>', '<li><strong>a</strong></li>') + '\n'],
  ['item with a quote and a paragraph', '- > q\n\n  p', ul('<li>\n<blockquote>\n<p>q</p>\n</blockquote>\n<p>p</p>\n</li>') + '\n'],
  ['intraword delimiters are literal', 'snake_case_name and 2*3*4 and x~y~z', '<p>snake_case_name and 2*3*4 and x~y~z</p>\n'],
  ['punctuation around delimiters', '(*a*), "_b_".', '<p>(<strong>a</strong>), &quot;<em>b</em>&quot;.</p>\n'],
  ['spaces prevent delimiters', '* a * b*', '<p>* a * b*</p>\n'],
  ['crossing delimiters', '*a _b* c_', '<p><strong>a _b</strong> c_</p>\n'],
  ['same delimiters nest', '*a *b* c*', '<p><strong>a <strong>b</strong> c</strong></p>\n'],
  ['doubled delimiters', '**bold**', '<p><strong><strong>bold</strong></strong></p>\n'],
  ['an empty pair stays literal', 'a ** b ~~', '<p>a ** b ~~</p>\n'],
  ['escaped delimiters', '\\*a\\* *b\\*c*', '<p>*a* <strong>b*c</strong></p>\n'],
  ['flanking looks at raw neighbours', '\\**a*', '<p>*<strong>a</strong></p>\n'],
  ['unicode word characters', 'über_alles_ and ñ*x* and 3_4_', '<p>über_alles_ and ñ*x* and 3_4_</p>\n'],
  ['deletion and emphasis', '~gone~ _it_', '<p><del>gone</del> <em>it</em></p>\n'],
  ['delimiters across lines', '*a\nb* and *\nc*', '<p><strong>a\nb</strong> and *\nc*</p>\n'],
  ['code spans', '`a  *b*` and `` and `x', '<p><code>a  *b*</code> and `<code> and </code>x</p>\n'],
  ['code spans have no escapes and span lines', '`a\\` b`\nc`', '<p><code>a\\</code> b<code> c</code></p>\n'],
  ['hard breaks', 'a\\\nb\\\\\nc \\\nd\\', '<p>a<br>\nb\\\nc <br>\nd\\</p>\n'],
  ['a backslash at the end of a heading', '= a\\', '<h1 id="a">a\\</h1>\n'],
  ['links', '[a *b*](http://x.y/?q=1&r="2") [c](/rel) [d](MAILTO:me@x.y) [](e)',
    '<p><a href="http://x.y/?q=1&amp;r=&quot;2&quot;">a <strong>b</strong></a> <a href="/rel">c</a> <a href="MAILTO:me@x.y">d</a> <a href="e"></a></p>\n'],
  ['unsafe schemes keep only the text', '[click *me*](javascript:alert) [x](data:text/html,hi) [y](c:/dir) [z](./a:b) [w](1http:x) [v](HTTPS:ok)',
    '<p>click <strong>me</strong> x y <a href="./a:b">z</a> <a href="1http:x">w</a> <a href="HTTPS:ok">v</a></p>\n'],
  ['invalid links are literal', '[a](b c) [d] (e) [f]() [g[h](i) [j\\](k) [l](m(n))',
    '<p>[a](b c) [d] (e) [f]() [g<a href="i">h</a> [j](k) [l](m(n))</p>\n'],
  ['escaped brackets inside link text', '[a\\]b\\[c](t\\u)', '<p><a href="t\\u">a]b[c</a></p>\n'],
  ['link text is parsed on its own', '*a [b* c](x) d*', '<p><strong>a <a href="x">b* c</a> d</strong></p>\n'],
  ['a ] in a code span ends the link text', '[a `]` b](x)', '<p>[a <code>]</code> b](x)</p>\n'],
  ['html escaping', '<b> & "q" \'single\'', '<p>&lt;b&gt; &amp; &quot;q&quot; \'single\'</p>\n'],
  ['backslash before other characters', 'a\\b \\é \\ x', '<p>a\\b \\é \\ x</p>\n'],
  ['every ASCII punctuation character can be escaped', '\\[a](b) \\`c\\` \\# \\{\\} \\@ \\\\',
    '<p>[a](b) `c` # {} @ \\</p>\n'],
  ['ids are unique in document order', '= A\n= A\n= A-2\n= a 2\n> = A\n- = A',
    '<h1 id="a">A</h1>\n<h1 id="a-2">A</h1>\n<h1 id="a-2-2">A-2</h1>\n<h1 id="a-2-3">a 2</h1>\n<blockquote>\n<h1 id="a-3">A</h1>\n</blockquote>\n' + ul('<li>\n<h1 id="a-4">A</h1>\n</li>') + '\n'],
  ['slugs use the plain text', '== *Hello*, [World](x)! `v2.0` & Ünïcode__',
    '<h2 id="hello-world-v2-0-n-code"><strong>Hello</strong>, <a href="x">World</a>! <code>v2.0</code> &amp; Ünïcode__</h2>\n'],
  ['empty slugs', '= ***\n== !!!\n=', '<h1 id="section">***</h1>\n<h2 id="section-2">!!!</h2>\n<h1 id="section-3"></h1>\n'],
  ['unsafe link text in slugs', '= [Go](javascript:x) now', '<h1 id="go-now">Go now</h1>\n'],
  ['blank documents', '\n\n  \n\t', ''],
];

const HIDDEN = `import test from 'node:test';
import assert from 'node:assert/strict';
const {render} = await import('@ROOT@src/index.js');
for (const [name, source, expected] of ${JSON.stringify(CASES)}) {
  test(name, () => assert.equal(render(source), expected));
}
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const tweak = (file, pairs) => root => writeTree(root, {[file]: patch(REFERENCE[file], pairs)});

export default {
  id: 'glint-markup',
  category: 'invented markup language',
  prompt: 'The Glint markup renderer in src/ (`render`, exported from src/index.js) is an early version: it is incomplete and also deviates from its specification, docs/GLINT.md, in places. Make `render` implement docs/GLINT.md completely and exactly: every section, including whitespace, nesting, escaping and heading ids. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Glint markup: early renderer and specification', files]]),
  solve: root => writeTree(root, REFERENCE),
  verify(root, before) {
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, HIDDEN);
    let pkg = {};
    try { pkg = JSON.parse(read(root, 'package.json')); } catch {}
    return verdict({
      tests_unchanged: unchanged(before, root, 'test/', {allowAdded: true}),
      no_dependencies: DEPENDENCY_FIELDS.every(field => pkg[field] === undefined),
      suite_passes: suite.status === 0,
      hidden_cases: hidden.pass,
    }, {suite: (suite.stdout + suite.stderr).slice(-2000), hidden: hidden.output});
  },
  mustReject: [
    // Tabs replaced by four spaces instead of up to the next tab stop.
    tweak('src/lines.js', [['const n = 4 - column % 4;', 'const n = 4;']]),
    // Quotes strip every space after the >.
    tweak('src/blocks.js', [[".replace(/^> ?/, '')", ".replace(/^> */, '')"]]),
    // Numbered items do not interrupt paragraphs.
    tweak('src/blocks.js', [["line.startsWith('>') || itemMarker(line) !== null;", "line.startsWith('>') || itemMarker(line)?.kind === 'ul';"]]),
    // Duplicate ids numbered per slug instead of skipping ids already taken.
    tweak('src/slug.js', [['for (let n = 2; used.has(id); n++) id = base + \'-\' + n;', "const count = (used.counts ??= new Map()).get(base) ?? 0;\n  used.counts.set(base, count + 1);\n  if (count) id = base + '-' + (count + 1);"]]),
    // Intraword delimiters open.
    tweak('src/inline.js', [['const canOpen = next !== undefined && !isSpace(next) && !isWord(prev);', 'const canOpen = next !== undefined && !isSpace(next);']]),
    // Schemes compared case-sensitively.
    tweak('src/inline.js', [['SAFE_SCHEMES.includes(scheme[1].toLowerCase())', 'SAFE_SCHEMES.includes(scheme[1])']]),
    // Line breaks kept inside code spans.
    tweak('src/inline.js', [[".join('').replaceAll('\\n', ' ')", ".join('')"]]),
    // A visible test edited.
    root => writeTree(root, {'test/glint.test.js': VISIBLE.replace("test('quotes'", "test.skip('quotes'")}),
  ],
};
