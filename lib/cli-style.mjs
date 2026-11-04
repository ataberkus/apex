/**
 * Styling for Apex's own terminal output, after oh-my-pi's dark theme: amber accent, gray muted/dim text,
 * rounded `╭╮╰╯` frames with `├┤` junctions. Rich output needs a color-capable TTY without NO_COLOR or
 * TERM=dumb; otherwise every helper emits plain ASCII text with no escape codes and no line limit.
 */

// Token -> [truecolor hex, 256-color index, 16-color SGR]; values follow oh-my-pi's dark.json.
const PALETTE = {
  accent: ['#febc38', 214, 33], border: ['#178fb9', 31, 36], muted: ['#777d88', 244, 90], dim: ['#5f6673', 242, 90],
  success: ['#89d281', 114, 32], warning: ['#e4c00f', 178, 33], error: ['#fc3a4b', 203, 31],
};
const MAX_WIDTH = 100;
// Glyphs stay within fonts every Windows console ships (Consolas, Cascadia): box drawing, Latin-1 and basic shapes.
const UNICODE = {h: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯', l: '├', r: '┤', bullet: '•', dot: '·', ellipsis: '…', bar: '━', on: '●', off: '○', warn: '!', fail: '×'};

function sgr(token, depth) {
  const [hex, index, basic] = PALETTE[token];
  if (depth >= 24) return `38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;
  return depth >= 8 ? `38;5;${index}` : String(basic);
}

/** Decide rich or plain output once per stream. */
export function createStyle(stream = process.stdout, env = process.env) {
  const rich = Boolean(stream?.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb' && (stream.hasColors?.(env) ?? false);
  const depth = rich ? stream.getColorDepth(env) : 1;
  const paint = (token, text, bold = false) => {
    if (!rich || text === '') return text;
    const codes = [...(bold ? ['1'] : []), ...(token ? [sgr(token, depth)] : [])];
    return codes.length ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text;
  };
  // One spare column: writing the last column makes some consoles wrap early.
  return {rich, width: rich ? Math.min((stream.columns || 80) - 1, MAX_WIDTH) : Infinity, glyph: rich ? UNICODE : null, paint};
}

/** Replace terminal control characters in untrusted text (session data) so it cannot emit escape sequences. */
export const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '?');

/** A styled fragment; a line is an array of spans. */
export const span = (text, token, bold = false) => ({text: String(text), token, bold});
export const plainText = line => line.map(part => part.text).join('');
export const visibleWidth = text => [...text].length;
export const renderLine = (style, line) => line.map(part => style.paint(part.token, part.text, part.bold)).join('');

/** Cut a line to `max` columns, marking the cut with an ellipsis. */
export function truncateLine(style, line, max) {
  if (visibleWidth(plainText(line)) <= max) return line;
  const out = []; let left = max - 1;
  for (const part of line) {
    const chars = [...part.text];
    if (chars.length <= left) {out.push(part); left -= chars.length; continue;}
    if (left > 0) out.push({...part, text: chars.slice(0, left).join('')});
    break;
  }
  out.push(span(style.glyph?.ellipsis ?? '~', 'dim'));
  return out;
}

/** Word-wrap plain text to `max` columns; words longer than a line are split. */
export function wrapText(text, max) {
  if (!Number.isFinite(max) || visibleWidth(text) <= max) return [text];
  const lines = []; let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (visibleWidth(rest) > max) {
      if (current) {lines.push(current); current = '';}
      lines.push([...rest].slice(0, max).join('')); rest = [...rest].slice(max).join('');
    }
    if (!current) current = rest;
    else if (visibleWidth(current) + 1 + visibleWidth(rest) <= max) current += ' ' + rest;
    else {lines.push(current); current = rest;}
  }
  if (current) lines.push(current);
  return lines;
}

/** Highlight `--flags` inside prose with the accent color. */
export const prose = text => text.split(/(--[a-z][a-z-]*)/).filter(Boolean).map(part => part.startsWith('--') ? span(part, 'accent') : span(part));

/**
 * Align cells into columns. Each row is an array of cells (a span array or a string); `align` holds 'left' or
 * 'right' per column. Trailing padding is dropped, so lines carry no trailing spaces.
 */
export function table(rows, align = []) {
  const cells = rows.map(row => row.map(cell => typeof cell === 'string' ? [span(cell)] : cell));
  const widths = [];
  for (const row of cells) row.forEach((cell, i) => {widths[i] = Math.max(widths[i] ?? 0, visibleWidth(plainText(cell)));});
  return cells.map(row => {
    const line = row.flatMap((cell, i) => {
      const pad = ' '.repeat(widths[i] - visibleWidth(plainText(cell)));
      return [...(align[i] === 'right' ? [span(pad), ...cell] : [...cell, span(pad)]), ...(i < row.length - 1 ? [span('  ')] : [])];
    });
    while (line.length && line.at(-1).text.trim() === '') line.pop();
    return line;
  });
}

/**
 * Render titled sections. Rich output draws one rounded frame with a divider per section and truncates lines
 * to the frame; plain output prints each title followed by its lines indented two spaces.
 */
export function renderDocument(style, {title, sections}) {
  if (!style.rich) {
    const out = [title];
    for (const section of sections) {
      out.push('');
      if (section.title) out.push(section.note ? `${section.title} (${section.note})` : section.title);
      for (const line of section.lines) out.push('  ' + plainText(line));
    }
    return out.join('\n');
  }
  const g = style.glyph; const border = text => style.paint('dim', text);
  const natural = Math.max(...sections.flatMap(section => section.lines.map(line => visibleWidth(plainText(line)) + 4)),
    ...sections.map(section => visibleWidth(section.title) + (section.note ? visibleWidth(section.note) + 3 : 0) + 6), visibleWidth(title) + 6);
  const width = Math.max(Math.min(Math.max(natural, 60), style.width), 24); const inner = width - 4;
  const rule = (left, right, head) => {
    const label = truncateLine(style, head, width - 6);
    return border(left + g.h + ' ') + renderLine(style, label) + ' ' + border(g.h.repeat(width - 5 - visibleWidth(plainText(label))) + right);
  };
  const out = [rule(g.tl, g.tr, [span(title, 'accent', true)])];
  sections.forEach((section, index) => {
    if (index > 0 || section.title) {
      out.push(rule(g.l, g.r, [span(section.title, undefined, true), ...(section.note ? [span(` ${g.dot} ${section.note}`, 'muted')] : [])]));
    }
    for (const line of section.lines) {
      const fitted = truncateLine(style, line, inner);
      out.push(border(g.v) + ' ' + renderLine(style, fitted) + ' '.repeat(inner - visibleWidth(plainText(fitted))) + ' ' + border(g.v));
    }
  });
  out.push(border(g.bl + g.h.repeat(width - 2) + g.br));
  return out.join('\n');
}

/** Error line for stderr: a red `error` label when rich, the bare message when plain. */
export function formatError(style, message) {
  return style.rich ? `${style.paint('error', `${style.glyph.fail} error`, true)} ${message}` : message;
}
