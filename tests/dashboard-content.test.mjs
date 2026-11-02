import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {renderMarkdown, renderMessage, renderThought, safeLink} from '../dashboard/chat-content.mjs';
import * as before from './fixtures/chat-content-d0c6d2b.mjs';
import {fileImageType, imageBytes, imageDataUrl, validateImages, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES} from '../dashboard/attachments.mjs';
import {promptCommand} from '../dashboard/chat-request.mjs';
import {modelCatalog} from '../dashboard/catalog.mjs';

export const PNG = {type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSfUAAAAASUVORK5CYII='};
const imageOfSize = size => {
  const bytes = Buffer.alloc(size); Buffer.from(PNG.data, 'base64').copy(bytes);
  return {...PNG, data: bytes.toString('base64')};
};
function surface(t) {
  const dom = new JSDOM('<main></main>', {url: 'http://localhost:4777'});
  t.after(() => dom.window.close());
  return dom.window.document.querySelector('main');
}

test('Markdown supports headings, emphasis, lists, tasks, quotes, tables, links and literal code', t => {
  const target = surface(t);
  renderMarkdown(target, '# Title\n\n**Bold** *italic* ~~removed~~ `x < y` &amp; &lt;\n\n> A quote\n\n3. Third\n4. Fourth\n\n- [x] Done\n- [ ] Pending\n\n| File | Status |\n| :--- | ---: |\n| a.js | **OK** |\n\n```js\n<script>alert("code")</script>\n  indented\n```\n\n[Docs](https://example.com/?a=1&b=2)\n\nLine one\nLine two');
  assert.equal(target.querySelector('h1').textContent, 'Title');
  assert.equal(target.querySelector('strong').textContent, 'Bold');
  assert.equal(target.querySelector('em').textContent, 'italic');
  assert.equal(target.querySelector('del').textContent, 'removed');
  assert.equal(target.querySelector('code').textContent, 'x < y');
  assert.match(target.textContent, /& </);
  assert.equal(target.querySelector('blockquote').textContent, 'A quote');
  assert.equal(target.querySelector('ol').start, 3);
  assert.deepEqual([...target.querySelectorAll('input')].map(i => [i.checked, i.disabled]), [[true, true], [false, true]]);
  assert.equal(target.querySelector('td strong').textContent, 'OK');
  assert.equal(target.querySelector('td:last-child').style.textAlign, 'right');
  assert.equal(target.querySelector('pre code').textContent, '<script>alert("code")</script>\n  indented');
  assert.equal(target.querySelector('pre').tabIndex, 0);
  assert.equal(target.querySelector('a').rel, 'noopener noreferrer');
  assert.ok(target.querySelector('br'));
});

test('raw HTML, dangerous links and SVG images never become executable DOM', t => {
  const target = surface(t);
  renderMarkdown(target, '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe srcdoc="bad"></iframe>\n\n[run](javascript:alert(1)) [encoded](javascript&#58;alert(1)) [file](file:///C:/secret)\n\n![bad](data:image/svg+xml;base64,PHN2Zy8+)\n\n![bad](javascript:alert(1))');
  assert.equal(target.querySelector('script, iframe, img, a, [onerror]'), null);
  assert.match(target.textContent, /<script>alert\(1\)<\/script>/);
  for (const url of ['javascript:alert(1)', 'java&#x09;script:alert(1)', 'data:text/html,hi', 'file:///x', '//example.com/x', 'https://user:pass@example.com']) assert.equal(safeLink(url, target.ownerDocument), null);
  assert.equal(safeLink('https://example.com/?a=1&amp;b=2', target.ownerDocument), 'https://example.com/?a=1&b=2');
});

test('remote Markdown images load only on explicit action, with a safe URL and no referrer', t => {
  const target = surface(t);
  renderMarkdown(target, '![Screenshot](https://example.com/screen.png)');
  assert.equal(target.querySelector('img'), null);
  target.querySelector('button').click();
  const image = target.querySelector('img');
  assert.equal(image.src, 'https://example.com/screen.png');
  assert.equal(image.referrerPolicy, 'no-referrer');
  assert.equal(image.alt, 'Screenshot');
});

test('native image content and image-only history render as accessible previews in content order', t => {
  const target = surface(t);
  renderMessage(target, [{type: 'text', text: '**Before**'}, PNG, {...PNG, mimeType: 'image/svg+xml'}, {type: 'text', text: 'After'}]);
  assert.deepEqual([...target.children].map(e => e.className), ['markdown', 'message-images', 'markdown']);
  assert.equal(target.querySelector('img').src, imageDataUrl(PNG));
  assert.equal(target.querySelector('.image-preview').getAttribute('aria-label'), 'Enlarge Attached image 1');
  assert.match(target.querySelector('.image-error').textContent, /unavailable/);
  renderMessage(target, [PNG]);
  assert.equal(target.querySelectorAll('img').length, 1);
  assert.equal(target.querySelector('.markdown'), null);
  renderMessage(target, 'Legacy plain text');
  assert.equal(target.querySelectorAll('img').length, 0);
  assert.equal(target.textContent, 'Legacy plain text');
});

test('a Thought row previews the first line and expands to the full Markdown thinking; redacted placeholders say so', t => {
  const doc = surface(t).ownerDocument;
  const row = renderThought(doc.createElement('details'), {type: 'thinking', thinking: '**Checking both files**\n\nThen read `app.js` and decide.'});
  assert.equal(row.open, false);
  assert.equal(row.querySelector('summary .verb').textContent, 'Thought');
  assert.equal(row.querySelector('summary i').textContent, 'Checking both files');
  assert.equal(row.querySelector('.step-body strong').textContent, 'Checking both files');
  assert.equal(row.querySelector('.step-body code').textContent, 'app.js');

  // Anthropic/Bedrock: placeholder text plus redacted: true. Codex without a summary: '' plus an encrypted signature.
  const redacted = renderThought(doc.createElement('details'), {type: 'thinking', thinking: '[Reasoning redacted]', thinkingSignature: 'opaque', redacted: true});
  assert.equal(redacted.querySelector('summary i').textContent, 'Redacted by the provider');
  assert.match(redacted.textContent, /no readable text/);
  assert.ok(!redacted.textContent.includes('opaque'));
  assert.equal(renderThought(doc.createElement('details'), {type: 'thinking', thinking: '', thinkingSignature: '{"encrypted_content":"x"}'}), null);
});

// Streaming repaints reuse the nodes of unchanged leading blocks. The reference is the renderer from before that change
// (fixtures/chat-content-d0c6d2b.mjs), which rebuilt everything on every call.
const seeded = seed => () => { // mulberry32
  seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const BLOCKS = [
  'Setext heading\n===', 'Setext two\n---', 'Paragraph line one\nlazy continuation line', '> Quoted start\nlazy quote continuation\n> back in the quote',
  '- tight one\n- tight two\n- tight three', '- loose one\n\n- loose two\n\n  continued paragraph\n- loose three', '3. third\n4. fourth\n   1. nested\n   2. nested two',
  '1) paren list\n2) second', '- [x] done task\n- [ ] open task', '    indented code\n    second code line', '\tTab code\n',
  'See [the docs][ref], [missing][nope] and [ref] before the definition.', '[ref]: https://example.com/docs "Docs title"', '[ref]: https://example.org/duplicate',
  '| Col A | Col B | C |\n| :--- | :---: | ---: |\n| a1 | **b1** | c1 |\n| a2 | `b2` | c2 |', '| x | y |\n| - | - |\n| 1 |',
  '```js\nconst x = 1 < 2 && "a";\n<script>alert(1)</script>\n```', '~~~\ntilde fence\n~~~', '```python\nfence left open', '```\n',
  '<div class="raw">\n<b>raw HTML block</b>\n</div>', '<!-- an HTML comment -->',
  'Inline <a href="https://x.example">open anchor, then https://example.com/url and www.example.org', 'Closing </a> tag, then https://example.net/path?q=1&r=2',
  'Text with <pre>inline pre *not em*</pre> and <script>x</script> tags', 'Entities: &amp; &lt;tag&gt; &#58; &#x3C; &copy; &bogus; & alone &amp',
  'Hard break  \nnext line\nsoft break', `![remote](https://example.com/a.png "t") ![inline](data:image/png;base64,${PNG.data}) ![bad](javascript:alert(1))`,
  '**bold *nested em* text** ~~strike~~ `code span` _under_ \\*escaped\\* &#42;', '# ATX heading with `code`\n## Second level ##', '***',
  'Line with CRLF\r\ncontinued\r\n\r\n- crlf item\r\n', '[link](https://example.com/a?x=1&amp;y=2) [bad](javascript:alert(1)) <https://auto.example/x> [mail](mailto:a@b.example)',
];
const SEPARATORS = ['\n\n', '\n', '\r\n\r\n', '\n\n\n', '', ' '];
const FUZZ = [...'#  \n\n-*_`>|[]()<&;=1.:~!\\\tax', 'http://', '<a href="y">', '</a>', '&amp;', '&#58;', '[r]: https://r.example', '```', '---', '==='];
function streamDocuments(random, count) {
  const pick = list => list[Math.floor(random() * list.length)], docs = [
    'First para with <a href="x">open anchor\n\nSecond para\n\nThird https://example.com/url para and www.example.org\n\nFourth </a> then https://example.net/after',
    BLOCKS.join('\n\n'),
  ];
  while (docs.length < count) {
    let doc = '';
    if (docs.length % 3) for (let n = 3 + Math.floor(random() * 8); n > 0; n--) doc += pick(BLOCKS) + pick(SEPARATORS);
    else for (let n = 120 + Math.floor(random() * 200); n > 0; n--) doc += pick(FUZZ);
    docs.push(doc);
  }
  return docs;
}

test('streamed Markdown repaints into one target match a fresh render by the previous renderer at every step', t => {
  const doc = surface(t).ownerDocument, random = seeded(0xA9E5), fresh = source => before.renderMarkdown(doc.createElement('div'), source).innerHTML;
  const same = (target, source, label) => { const got = target.innerHTML, want = fresh(source); if (got !== want) assert.equal(got, want, `${label}: ${JSON.stringify(source)}`); };
  let steps = 0;
  for (const source of streamDocuments(random, 64)) {
    const target = doc.createElement('div');
    for (let at = 0; at < source.length;) {
      at = Math.min(source.length, at + 1 + Math.floor(random() ** 2 * 40));
      const prefix = source.slice(0, at), roll = random();
      if (roll < 0.02) target.append(doc.createTextNode('foreign')); // a node renderMarkdown did not make: rebuild
      else if (roll < 0.04) target.firstChild?.remove();
      renderMarkdown(target, prefix); steps++; same(target, prefix, `step ${steps}`);
      if (roll > 0.96) { const first = target.firstChild; renderMarkdown(target, prefix); assert.equal(target.firstChild, first); same(target, prefix, 'repeat'); }
    }
    const final = source.slice(0, source.length >> 1) + 'Corrected tail with [ref] and &amp;\n\n[ref]: https://example.com/late'; // message_end differs
    renderMarkdown(target, final); same(target, final, 'final');
    same(renderMarkdown(doc.createElement('div'), source), source, 'fresh');
  }
  assert.ok(steps > 1800, `only ${steps} steps`);
  const pieces = ['&', 'amp;', '#58;', '#x3C;', '#x09;', 'lt;', 'javascript', ':', 'https://', 'example.com', '/', ' ', '\t', 'a'];
  for (let n = 0; n < 2000; n++) {
    let url = ''; for (let k = Math.floor(random() * 8); k >= 0; k--) url += pieces[Math.floor(random() * pieces.length)];
    assert.equal(safeLink(url, doc), before.safeLink(url, doc), JSON.stringify(url));
  }
});

test('Markdown repaints keep the nodes of finished blocks, skip identical sources and rebuild on new link definitions', t => {
  const target = surface(t);
  renderMarkdown(target, 'Use [docs].\n\n```js\nconst a = 1;\n```\n\nStreaming par');
  const code = target.querySelector('.code-block'), paragraph = target.querySelector('p');
  renderMarkdown(target, 'Use [docs].\n\n```js\nconst a = 1;\n```\n\nStreaming paragraph grows');
  assert.equal(target.querySelector('.code-block'), code);
  assert.equal(target.querySelector('p'), paragraph);
  assert.equal(target.querySelectorAll('p')[1].textContent, 'Streaming paragraph grows');
  const first = target.firstChild, html = target.innerHTML;
  renderMarkdown(target, 'Use [docs].\n\n```js\nconst a = 1;\n```\n\nStreaming paragraph grows');
  assert.equal(target.firstChild, first); assert.equal(target.innerHTML, html);
  renderMarkdown(target, 'Use [docs].\n\n```js\nconst a = 1;\n```\n\nStreaming paragraph grows\n\n[docs]: https://example.com/docs');
  assert.equal(target.querySelector('a').href, 'https://example.com/docs');
  assert.notEqual(target.querySelector('.code-block'), code);
});

test('a live Thought keeps its summary, defers a closed body until opened, and ends like the previous renderer', t => {
  const doc = surface(t).ownerDocument, random = seeded(7), reference = part => before.renderThought(doc.createElement('details'), part);
  for (const source of streamDocuments(random, 9)) {
    const closed = doc.createElement('details'), open = doc.createElement('details'); open.open = true;
    let summary = null;
    for (let at = 0; at < source.length;) {
      at = Math.min(source.length, at + 1 + Math.floor(random() * 30));
      const part = {type: 'thinking', thinking: source.slice(0, at)}, want = reference(part);
      renderThought(closed, part, true); renderThought(open, part, true);
      assert.equal(closed.firstChild.outerHTML, want.firstChild.outerHTML);
      assert.equal(closed.querySelector('.step-body').childNodes.length, 0);
      assert.equal(open.innerHTML, want.innerHTML);
      summary ??= closed.firstChild; assert.equal(closed.firstChild, summary);
    }
    const part = {type: 'thinking', thinking: source};
    assert.equal(renderThought(closed, part).outerHTML, reference(part).outerHTML);
    assert.equal(closed.firstChild, summary);
  }

  const row = doc.createElement('details'), start = {type: 'thinking', thinking: '**Check the'};
  renderThought(row, start, true);
  const kept = row.firstChild, body = row.lastChild;
  assert.equal(row.querySelector('summary i').textContent, 'Check the');
  const later = {type: 'thinking', thinking: '**Check the config**\n\nRead `app.js`.\n\n- one'};
  renderThought(row, later, true);
  assert.equal(row.firstChild, kept); assert.equal(row.lastChild, body);
  assert.equal(row.querySelector('summary i').textContent, 'Check the config');
  assert.equal(body.childNodes.length, 0);
  row.open = true; row.dispatchEvent(new doc.defaultView.Event('toggle'));
  assert.equal(row.outerHTML.replace(' open=""', ''), reference(later).outerHTML);
  renderThought(row, {type: 'thinking', thinking: later.thinking + '\n- two'}, true);
  assert.equal(body.querySelectorAll('li').length, 2, 'an open row repaints live');
  renderThought(row, {type: 'thinking', thinking: 'x', redacted: true}, true);
  assert.equal(row.innerHTML, reference({type: 'thinking', thinking: 'x', redacted: true}).innerHTML);
  assert.equal(renderThought(row, {type: 'thinking', thinking: ''}, true), null);
});

test('valid raster formats are accepted and file type fallbacks are conservative', () => {
  const samples = [['image/png', '\x89PNG\r\n\x1a\n'], ['image/jpeg', '\xff\xd8\xff\xe0'], ['image/gif', 'GIF89a'], ['image/webp', 'RIFF1234WEBP']];
  for (const [mimeType, header] of samples) {
    const image = {type: 'image', mimeType, data: Buffer.from(header, 'latin1').toString('base64')};
    assert.equal(imageBytes(image), header.length);
    assert.deepEqual(validateImages([{...image, name: 'not forwarded', extra: true}]), [image]);
  }
  assert.equal(fileImageType({name: 'PHOTO.JPG', type: ''}), 'image/jpeg');
  assert.equal(fileImageType({name: 'fake.png', type: 'image/svg+xml'}), 'image/svg+xml');
  assert.equal(fileImageType({name: 'notes.txt', type: ''}), '');
});

test('attachment validation rejects invalid base64, mismatched formats, unsupported types, counts and byte limits', () => {
  for (const images of [null, {}, [{...PNG, data: ''}], [{...PNG, data: 'bad!'}], [{...PNG, data: 'AAAA'}], [{...PNG, mimeType: 'image/jpeg'}], [{...PNG, mimeType: 'image/svg+xml'}], [{...PNG, type: 'text'}]]) assert.throws(() => validateImages(images));
  assert.throws(() => validateImages(Array(5).fill(PNG)), /up to 4/);
  assert.throws(() => validateImages([PNG], false), /does not support images/);
  assert.equal(imageBytes(imageOfSize(MAX_IMAGE_BYTES)), MAX_IMAGE_BYTES);
  assert.throws(() => imageBytes(imageOfSize(MAX_IMAGE_BYTES + 1)), /5 MB/);
  const large = imageOfSize(Math.floor(MAX_TOTAL_IMAGE_BYTES / 3) + 1);
  assert.throws(() => validateImages([large, large, large]), /total 10 MB/);
  assert.deepEqual(validateImages([], false), []);
});

test('RPC prompts preserve image content for text+image, image-only and steering messages; text-only stays compatible', () => {
  const session = {status: 'idle', input: ['text', 'image']};
  assert.deepEqual(promptCommand({message: 'Inspect this', images: [PNG]}, session), {type: 'prompt', message: 'Inspect this', images: [PNG]});
  assert.deepEqual(promptCommand({message: '', images: [PNG]}, {...session, status: 'running'}), {type: 'prompt', message: '', images: [PNG], streamingBehavior: 'steer'});
  assert.deepEqual(promptCommand({message: 'hello'}, {status: 'idle', input: ['text']}), {type: 'prompt', message: 'hello'});
  assert.deepEqual(promptCommand({message: 'later', mode: 'followUp'}, {...session, status: 'running'}), {type: 'prompt', message: 'later', streamingBehavior: 'followUp'});
  assert.deepEqual(promptCommand({message: 'now', mode: 'bogus'}, {...session, status: 'running'}), {type: 'prompt', message: 'now', streamingBehavior: 'steer'});
  assert.deepEqual(promptCommand({message: 'idle', mode: 'followUp'}, session), {type: 'prompt', message: 'idle'});
  assert.throws(() => promptCommand({message: ''}, session), /Write a message/);
  assert.throws(() => promptCommand({message: 'x'.repeat(100001)}, session), /100,000/);
  assert.throws(() => promptCommand({message: 'x', images: [PNG]}, {status: 'idle', input: ['text']}), /does not support images/);
  assert.throws(() => promptCommand({message: 'x', images: [PNG]}, {status: 'idle'}), /does not support images/);
  assert.throws(() => promptCommand({message: 'x'}, {...session, status: 'done'}), /ended/);
});

test('dashboard models come from each login provider catalog, the Windows default first, and unknown capabilities fail closed', () => {
  const catalogs = {
    'openai-codex': [{id: 'gpt-6-luna', name: 'GPT-6 Luna', input: ['text', 'image']}, {id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', input: ['text', 'image']}],
    anthropic: [{id: 'claude-opus-5-5', name: 'Claude Opus 5.5', input: ['text', 'image']}],
    'opencode-go': [{id: 'kimi-k3', name: 'Kimi K3'}],
  };
  const runtime = {getModels: provider => catalogs[provider] ?? [], getModel: () => undefined};
  const models = modelCatalog(runtime);
  assert.deepEqual(models.map(m => m.id), ['anthropic/claude-opus-5-5', 'openai-codex/gpt-6-luna', 'sol', 'opencode-go/kimi-k3', 'muse']);
  assert.deepEqual(models.map(m => m.input), [['text', 'image'], ['text', 'image'], ['text', 'image'], ['text'], ['text']]);
  const claude = models.find(m => m.provider === 'anthropic');
  assert.deepEqual([claude.model, claude.label, claude.group, claude.target], ['claude-opus-5-5', 'Claude Opus 5.5', 'Claude', 'windows']);
  assert.equal(models.find(m => m.id === 'sol').label, 'GPT-6.1 Sol');
  assert.ok(models.filter(m => m.provider !== 'openrouter').every(m => m.apex === (process.platform === 'win32') && m.unavailable.includes('route')));
});
