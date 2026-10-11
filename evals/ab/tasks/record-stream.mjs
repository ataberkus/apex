import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

const SPEC = `# PRS 2: the pipe record stream format

\`RecordReader\` in \`src/reader.js\` reads a PRS 2 byte stream incrementally and turns it into events.

## API

\`\`\`js
import {RecordReader} from './src/reader.js';
const reader = new RecordReader();
const events = [...reader.push(chunk1), ...reader.push(chunk2), ...reader.end()];
\`\`\`

- \`push(chunk)\` takes a \`Uint8Array\` (a \`Buffer\` is one) of any length, including 0, and returns an array of the events that became available.
- \`end()\` declares that the input is complete and returns an array of the remaining events. \`push()\` and \`end()\` are not called after \`end()\`.
- **Chunk boundaries carry no meaning.** The concatenation of everything returned by the \`push()\` calls and \`end()\` is the same however the input bytes are split into chunks: a chunk may end anywhere, including inside a multi-byte UTF-8 character, between the CR and LF of a CRLF, inside an escape sequence or inside the byte order mark.
- **Events are returned as early as the rules allow.** A record event is returned by the \`push()\` call that delivers the LF byte that completes the record (see Records); a record completed by the end of input is returned by \`end()\`. An \`expected N fields, got M\` error is returned exactly when the record it replaces would have been. Any other error is returned no later than the \`push()\` call that delivers the LF byte ending the line on which the error is found; errors found only at the end of input (including \`unterminated heredoc\`, \`dangling backslash\` and errors on a last line that has no LF) are returned by \`end()\`. Events are always returned in input order.
- **Work is proportional to input.** A \`push()\` call does work proportional to the size of its chunk plus the size of the events it returns, never to the amount of input received earlier (amortized). Feeding a 1 MiB (1,048,576 byte) input one byte per \`push()\` call must finish in under 3 seconds in total.

### Events

Every event is a plain object with exactly these properties:

- \`{type: 'record', line, fields}\`: \`line\` is the physical line (see below) on which the record starts; \`fields\` is an array of one or more strings.
- \`{type: 'error', line, column, message}\`: \`line\` and \`column\` give the error's position; \`message\` is one of the messages listed in this document, character for character.

## Bytes, characters and lines

The input is UTF-8.

- If the very first three bytes of the input are EF BB BF (a byte order mark), they are ignored: they belong to no line and are not counted as a character. U+FEFF anywhere else is an ordinary character.
- Any byte sequence that is not well-formed UTF-8 is the error \`invalid UTF-8\`, positioned at the first byte of the ill-formed sequence. Ill-formed means: a byte 80-BF that does not continue a multi-byte character; a byte C0, C1 or F5-FF; a lead byte that is not followed by the required number of continuation bytes (whether a different byte or the end of input comes first); overlong encodings (an E0 lead followed by 80-9F, an F0 lead followed by 80-8F); surrogates (an ED lead followed by A0-BF); code points above U+10FFFF (an F4 lead followed by 90-BF).
- Lines end with LF or with CRLF. The terminator is not part of the line's content. A CR that is not immediately followed by LF is the error \`bare CR\`, positioned at the CR.
- Lines are numbered from 1; line *n* starts right after the (*n*-1)th LF byte of the input.
- The column of a position is 1 plus the number of characters (Unicode scalar values) in front of it on its line. The byte order mark is not counted. Columns therefore count characters, not bytes and not UTF-16 code units: on the line \`é😀x\`, \`x\` is in column 3.

## Lines between records

When the reader is at the start of a line and not inside a record, the line is classified by its first character:

- An empty line is ignored.
- \`#\` starts a comment line, which is ignored. Nothing on a comment line has a meaning (no escapes, continuations or heredocs), but its bytes must still be valid UTF-8 and free of bare CRs.
- \`%\` starts a directive line (see Directives).
- Any other character starts a record on this line. A line that holds only spaces is a record.

## Directives

A directive line is taken literally: escapes, continuations and heredocs do not apply. Its *name* is the text after \`%\` up to the first space or the end of the line, and its *argument* is everything after that first space. There are two directives, and they take effect from the next line on:

- \`%sep X\`: the argument must be exactly one character, which becomes the field separator. The separator may be any character except an ASCII letter or digit, space, tab, \`\\\`, \`#\`, \`%\` and \`<\`; non-ASCII characters such as \`¦\` or \`→\` are allowed. At the start of the input the separator is \`|\`.
- \`%fields N\`: from now on every record must have exactly N fields. N is a decimal integer from 1 to 999 without leading zeros. \`%fields *\` removes the requirement again. At the start of the input there is no requirement.

A directive whose name is \`sep\` or \`fields\` but which has no space after the name or whose argument is not valid is the error \`invalid directive\`; any other name (names are case-sensitive, and \`%\` alone has the empty name) is the error \`unknown directive\`. Both are positioned at column 1 of the directive line, and an invalid directive changes nothing.

## Records

A record consists of one or more physical lines (joined by continuations) and possibly a heredoc body. Its text is split into fields at every unescaped occurrence of the current separator, so a record has one more field than it has unescaped separators. Fields are not trimmed and may be empty: the line \`|\` is a record with two empty fields.

### Escapes

A backslash starts an escape sequence:

| Written | Value |
|---|---|
| \`\\\\\` | \`\\\` |
| \`\\\` followed by the current separator | the separator character, as text |
| \`\\n\` | LF |
| \`\\t\` | tab |
| \`\\#\` | \`#\` |
| \`\\%\` | \`%\` |
| \`\\xHH\` | the character U+00HH; exactly two hex digits (\`0-9\`, \`a-f\`, \`A-F\`) |
| \`\\u{H...}\` | the character with that code point; 1 to 6 hex digits between the braces, at most 10FFFF and not D800-DFFF |
| \`\\\` followed by a line terminator | continuation, see below |

- A \`\\x\` or \`\\u\` sequence that does not have exactly the form shown, or whose value is not allowed, is the error \`invalid escape\` (examples: \`\\x4g\`, \`\\x4\` at the end of a line, \`\\u0041\`, \`\\u{}\`, \`\\u{1234567}\`, \`\\u{D800}\`, \`\\u{110000}\`).
- A backslash followed by any other character is the error \`unknown escape\`. That includes a backslash followed by a CR that is not part of a CRLF, and a backslash followed by an ill-formed UTF-8 sequence.
- A backslash that is the last byte of the input is the error \`dangling backslash\`.
- All three errors are positioned at the backslash.

### Continuations

A backslash directly followed by a line terminator removes both and continues the record (and the current field) on the next physical line. Spaces and tabs at the start of that continuation line are removed as well. A continuation line is always part of the record: \`#\`, \`%\` or an empty line there have no special meaning. If the continuation line is empty, the record ends with it; if the input ends right after the continuation's terminator, the record ends there.

### Heredocs

A record's last field can take its value from the following lines. The field is a heredoc opener when its raw text, the characters from just after the separator (or from the start of the line) up to the end of the record's last physical line, is exactly \`<<\` followed by a tag of 1 to 16 characters, each of which is \`A\`-\`Z\`, \`0\`-\`9\` or \`_\`. A raw text that contains a backslash (an escape or a continuation) is never an opener; \`\\x3C<EOF\` is how to write the literal value \`<<EOF\`.

The lines after the opener's line form the heredoc body, up to the first line whose content is exactly the tag. The field's value is the body lines joined with LF (no LF after the last line; an empty body gives \`''\`). Body lines are taken literally: no escapes, continuations, comments, directives or separators, but their bytes must still be valid UTF-8 and free of bare CRs. The tag line ends the record.

If the input ends before a tag line, the error is \`unterminated heredoc\`, positioned at the first \`<\` of the opener. That includes an opener on the last line of the input, and a body whose last line is the tag without a terminator is complete (the end of input ends the tag line).

### When a record is complete

A record is complete at the LF that ends its last physical line: the line that does not end in a continuation, or the heredoc's tag line. A record whose last line is ended by the end of input instead is completed by \`end()\`. A complete record is checked against the \`%fields\` requirement in force when it started; if the field count differs, the record is replaced by the error \`expected N fields, got M\` (with N and M in decimal, for example \`expected 1 fields, got 2\`), positioned at line *L* column 1, where *L* is the line on which the record started. Otherwise it becomes a record event.

## Errors and recovery

The reader stops at the first error it finds in a record, directive line or comment line. It reports that one error, and the record (all of it, including earlier lines joined by continuations and any heredoc body read so far) is discarded; there is never more than one error per record or line.

Errors are found in reading order, byte by byte. A directive is judged (\`invalid directive\`, \`unknown directive\`) only when its whole line has been read without another error, and the field count only when the record is complete without another error. An escape sequence is judged when the character that completes or breaks it is read, even when that character is itself a bare CR or the start of an ill-formed UTF-8 sequence (see Escapes); its error is positioned at the backslash all the same.

After any error except \`expected N fields, got M\`, the reader discards every byte from the error's position up to and including the next LF byte, and then continues at the start of the next line as if between records. Discarded bytes are not examined at all: they produce no further errors, and a continuation, heredoc opener or directive in them has no effect. In particular, an error inside a heredoc body ends the heredoc: the following lines are read as ordinary lines. The \`expected N fields, got M\` error discards just the record, which is already complete.

## Example

Input (\`⏎\` stands for LF):

\`\`\`
# inventory⏎
%fields 3⏎
apple|3|red⏎
pear|\\x41\\u{1F350}|gr\\⏎
    een⏎
fig|2⏎
note|1|<<END⏎
two⏎
lines⏎
END⏎
%sep ;⏎
kiwi;\\;;\\q|x⏎
plum;1;purple
\`\`\`

Events:

\`\`\`js
{type: 'record', line: 3, fields: ['apple', '3', 'red']}
{type: 'record', line: 4, fields: ['pear', 'A🍐', 'green']}
{type: 'error', line: 6, column: 1, message: 'expected 3 fields, got 2'}
{type: 'record', line: 7, fields: ['note', '1', 'two\\nlines']}
{type: 'error', line: 12, column: 9, message: 'unknown escape'}
{type: 'record', line: 13, fields: ['plum', '1', 'purple']}  // returned by end(): no LF after it
\`\`\`
`;

const NAIVE = String.raw`/** Reads PRS records from chunks of bytes; see docs/FORMAT.md. */
export class RecordReader {
  #pending = '';
  #line = 1;

  push(chunk) {
    this.#pending += new TextDecoder().decode(chunk);
    const lines = this.#pending.split('\n');
    this.#pending = lines.pop();
    return lines.flatMap(line => this.#parse(line.replace(/\r$/, '')));
  }

  end() {
    const rest = this.#pending;
    this.#pending = '';
    return rest ? this.#parse(rest) : [];
  }

  #parse(text) {
    const line = this.#line++;
    if (text === '' || text.startsWith('#')) return [];
    const fields = [''];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '|') fields.push('');
      else if (ch === '\\' && i + 1 < text.length) {
        const next = text[++i];
        fields[fields.length - 1] += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      } else fields[fields.length - 1] += ch;
    }
    return [{type: 'record', line, fields}];
  }
}
`;

const VISIBLE = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {RecordReader} from '../src/reader.js';

const read = (...chunks) => {
  const reader = new RecordReader();
  const events = chunks.flatMap(chunk => reader.push(Buffer.from(chunk)));
  return [...events, ...reader.end()];
};
const rec = (line, ...fields) => ({type: 'record', line, fields});

test('records, comments and blank lines', () => {
  assert.deepEqual(read('# header\na|b|c\n\nd||\n'), [rec(2, 'a', 'b', 'c'), rec(4, 'd', '', '')]);
});

test('CRLF line endings and a last line without terminator', () => {
  assert.deepEqual(read('a|b\r\nc'), [rec(1, 'a', 'b'), rec(2, 'c')]);
});

test('escapes', () => {
  assert.deepEqual(read('a\\|b|\\n\\t\\\\\n'), [rec(1, 'a|b', '\n\t\\')]);
});

test('records split across chunks at line boundaries', () => {
  assert.deepEqual(read('a|b\n', 'c|d\n'), [rec(1, 'a', 'b'), rec(2, 'c', 'd')]);
});

test('a record is returned as soon as its line is complete', () => {
  const reader = new RecordReader();
  assert.deepEqual(reader.push(Buffer.from('a|b\nc')), [rec(1, 'a', 'b')]);
  assert.deepEqual(reader.end(), [rec(2, 'c')]);
});

test('separator directive', () => {
  assert.deepEqual(read('%sep ;\na;b|c\n'), [rec(2, 'a', 'b|c')]);
});

test('heredoc', () => {
  assert.deepEqual(read('x|<<EOF\none\ntwo\nEOF\ny\n'), [rec(1, 'x', 'one\ntwo'), rec(5, 'y')]);
});

test('unknown escape', () => {
  assert.deepEqual(read('a\\qb\nc\n'), [{type: 'error', line: 1, column: 2, message: 'unknown escape'}, rec(2, 'c')]);
});
`;

const files = {
  'package.json': JSON.stringify({name: 'prs-reader', version: '2.0.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'docs/FORMAT.md': SPEC,
  'src/reader.js': NAIVE,
  'test/reader.test.js': VISIBLE,
};

const REFERENCE = String.raw`/** Incremental reader for the PRS 2 record stream; see docs/FORMAT.md. */
const START = 0, COMMENT = 1, DIRECTIVE = 2, FIELD = 3, ESCAPE = 4, HEX = 5, BRACE = 6, CODE = 7, INDENT = 8, BODY = 9, SKIP = 10;
const HEXDIGIT = /^[0-9a-fA-F]$/;
const OPENER = /^<<[A-Z0-9_]{1,16}$/;
const BAD_SEP = /^[A-Za-z0-9 \t\\#%<]$/;

export class RecordReader {
  #out = [];
  #state = START;
  #first = true;
  #line = 1;
  #col = 1;
  // UTF-8 decoding
  #need = 0; #cp = 0; #lo = 0x80; #hi = 0xBF; #leadCol = 0; #cr = false; #crCol = 0;
  // directives
  #sep = '|'; #want = 0;
  // the record being read
  #recLine = 0; #fields = []; #field = ''; #raw = ''; #rawCol = 0; #esc = null; #digits = '';
  #tag = ''; #opener = null; #body = []; #bodyLine = ''; #recWant = 0; #text = '';

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) this.#byte(chunk[i]);
    return this.#take();
  }

  end() {
    if (this.#state !== SKIP) {
      if (this.#need) { this.#need = 0; this.#invalid(this.#leadCol); }
      else if (this.#cr) { this.#cr = false; this.#bareCR(); }
      else this.#finish();
    }
    return this.#take();
  }

  #take() { const out = this.#out; this.#out = []; return out; }

  #byte(b) {
    if (this.#state === SKIP) {
      if (b === 10) { this.#line++; this.#col = 1; this.#state = START; }
      return;
    }
    if (this.#need) {
      if (b >= this.#lo && b <= this.#hi) {
        this.#cp = (this.#cp << 6) | (b & 0x3F);
        this.#lo = 0x80; this.#hi = 0xBF;
        if (--this.#need === 0) this.#char(this.#cp);
        return;
      }
      this.#need = 0;
      this.#invalid(this.#leadCol);
      return this.#byte(b);
    }
    if (this.#cr) {
      this.#cr = false;
      if (b === 10) return this.#eol();
      this.#bareCR();
      return this.#byte(b);
    }
    if (b < 0x80) {
      if (b === 13) { this.#cr = true; this.#crCol = this.#col; return; }
      if (b === 10) return this.#eol();
      return this.#char(b);
    }
    this.#leadCol = this.#col;
    if (b >= 0xC2 && b <= 0xDF) { this.#need = 1; this.#cp = b & 0x1F; }
    else if (b >= 0xE0 && b <= 0xEF) { this.#need = 2; this.#cp = b & 0x0F; if (b === 0xE0) this.#lo = 0xA0; if (b === 0xED) this.#hi = 0x9F; }
    else if (b >= 0xF0 && b <= 0xF4) { this.#need = 3; this.#cp = b & 0x07; if (b === 0xF0) this.#lo = 0x90; if (b === 0xF4) this.#hi = 0x8F; }
    else this.#invalid(this.#col);
  }

  #error(col, message, line = this.#line) {
    this.#out.push({type: 'error', line, column: col, message});
  }

  /** An error at col on the current line: report it and skip through the next LF. */
  #bad(col, message) {
    this.#error(col, message);
    this.#state = SKIP;
    this.#first = false;
  }

  /** An ill-formed sequence: inside an escape it is the escape's error. */
  #invalid(col) {
    if (this.#state === ESCAPE) return this.#bad(this.#esc, 'unknown escape');
    if (this.#state === HEX || this.#state === BRACE || this.#state === CODE) return this.#bad(this.#esc, 'invalid escape');
    this.#bad(col, 'invalid UTF-8');
  }

  #bareCR() {
    if (this.#state === ESCAPE) return this.#bad(this.#esc, 'unknown escape');
    if (this.#state === HEX || this.#state === BRACE || this.#state === CODE) return this.#bad(this.#esc, 'invalid escape');
    this.#bad(this.#crCol, 'bare CR');
  }

  #record() {
    const fields = this.#fields;
    this.#fields = [];
    if (this.#recWant && fields.length !== this.#recWant) this.#error(1, 'expected ' + this.#recWant + ' fields, got ' + fields.length, this.#recLine);
    else this.#out.push({type: 'record', line: this.#recLine, fields});
  }

  /** End of the record's last physical line: a heredoc opener or the end of the record. */
  #lineDone() {
    this.#fields.push(this.#field);
    if (this.#raw !== null && OPENER.test(this.#raw)) {
      this.#tag = this.#raw.slice(2);
      this.#opener = [this.#line, this.#rawCol];
      this.#body = []; this.#bodyLine = '';
      this.#state = BODY;
      return;
    }
    this.#record();
    this.#state = START;
  }

  #directive() {
    const text = this.#text, space = text.indexOf(' ');
    const name = space < 0 ? text : text.slice(0, space), arg = space < 0 ? null : text.slice(space + 1);
    if (name === 'sep') {
      if (arg !== null && [...arg].length === 1 && !BAD_SEP.test(arg)) return void (this.#sep = arg);
    } else if (name === 'fields') {
      if (arg === '*') return void (this.#want = 0);
      if (arg !== null && /^[1-9][0-9]{0,2}$/.test(arg)) return void (this.#want = Number(arg));
    } else return this.#error(1, 'unknown directive');
    this.#error(1, 'invalid directive');
  }

  #eol() {
    this.#first = false;
    switch (this.#state) {
      case COMMENT: this.#state = START; break;
      case DIRECTIVE: this.#directive(); this.#state = START; break;
      case FIELD: case INDENT: this.#lineDone(); break;
      case ESCAPE: this.#state = INDENT; this.#raw = null; break;
      case HEX: case BRACE: case CODE: this.#error(this.#esc, 'invalid escape'); this.#state = START; break;
      case BODY:
        if (this.#bodyLine === this.#tag) { this.#fields[this.#fields.length - 1] = this.#body.join('\n'); this.#record(); this.#state = START; }
        else { this.#body.push(this.#bodyLine); this.#bodyLine = ''; }
        break;
    }
    this.#line++;
    this.#col = 1;
  }

  #finish() {
    switch (this.#state) {
      case DIRECTIVE: this.#directive(); break;
      case FIELD: case INDENT: this.#lineDone(); if (this.#state === BODY) this.#error(this.#opener[1], 'unterminated heredoc', this.#opener[0]); break;
      case ESCAPE: this.#error(this.#esc, 'dangling backslash'); break;
      case HEX: case BRACE: case CODE: this.#error(this.#esc, 'invalid escape'); break;
      case BODY:
        if (this.#bodyLine === this.#tag) { this.#fields[this.#fields.length - 1] = this.#body.join('\n'); this.#record(); }
        else this.#error(this.#opener[1], 'unterminated heredoc', this.#opener[0]);
        break;
    }
    this.#state = START;
  }

  #char(cp) {
    const col = this.#col;
    if (this.#first) { this.#first = false; if (cp === 0xFEFF) return; }
    this.#col++;
    const ch = String.fromCodePoint(cp);
    switch (this.#state) {
      case START:
        if (ch === '#') { this.#state = COMMENT; return; }
        if (ch === '%') { this.#state = DIRECTIVE; this.#text = ''; return; }
        this.#recLine = this.#line; this.#recWant = this.#want;
        this.#fields = []; this.#field = ''; this.#raw = ''; this.#rawCol = col;
        this.#state = FIELD;
        return this.#fieldChar(ch, col);
      case COMMENT: return;
      case DIRECTIVE: this.#text += ch; return;
      case INDENT:
        if (ch === ' ' || ch === '\t') return;
        this.#state = FIELD;
        return this.#fieldChar(ch, col);
      case FIELD: return this.#fieldChar(ch, col);
      case ESCAPE:
        this.#state = FIELD;
        if (ch === '\\' || ch === this.#sep || ch === '#' || ch === '%') this.#field += ch;
        else if (ch === 'n') this.#field += '\n';
        else if (ch === 't') this.#field += '\t';
        else if (ch === 'x') { this.#state = HEX; this.#digits = ''; }
        else if (ch === 'u') this.#state = BRACE;
        else this.#bad(this.#esc, 'unknown escape');
        return;
      case HEX:
        if (!HEXDIGIT.test(ch)) return this.#bad(this.#esc, 'invalid escape');
        this.#digits += ch;
        if (this.#digits.length === 2) { this.#field += String.fromCharCode(parseInt(this.#digits, 16)); this.#state = FIELD; }
        return;
      case BRACE:
        if (ch !== '{') return this.#bad(this.#esc, 'invalid escape');
        this.#digits = ''; this.#state = CODE;
        return;
      case CODE: {
        if (ch === '}') {
          const value = parseInt(this.#digits, 16);
          if (!this.#digits || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) return this.#bad(this.#esc, 'invalid escape');
          this.#field += String.fromCodePoint(value);
          this.#state = FIELD;
          return;
        }
        if (!HEXDIGIT.test(ch) || this.#digits.length === 6) return this.#bad(this.#esc, 'invalid escape');
        this.#digits += ch;
        return;
      }
      case BODY: this.#bodyLine += ch; return;
    }
  }

  #fieldChar(ch, col) {
    if (ch === '\\') { this.#state = ESCAPE; this.#esc = col; this.#raw = null; return; }
    if (ch === this.#sep) { this.#fields.push(this.#field); this.#field = ''; this.#raw = ''; this.#rawCol = col + 1; return; }
    this.#field += ch;
    if (this.#raw !== null) this.#raw += ch;
  }
}
`;

const r = (line, ...fields) => ({type: 'record', line, fields});
const e = (line, column, message) => ({type: 'error', line, column, message});

// [name, input parts (a string is UTF-8, an array is raw bytes), expected events]
const CASES = [
  ["empty and blank-only input", ["\n\r\n\n"],
    []],
  ["empty fields and space-only records", ["|\na||b\n   \n\t\n"],
    [r(1, "", ""), r(2, "a", "", "b"), r(3, "   "), r(4, "\t")]],
  ["CRLF and LF mixed, last line without terminator", ["a|b\r\n\r\nc\nd|e"],
    [r(1, "a", "b"), r(3, "c"), r(4, "d", "e")]],
  ["byte order mark is skipped", ["\ufeffa|b\n"],
    [r(1, "a", "b")]],
  ["byte order mark is not counted in columns", ["\ufeffab\\q\nok\n"],
    [e(1, 3, "unknown escape"), r(2, "ok")]],
  ["byte order mark before a comment and a blank line", ["\ufeff#c\n\nx\n"],
    [r(3, "x")]],
  ["only a byte order mark", ["\ufeff"],
    []],
  ["U+FEFF later is an ordinary character", ["x\n\ufeffy|\ufeff\n"],
    [r(1, "x"), r(2, "\ufeffy", "\ufeff")]],
  ["two byte order marks: the second is data", ["\ufeff\ufeffz\n"],
    [r(1, "\ufeffz")]],
  ["truncated byte order mark at end of input", [[239,187]],
    [e(1, 1, "invalid UTF-8")]],
  ["broken byte order mark", [[239,187,65],"|b\nc\n"],
    [e(1, 1, "invalid UTF-8"), r(2, "c")]],
  ["columns count characters, not code units or bytes", ["\u00e9\ud83d\ude00x\\q\n"],
    [e(1, 4, "unknown escape")]],
  ["stray continuation byte", ["ab",[128],"cd\nnext\n"],
    [e(1, 3, "invalid UTF-8"), r(2, "next")]],
  ["C0 overlong lead", ["a",[192,175],"\nb\n"],
    [e(1, 2, "invalid UTF-8"), r(2, "b")]],
  ["E0 overlong", ["\u00e9|",[224,128,128],"\nb\n"],
    [e(1, 3, "invalid UTF-8"), r(2, "b")]],
  ["encoded surrogate", ["xy",[237,160,128],"z\nb\n"],
    [e(1, 3, "invalid UTF-8"), r(2, "b")]],
  ["ED lead with a valid second byte", ["x",[237,159,191],"\n"],
    [r(1, "x\ud7ff")]],
  ["F4 above U+10FFFF", ["1",[244,144,128,128],"\nb\n"],
    [e(1, 2, "invalid UTF-8"), r(2, "b")]],
  ["F4 at the top of the range", ["1",[244,143,191,191],"\n"],
    [r(1, "1\udbff\udfff")]],
  ["F5 lead byte", ["ab|c",[245],"\nb\n"],
    [e(1, 5, "invalid UTF-8"), r(2, "b")]],
  ["sequence cut short by an ASCII byte", ["ab",[226,130],"x|y\nb\n"],
    [e(1, 3, "invalid UTF-8"), r(2, "b")]],
  ["sequence cut short by LF", ["ab",[226,130],"\nb\n"],
    [e(1, 3, "invalid UTF-8"), r(2, "b")]],
  ["sequence cut short by the end of input", ["ok\nab",[240,159,152]],
    [r(1, "ok"), e(2, 3, "invalid UTF-8")]],
  ["skipped bytes are not examined", ["a\\q",[255,13],"b\\\n",[128],"\nok\n"],
    [e(1, 2, "unknown escape"), e(2, 1, "invalid UTF-8"), r(3, "ok")]],
  ["invalid UTF-8 in a comment line", ["#",[255],"\nok\n"],
    [e(1, 2, "invalid UTF-8"), r(2, "ok")]],
  ["bare CR in a record", ["ab\rc\nd\n"],
    [e(1, 3, "bare CR"), r(2, "d")]],
  ["bare CR before CRLF", ["a\r\r\nb\n"],
    [e(1, 2, "bare CR"), r(2, "b")]],
  ["bare CR at end of input", ["ok\nab\r"],
    [r(1, "ok"), e(2, 3, "bare CR")]],
  ["bare CR in a comment line", ["#a\rb\nc\n"],
    [e(1, 3, "bare CR"), r(2, "c")]],
  ["separator can be switched back", ["%sep ;\na;b|c\n%sep |\na;b|c\n#\n"],
    [r(2, "a", "b|c"), r(4, "a;b", "c")]],
  ["comment line content has no meaning", ["#x|y\\\nz\n#<<END\nEND\n"],
    [r(2, "z"), r(4, "END")]],
  ["only the first character makes a comment", ["  #x\n\\#y\n"],
    [r(1, "  #x"), r(2, "#y")]],
  ["separator directive", ["a;b\n%sep ;\na;b|c\n"],
    [r(1, "a;b"), r(3, "a", "b|c")]],
  ["separator directive with CRLF", ["%sep ;\r\na;b\r\n"],
    [r(2, "a", "b")]],
  ["non-ASCII separators", ["%sep \u00a6\na\u00a6b\n%sep \u2192\nc\u2192d\\\u2192e\n%sep \ud83d\ude00\nf\ud83d\ude00g\n"],
    [r(2, "a", "b"), r(4, "c", "d\u2192e"), r(6, "f", "g")]],
  ["escaped separator follows the current separator", ["%sep ;\na\\;b;c\nd\\|e\n"],
    [r(2, "a;b", "c"), e(3, 2, "unknown escape")]],
  ["invalid separator arguments", ["%sep ;;\n%sep\n%sep  ;\n%sep a\n%sep 7\n%sep <\n%sep \\\n%sep #\n%sep %\n%sep \t\n%sep ,\u0301\na|b\n"],
    [e(1, 1, "invalid directive"), e(2, 1, "invalid directive"), e(3, 1, "invalid directive"), e(4, 1, "invalid directive"), e(5, 1, "invalid directive"), e(6, 1, "invalid directive"), e(7, 1, "invalid directive"), e(8, 1, "invalid directive"), e(9, 1, "invalid directive"), e(10, 1, "invalid directive"), e(11, 1, "invalid directive"), r(12, "a", "b")]],
  ["separators that are allowed", ["%sep >\na>b\n%sep {\nc{d\\{e\n%sep ,\nf,g\n"],
    [r(2, "a", "b"), r(4, "c", "d{e"), r(6, "f", "g")]],
  ["unknown directives", ["%SEP ;\n%\n%seps ;\n%fields\na|b\n"],
    [e(1, 1, "unknown directive"), e(2, 1, "unknown directive"), e(3, 1, "unknown directive"), e(4, 1, "invalid directive"), r(5, "a", "b")]],
  ["directive on the last line without LF", ["ok\n%x"],
    [r(1, "ok"), e(2, 1, "unknown directive")]],
  ["fields requirement", ["%fields 2\na|b\nc\nd|e|f\n%fields *\ng\n"],
    [r(2, "a", "b"), e(3, 1, "expected 2 fields, got 1"), e(4, 1, "expected 2 fields, got 3"), r(6, "g")]],
  ["invalid fields arguments", ["%fields 0\n%fields 01\n%fields 1000\n%fields -1\n%fields 2 \n%fields x\na\n"],
    [e(1, 1, "invalid directive"), e(2, 1, "invalid directive"), e(3, 1, "invalid directive"), e(4, 1, "invalid directive"), e(5, 1, "invalid directive"), e(6, 1, "invalid directive"), r(7, "a")]],
  ["fields requirement up to 999", ["%fields 999\na|b\n%fields 1\nc\n"],
    [e(2, 1, "expected 999 fields, got 2"), r(4, "c")]],
  ["invalid directive changes nothing", ["%fields 2\n%fields 0\na\n%sep ;\n%sep ab\nc;d|e\n"],
    [e(2, 1, "invalid directive"), e(3, 1, "expected 2 fields, got 1"), e(5, 1, "invalid directive"), r(6, "c", "d|e")]],
  ["invalid UTF-8 in a directive line is reported instead", ["%nope",[255],"\n%sep ",[195],"\nx\n"],
    [e(1, 6, "invalid UTF-8"), e(2, 6, "invalid UTF-8"), r(3, "x")]],
  ["all simple escapes", ["\\\\|\\||\\n|\\t|\\#|\\%\n"],
    [r(1, "\\", "|", "\n", "\t", "#", "%")]],
  ["hex escapes", ["\\x41\\xfF\\x00|\\x7e\n"],
    [r(1, "A\u00ff\u0000", "~")]],
  ["invalid hex escapes", ["a\\x4g\nb\\x4\nc\\x\nd\\X41\nok\n"],
    [e(1, 2, "invalid escape"), e(2, 2, "invalid escape"), e(3, 2, "invalid escape"), e(4, 2, "unknown escape"), r(5, "ok")]],
  ["brace escapes", ["\\u{1F600}|\\u{0}|\\u{10FFFF}|\\u{000041}|\\u{a}\n"],
    [r(1, "\ud83d\ude00", "\u0000", "\udbff\udfff", "A", "\n")]],
  ["invalid brace escapes", ["\\u{110000}\n\\u{D800}\n\\u{dfff}\n\\u{}\n\\u{1234567}\n\\u0041\n\\u{41\n\\u{4g}\nok\n"],
    [e(1, 1, "invalid escape"), e(2, 1, "invalid escape"), e(3, 1, "invalid escape"), e(4, 1, "invalid escape"), e(5, 1, "invalid escape"), e(6, 1, "invalid escape"), e(7, 1, "invalid escape"), e(8, 1, "invalid escape"), r(9, "ok")]],
  ["unknown escapes", ["a\\q\nb\\ \nc\\<\nd\\N\nok\n"],
    [e(1, 2, "unknown escape"), e(2, 2, "unknown escape"), e(3, 2, "unknown escape"), e(4, 2, "unknown escape"), r(5, "ok")]],
  ["backslash followed by a bare CR", ["ab\\\rc\nok\n"],
    [e(1, 3, "unknown escape"), r(2, "ok")]],
  ["backslash followed by ill-formed UTF-8", ["ab\\",[255],"\nc\\x",[195,40],"\nok\n"],
    [e(1, 3, "unknown escape"), e(2, 2, "invalid escape"), r(3, "ok")]],
  ["backslash followed by a multi-byte character", ["ab\\\u00e9\nok\n"],
    [e(1, 3, "unknown escape"), r(2, "ok")]],
  ["dangling backslash", ["ok\nab\\"],
    [r(1, "ok"), e(2, 3, "dangling backslash")]],
  ["escape cut short by the end of input", ["ab\\x4"],
    [e(1, 3, "invalid escape")]],
  ["brace escape cut short by the end of input", ["ab\\u{4"],
    [e(1, 3, "invalid escape")]],
  ["only the first error of a record is reported", ["\\q\\x\r\\u{}\nok\n"],
    [e(1, 1, "unknown escape"), r(2, "ok")]],
  ["continuation", ["a|b\\\n  \t c|d\n"],
    [r(1, "a", "bc", "d")]],
  ["continuation with CRLF", ["a\\\r\n\tb\r\nc\r\n"],
    [r(1, "ab"), r(3, "c")]],
  ["continuation lines have no special meaning", ["a\\\n#b\\\n%c\\\n<<END\nEND\n"],
    [r(1, "a#b%c<<END"), r(5, "END")]],
  ["empty continuation line ends the record", ["a\\\n\nb\n"],
    [r(1, "a"), r(3, "b")]],
  ["continuation at the end of input", ["a|b\\\n"],
    [r(1, "a", "b")]],
  ["continuation line that holds only blanks", ["a\\\n   \nb\n"],
    [r(1, "a"), r(3, "b")]],
  ["error on a continuation line discards the whole record", ["a|b\\\nc\\q\nd\n"],
    [e(2, 2, "unknown escape"), r(3, "d")]],
  ["line numbers of continued records", ["x\\\ny\\\nz\nw\n"],
    [r(1, "xyz"), r(4, "w")]],
  ["heredoc", ["a|<<END\nline 1\nline 2\nEND\nb\n"],
    [r(1, "a", "line 1\nline 2"), r(5, "b")]],
  ["heredoc body is literal", ["<<T\n#x|y\\q\n%sep ;\n\n<<U\nT\na;b\n"],
    [r(1, "#x|y\\q\n%sep ;\n\n<<U"), r(7, "a;b")]],
  ["heredoc with CRLF lines", ["a|<<E\r\none\r\ntwo\r\nE\r\nb\r\n"],
    [r(1, "a", "one\ntwo"), r(5, "b")]],
  ["empty heredoc", ["a|<<E\nE\nb\n"],
    [r(1, "a", ""), r(3, "b")]],
  ["heredoc whose body is one empty line", ["a|<<E\n\nE\n"],
    [r(1, "a", "")]],
  ["heredoc tag line at end of input", ["a|<<E\nx\nE"],
    [r(1, "a", "x")]],
  ["tag line must match exactly", ["a|<<E_1\nE_1 \n E_1\nE_\nE_1\n"],
    [r(1, "a", "E_1 \n E_1\nE_")]],
  ["unterminated heredoc", ["ok\nab|cd|<<EOF\nx\n"],
    [r(1, "ok"), e(2, 7, "unterminated heredoc")]],
  ["opener on the last line without LF", ["ab|<<EOF"],
    [e(1, 4, "unterminated heredoc")]],
  ["opener on the last line with LF", ["ab|<<EOF\n"],
    [e(1, 4, "unterminated heredoc")]],
  ["heredoc body is only tag-less lines at end of input", ["a|<<E\nE x"],
    [e(1, 3, "unterminated heredoc")]],
  ["opener rules", ["a<<E\n\\x3C<E\n<<e\n<<E \n<<\n<<ABCDEFGHIJKLMNOPQ\n<<ABCDEFGHIJKLMNOP\nx\nABCDEFGHIJKLMNOP\n"],
    [r(1, "a<<E"), r(2, "<<E"), r(3, "<<e"), r(4, "<<E "), r(5, "<<"), r(6, "<<ABCDEFGHIJKLMNOPQ"), r(7, "x")]],
  ["opener after a continued line", ["a\\\n|<<E\nbody\nE\n"],
    [r(1, "a", "body")]],
  ["opener raw text with a continuation is literal", ["a|<<\\\nE\nb\n"],
    [r(1, "a", "<<E"), r(3, "b")]],
  ["opener is only the last field", ["<<E|x\nE\n"],
    [r(1, "<<E", "x"), r(2, "E")]],
  ["error inside a heredoc body ends the heredoc", ["a|<<E\nok\nb",[255],"d\nx|y\nE\nz\n"],
    [e(3, 2, "invalid UTF-8"), r(4, "x", "y"), r(5, "E"), r(6, "z")]],
  ["bare CR inside a heredoc body", ["a|<<E\nb\rc\nE\n"],
    [e(2, 2, "bare CR"), r(3, "E")]],
  ["fields requirement with heredoc", ["%fields 2\na|b|<<E\nx\nE\nc|<<E\ny\nE\n"],
    [e(2, 1, "expected 2 fields, got 3"), r(5, "c", "y")]],
  ["fields error is positioned at the start of a continued record", ["%fields 1\na|\\\nb\nc\n"],
    [e(2, 1, "expected 1 fields, got 2"), r(4, "c")]],
  ["directive text inside a heredoc body is data", ["%fields 1\n<<E\n%fields 2\nE\nx\n"],
    [r(2, "%fields 2"), r(5, "x")]],
  ["spec example", ["# inventory\n%fields 3\napple|3|red\npear|\\x41\\u{1F350}|gr\\\n    een\nfig|2\nnote|1|<<END\ntwo\nlines\nEND\n%sep ;\nkiwi;\\;;\\q|x\nplum;1;purple"],
    [r(3, "apple", "3", "red"), r(4, "pear", "A\ud83c\udf50", "green"), e(6, 1, "expected 3 fields, got 2"), r(7, "note", "1", "two\nlines"), e(12, 9, "unknown escape"), r(13, "plum", "1", "purple")]],
];

const HIDDEN = `import test from 'node:test';
import assert from 'node:assert/strict';
const {RecordReader} = await import('@ROOT@src/reader.js');
const r = (line, ...fields) => ({type: 'record', line, fields});
const e = (line, column, message) => ({type: 'error', line, column, message});
const bytes = parts => Buffer.concat(parts.map(part => Buffer.from(part)));
const feed = chunks => {
  const reader = new RecordReader();
  const out = [];
  for (const chunk of chunks) out.push(...reader.push(chunk));
  return [...out, ...reader.end()];
};

for (const [name, parts, expected] of ${JSON.stringify(CASES)}) {
  const input = bytes(parts);
  test(name, () => assert.deepStrictEqual(feed([input]), expected));
  test(name + ' (any chunking)', () => {
    for (let p = 0; p <= input.length; p++) {
      assert.deepStrictEqual(feed([input.subarray(0, p), new Uint8Array(0), Uint8Array.from(input.subarray(p))]), expected, 'split at byte ' + p);
    }
    assert.deepStrictEqual(feed([...input].map(b => Uint8Array.of(b))), expected, 'one byte per push');
    if (input.length <= 24) {
      for (let p = 1; p < input.length; p++) for (let q = p + 1; q < input.length; q++) {
        assert.deepStrictEqual(feed([input.subarray(0, p), input.subarray(p, q), input.subarray(q)]), expected, 'split at bytes ' + p + ' and ' + q);
      }
    }
  });
}

const push = (reader, part) => reader.push(Buffer.from(part));

test('records are returned by the push that delivers their LF', () => {
  const reader = new RecordReader();
  assert.deepStrictEqual(push(reader, 'a|b'), []);
  assert.deepStrictEqual(push(reader, '\\r'), []);
  assert.deepStrictEqual(push(reader, '\\nc\\\\'), [r(1, 'a', 'b')]);
  assert.deepStrictEqual(push(reader, '\\n'), []);
  assert.deepStrictEqual(push(reader, 'd\\nx|<<E\\nbody\\n'), [r(2, 'cd')]);
  assert.deepStrictEqual(push(reader, 'E'), []);
  assert.deepStrictEqual(push(reader, '\\n%fields 2\\nz\\n'), [r(4, 'x', 'body'), e(8, 1, 'expected 2 fields, got 1')]);
  assert.deepStrictEqual(push(reader, 'last|one'), []);
  assert.deepStrictEqual(reader.end(), [r(9, 'last', 'one')]);
});

test('errors are returned no later than the push that delivers the LF of their line', () => {
  const reader = new RecordReader();
  assert.deepStrictEqual([...push(reader, 'a\\\\qb'), ...push(reader, 'c\\n')], [e(1, 2, 'unknown escape')]);
  assert.deepStrictEqual([...push(reader, '%bogus'), ...push(reader, '\\n')], [e(2, 1, 'unknown directive')]);
  assert.deepStrictEqual([...push(reader, [0x61, 0xFF]), ...push(reader, '\\n')], [e(3, 2, 'invalid UTF-8')]);
  assert.deepStrictEqual([...push(reader, 'x\\r'), ...push(reader, 'y\\n')], [e(4, 2, 'bare CR')]);
  assert.deepStrictEqual([...push(reader, 'p\\\\x4'), ...push(reader, '\\n')], [e(5, 2, 'invalid escape')]);
  assert.deepStrictEqual(reader.end(), []);
});

test('errors found at the end of input are returned by end()', () => {
  let reader = new RecordReader();
  assert.deepStrictEqual(push(reader, 'a|<<E\\nx\\n'), []);
  assert.deepStrictEqual(reader.end(), [e(1, 3, 'unterminated heredoc')]);
  reader = new RecordReader();
  assert.deepStrictEqual(push(reader, 'ok\\nab\\\\'), [r(1, 'ok')]);
  assert.deepStrictEqual(reader.end(), [e(2, 3, 'dangling backslash')]);
});

const MiB = 1048576;
const fill = (unit, tail = '') => unit.repeat(Math.floor((MiB - Buffer.byteLength(tail)) / Buffer.byteLength(unit)));
const timed = (name, text, check) => test('1 MiB one byte per push: ' + name, () => {
  const input = Buffer.from(text);
  assert.ok(input.length <= MiB);
  const reader = new RecordReader();
  const events = [];
  const start = performance.now();
  for (let i = 0; i < input.length; i++) {
    for (const event of reader.push(input.subarray(i, i + 1))) events.push(event);
    if ((i & 4095) === 0 && performance.now() - start > 3000) assert.fail('over 3 seconds after ' + i + ' of ' + input.length + ' bytes');
  }
  events.push(...reader.end());
  assert.ok(performance.now() - start < 3000, 'took ' + Math.round(performance.now() - start) + ' ms');
  check(events);
});

const UNIT = 'abc|d\\\\|e|\\\\u{1F600}\\u00e9|x\\\\\\n  y\\n';
timed('many records', fill(UNIT), events => {
  assert.equal(events.length, Math.floor(MiB / Buffer.byteLength(UNIT)));
  assert.deepStrictEqual(events.at(-1), r(2 * events.length - 1, 'abc', 'd|e', '\\u{1F600}\\u00e9', 'xy'));
});
timed('a heredoc of many lines', 'h|<<END\\n' + fill('body line\\n', 'h|<<END\\nEND\\n') + 'END\\n', events => {
  assert.equal(events.length, 1);
  assert.equal(events[0].fields[1].length, Math.floor((MiB - 12) / 10) * 10 - 1);
});
timed('one long line', fill('field|', '\\n') + '\\n', events => {
  assert.equal(events.length, 1);
  assert.equal(events[0].fields.length, Math.floor((MiB - 1) / 6) + 1);
});
timed('one long continued record', fill('word\\\\\\n  ', 'end\\n') + 'end\\n', events => {
  assert.equal(events.length, 1);
  assert.equal(events[0].fields[0].length, Math.floor((MiB - 4) / 8) * 4 + 3);
});
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

export default {
  id: 'record-stream',
  category: 'streaming parser with chunk boundaries and recovery',
  prompt: '`RecordReader` in src/reader.js only handles the simplest PRS input and breaks when chunks split lines or characters. Make it implement the PRS 2 format specified in docs/FORMAT.md completely and exactly, for any way the input is split into chunks. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['PRS reader for whole lines', files]]),
  solve: root => writeTree(root, {'src/reader.js': REFERENCE}),
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
    // The byte order mark is kept as data.
    root => writeTree(root, {'src/reader.js': REFERENCE.replace('if (this.#first) { this.#first = false; if (cp === 0xFEFF) return; }', 'this.#first = false;')}),
    // Columns count UTF-16 code units.
    root => writeTree(root, {'src/reader.js': REFERENCE.replace('this.#col++;\n    const ch', 'this.#col += cp > 0xFFFF ? 2 : 1;\n    const ch')}),
    // Encoded surrogates are accepted.
    root => writeTree(root, {'src/reader.js': REFERENCE.replace(' if (b === 0xED) this.#hi = 0x9F;', '')}),
    // Continuation lines keep their indentation.
    root => writeTree(root, {'src/reader.js': REFERENCE.replace("if (ch === ' ' || ch === '\\t') return;", '')}),
    // \| always escapes a pipe, whatever the separator.
    root => writeTree(root, {'src/reader.js': REFERENCE.replace("ch === this.#sep || ch === '#'", "ch === this.#sep || ch === '|' || ch === '#'")}),
    // The field count error is positioned at the record's last line.
    root => writeTree(root, {'src/reader.js': REFERENCE.replace("fields.length, this.#recLine)", 'fields.length)')}),
    // Everything is returned by end().
    root => writeTree(root, {'src/reader.js': REFERENCE.replace('return this.#take();\n  }\n\n  end()', 'return [];\n  }\n\n  end()')}),
    // All input kept and copied on every push: quadratic.
    root => writeTree(root, {'src/reader.js': REFERENCE.replace('push(chunk) {', 'push(chunk) {\n    this.all = Buffer.concat([this.all ?? Buffer.alloc(0), chunk]);')}),
    // A visible test edited.
    root => writeTree(root, {'test/reader.test.js': VISIBLE.replace("test('unknown escape'", "test.skip('unknown escape'")}),
  ],
};
