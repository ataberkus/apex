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
  const decoder = doc.createElement('textarea');
  return String(value ?? '').replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, entity => {
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
  const button = node(doc, 'button', 'Load image' + (alt ? ': ' + alt : ''), 'btn quiet markdown-image-load');
  button.type = 'button'; button.title = 'Load external image from ' + new URL(href).host;
  button.onclick = () => button.replaceWith(preview(doc, href, alt));
  return button;
}
function codeBlock(token, doc) {
  const block = node(doc, 'div', undefined, 'code-block'), head = node(doc, 'div', undefined, 'code-head');
  const copy = node(doc, 'button', 'Copy', 'ghost'); copy.type = 'button'; copy.setAttribute('aria-label', 'Copy code');
  copy.onclick = async () => {
    try { await doc.defaultView.navigator.clipboard.writeText(token.text); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Could not copy'; }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  };
  head.append(node(doc, 'small', token.lang?.split(/\s+/)[0] || 'Code'), copy);
  const pre = node(doc, 'pre'); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Code block');
  pre.append(node(doc, 'code', token.text)); block.append(head, pre);
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
export function renderMarkdown(target, source) {
  target.classList.add('markdown');
  try {
    const fragment = target.ownerDocument.createDocumentFragment();
    appendTokens(fragment, lexer(String(source ?? ''), {gfm: true, breaks: true}), target.ownerDocument);
    target.replaceChildren(fragment);
  } catch { target.textContent = String(source ?? ''); }
  return target;
}
// One Pi ThinkingContent {type: 'thinking', thinking, thinkingSignature?, redacted?} as a `Thought` row: a one-line
// preview that expands in place. Anthropic and Bedrock deliver redacted reasoning as placeholder text with
// redacted: true; Codex reasoning without a summary is '' plus an encrypted signature and gets no row (null).
export function renderThought(row, part) {
  if (!part.thinking) return null;
  const doc = row.ownerDocument, summary = node(doc, 'summary');
  const preview = part.redacted ? 'Redacted by the provider' : part.thinking.trim().split('\n')[0].replace(/\*\*|__|`|^#+\s*/g, '');
  summary.append(node(doc, 'span', 'Thought', 'verb'), node(doc, 'i', preview, 'target'));
  row.className = 'step thought';
  row.replaceChildren(summary, part.redacted ? node(doc, 'p', 'The provider redacted this reasoning; there is no readable text.', 'step-body thinking-hidden')
    : renderMarkdown(node(doc, 'div', undefined, 'step-body'), part.thinking));
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
