import {lexer} from 'marked';
import {imageDataUrl} from './attachments.mjs';

// Render Marked's tokens with DOM APIs, never its HTML output. Raw HTML stays literal,
// URLs are allowlisted, and remote Markdown images require an explicit click to load.
const node = (doc, tag, text, cls) => {
  const result = doc.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (cls) result.className = cls;
  return result;
};
function decodeEntities(value, doc) {
  const text = String(value ?? '');
  if (!text.includes('&')) return text; // runs for every inline text token: most have no entity and need no decoder element
  let decoder;
  return text.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, entity => {
    decoder ??= doc.createElement('textarea');
    decoder.innerHTML = entity; // entity-shaped strings only, never tags or arbitrary markup
    return decoder.value;
  });
}
export function safeLink(value, doc) {
  const href = decodeEntities(value, doc).trim();
  if (/[\u0000-\u0020\u007f-\u009f]/.test(href)) return null;
  try {
    const url = new URL(href);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function imageElement(doc, src, alt) {
  const img = node(doc, 'img');
  img.src = src; img.alt = alt || 'Image'; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
  img.onerror = () => img.replaceWith(node(doc, 'span', 'Image could not be loaded.', 'image-error'));
  return img;
}
function preview(doc, src, alt) {
  const button = node(doc, 'button', undefined, 'image-preview');
  button.type = 'button'; button.setAttribute('aria-label', 'Enlarge ' + (alt || 'image'));
  button.append(imageElement(doc, src, alt));
  return button;
}
function markdownImage(token, doc) {
  const alt = decodeEntities(token.text, doc), inline = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/.exec(token.href);
  if (inline) {
    try { return preview(doc, imageDataUrl({type: 'image', mimeType: inline[1], data: inline[2]}), alt); } catch { /* show literal syntax below */ }
  }
  const href = safeLink(token.href, doc);
  if (!href || href.startsWith('mailto:')) return doc.createTextNode(token.raw);
  // Click handlers must not capture token strings: they can be slices of this paint's whole source, and renderMarkdown
  // reuses the node in later paints, so the closure would keep that older source alive. They read the DOM's own copy
  // instead (here a detached Text node). href is safe: URL serialization makes a new string.
  const button = node(doc, 'button', 'Load image' + (alt ? ': ' + alt : ''), 'btn quiet markdown-image-load'), label = doc.createTextNode(alt);
  button.type = 'button'; button.title = 'Load external image from ' + new URL(href).host;
  button.onclick = () => button.replaceWith(preview(doc, href, label.data));
  return button;
}
function codeBlock(token, doc) {
  const block = node(doc, 'div', undefined, 'code-block'), head = node(doc, 'div', undefined, 'code-head');
  const copy = node(doc, 'button', 'Copy', 'ghost'); copy.type = 'button'; copy.setAttribute('aria-label', 'Copy code');
  const code = node(doc, 'code', token.text); // the handler reads code.textContent, not token.text: see markdownImage
  copy.onclick = async () => {
    try { await doc.defaultView.navigator.clipboard.writeText(code.textContent); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Could not copy'; }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  };
  head.append(node(doc, 'small', token.lang?.split(/\s+/)[0] || 'Code'), copy);
  const pre = node(doc, 'pre'); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Code block');
  pre.append(code); block.append(head, pre);
  return block;
}
function appendTokens(parent, tokens, doc, depth = 0) {
  for (const token of tokens ?? []) {
    if (depth > 64) { parent.append(doc.createTextNode(token.raw ?? token.text ?? '')); continue; }
    let child;
    switch (token.type) {
      case 'space': continue;
      case 'hr': child = node(doc, 'hr'); break;
      case 'br': child = node(doc, 'br'); break;
      case 'code': child = codeBlock(token, doc); break;
      case 'codespan': child = node(doc, 'code', token.text); break;
      case 'html': child = doc.createTextNode(token.text ?? token.raw); break;
      case 'escape': child = doc.createTextNode(token.text); break;
      case 'text':
        if (token.tokens) { appendTokens(parent, token.tokens, doc, depth + 1); continue; }
        child = doc.createTextNode(decodeEntities(token.text, doc)); break;
      case 'heading': case 'paragraph': case 'strong': case 'em': case 'del': case 'blockquote':
        child = node(doc, {heading: 'h' + token.depth, paragraph: 'p'}[token.type] ?? token.type);
        appendTokens(child, token.tokens, doc, depth + 1); break;
      case 'link': {
        const href = safeLink(token.href, doc);
        child = node(doc, href ? 'a' : 'span');
        if (href) { child.href = href; child.target = '_blank'; child.rel = 'noopener noreferrer'; }
        if (token.title) child.title = decodeEntities(token.title, doc);
        appendTokens(child, token.tokens, doc, depth + 1); break;
      }
      case 'image': child = markdownImage(token, doc); break;
      case 'checkbox':
        child = node(doc, 'input'); child.type = 'checkbox'; child.checked = token.checked; child.disabled = true;
        child.setAttribute('aria-label', token.checked ? 'Completed task' : 'Incomplete task'); break;
      case 'list':
        child = node(doc, token.ordered ? 'ol' : 'ul');
        if (token.ordered) child.start = token.start;
        for (const item of token.items) {
          const li = node(doc, 'li'); if (item.task) li.className = 'task-item';
          appendTokens(li, item.tokens, doc, depth + 1); child.append(li);
        }
        break;
      case 'table': {
        child = node(doc, 'div', undefined, 'markdown-table'); child.tabIndex = 0;
        child.setAttribute('role', 'region'); child.setAttribute('aria-label', 'Table; scroll horizontally if needed');
        const table = node(doc, 'table'), head = node(doc, 'thead'), body = node(doc, 'tbody');
        const row = (cells, heading) => {
          const tr = node(doc, 'tr');
          for (const cell of cells) {
            const td = node(doc, heading ? 'th' : 'td');
            if (heading) td.scope = 'col';
            if (['left', 'center', 'right'].includes(cell.align)) td.style.textAlign = cell.align;
            appendTokens(td, cell.tokens, doc, depth + 1); tr.append(td);
          }
          return tr;
        };
        head.append(row(token.header, true)); for (const cells of token.rows) body.append(row(cells, false));
        table.append(head, body); child.append(table); break;
      }
      default: child = doc.createTextNode(token.raw ?? token.text ?? '');
    }
    parent.append(child);
  }
}
// Streaming repaints one target with a growing source every 50 ms. Each call still lexes the whole source, but keeps the
// top-level nodes of the longest run of leading tokens whose type, raw and text are all unchanged, so a repaint builds
// only the changed tail (and finished blocks keep their selection, Copy state and loaded images). Equal raw alone is not
// enough: what follows a paragraph can change its text but not its raw (an indented line it absorbed keeps its indent,
// but merged in as indented code it loses it). Tokens without text (list, table, hr, space, def) are built from their
// raw alone, inline tokens from the text, and Marked's inline state entering token k (inLink, inRawBlock) follows from
// tokens 0..k-1. appendTokens keeps no state between top-level tokens. Reference links resolve against the whole
// document, so any change to the definitions rebuilds everything. Never lex only the tail: it would start with fresh
// inline state and can render differently.
const rendered = new WeakMap(); // target -> {src, links, types, raws, texts, nodes}; nodes[k] = the top-level nodes made from token k
function untouched(target, prev) { // exactly our nodes, in order, or the cache is void
  let child = target.firstChild;
  for (const list of prev.nodes) for (const node of list) { if (node !== child) return false; child = child.nextSibling; }
  return child === null;
}
export function renderMarkdown(target, source) {
  target.classList.add('markdown');
  const text = String(source ?? '');
  try {
    const doc = target.ownerDocument;
    let prev = rendered.get(target);
    if (prev && !untouched(target, prev)) prev = null;
    if (prev && prev.src === text) return target; // e.g. message_end after text_end: a rebuild would make the same DOM
    const tokens = lexer(text, {gfm: true, breaks: true}), links = JSON.stringify(tokens.links ?? {});
    if (prev && prev.links !== links) prev = null;
    let i = 0;
    if (prev) {
      const n = Math.min(prev.raws.length, tokens.length);
      while (i < n && prev.raws[i] === tokens[i].raw && prev.texts[i] === tokens[i].text && prev.types[i] === tokens[i].type) i++;
      for (let k = i; k < prev.nodes.length; k++) for (const node of prev.nodes[k]) node.remove();
    }
    const nodes = prev ? prev.nodes.slice(0, i) : [], fragment = doc.createDocumentFragment();
    for (let k = i; k < tokens.length; k++) {
      const part = doc.createDocumentFragment();
      appendTokens(part, [tokens[k]], doc); nodes.push([...part.childNodes]); fragment.append(part);
    }
    if (prev) target.append(fragment); else target.replaceChildren(fragment);
    rendered.set(target, {src: text, links, types: tokens.map(token => token.type), raws: tokens.map(token => token.raw),
      texts: tokens.map(token => token.text), nodes}); // this lex's strings: older ones would pin older sources
  } catch { rendered.delete(target); target.textContent = text; }
  return target;
}
// Repaints keep a Thought row's summary and body nodes: a summary replaced every 50 ms drops clicks meant to expand it.
// A live repaint of a closed row updates only the preview; its invisible body renders on opening or on the final paint.
const thoughts = new WeakMap(), deferred = new WeakMap(), listening = new WeakSet(); // row -> {summary, preview, body}; row -> text
function thoughtBody(row, body, text, live) {
  if (!live || row.open) { deferred.delete(row); renderMarkdown(body, text); return; }
  deferred.set(row, text);
  if (listening.has(row)) return;
  listening.add(row);
  row.addEventListener('toggle', () => {
    const kept = thoughts.get(row), later = deferred.get(row);
    if (!row.open || later === undefined) return;
    deferred.delete(row);
    if (kept && row.lastChild === kept.body) renderMarkdown(kept.body, later);
  });
}
// One Pi ThinkingContent {type: 'thinking', thinking, thinkingSignature?, redacted?} as a `Thought` row: a one-line
// preview that expands in place. Anthropic and Bedrock deliver redacted reasoning as placeholder text with
// redacted: true; Codex reasoning without a summary is '' plus an encrypted signature and gets no row (null).
// live (a streaming repaint) may defer the body of a closed row; every final paint passes false and renders it.
export function renderThought(row, part, live = false) {
  if (!part.thinking) return null;
  const doc = row.ownerDocument, trimmed = part.redacted ? '' : part.thinking.trim(), nl = trimmed.indexOf('\n');
  const preview = part.redacted ? 'Redacted by the provider' : (nl < 0 ? trimmed : trimmed.slice(0, nl)).replace(/\*\*|__|`|^#+\s*/g, '');
  row.className = 'step thought';
  const kept = thoughts.get(row);
  if (!part.redacted && kept && row.childNodes.length === 2 && row.firstChild === kept.summary && row.lastChild === kept.body) {
    if (kept.preview.textContent !== preview) kept.preview.textContent = preview;
    thoughtBody(row, kept.body, part.thinking, live);
    return row;
  }
  const summary = node(doc, 'summary'), target = node(doc, 'i', preview, 'target');
  summary.append(node(doc, 'span', 'Thought', 'verb'), target);
  deferred.delete(row); thoughts.delete(row);
  if (part.redacted) {
    row.replaceChildren(summary, node(doc, 'p', 'The provider redacted this reasoning; there is no readable text.', 'step-body thinking-hidden'));
    return row;
  }
  const body = node(doc, 'div', undefined, 'step-body');
  row.replaceChildren(summary, body); thoughts.set(row, {summary, preview: target, body});
  thoughtBody(row, body, part.thinking, live);
  return row;
}
export function renderMessage(target, content) {
  const doc = target.ownerDocument, fragment = doc.createDocumentFragment();
  const parts = typeof content === 'string' ? [{type: 'text', text: content}] : content ?? [];
  let images = null, count = 0;
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      fragment.append(renderMarkdown(node(doc, 'div'), part.text)); images = null;
    } else if (part.type === 'image') {
      if (!images) { images = node(doc, 'div', undefined, 'message-images'); fragment.append(images); }
      try { images.append(preview(doc, imageDataUrl(part), 'Attached image ' + (++count))); }
      catch { images.append(node(doc, 'span', 'Image unavailable (unsupported or invalid image).', 'image-error')); }
    }
  }
  target.replaceChildren(fragment);
  return target;
}
