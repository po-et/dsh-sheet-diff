import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderReport } from '../src/report.js';

const cell = (value, type = 'string', formula = null, cache = null) => ({ type, value, formula, cache });
function fixture(changes = []) {
  const count = (kind) => changes.filter((item) => item.kind === kind).length;
  return {
    schemaVersion: 1, reportId: 'report-01',
    sources: { before: { name: 'Before.csv', sha256: 'a'.repeat(64) }, after: { name: 'After.csv', sha256: 'b'.repeat(64) } },
    options: { keyColumns: ['id'], headerRow: 1, sheet: null },
    summary: { addedRows: count('row-added'), removedRows: count('row-removed'), changedCells: count('cell-changed'), addedColumns: count('column-added'), removedColumns: count('column-removed'), addedSheets: count('sheet-added'), removedSheets: count('sheet-removed') },
    warnings: [], changes,
  };
}
function change(index = 1, overrides = {}) {
  return { id: `change-${index}`, kind: 'cell-changed', sheet: 'Orders', key: [String(index)], column: 'amount',
    before: cell(1, 'number'), after: cell(2, 'number'), rowBefore: index + 1, rowAfter: index + 1, aspects: ['value'], ...overrides };
}
function scripts(html) {
  const payload = html.match(/<script id="report-data"[^>]*>([\s\S]*?)<\/script>/)[1];
  const app = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  return { payload, app };
}

// Minimal DOM lets the embedded, dependency-free browser app run in Node.
class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  async dispatch(event) { return this.listeners[event]?.({ target: this }); }
  click() { this.clicked = true; this.listeners.click?.({ target: this }); }
  remove() { this.removed = true; }
}
function browser(report) {
  const html = renderReport(report);
  const { payload, app } = scripts(html);
  const nodes = new Map();
  for (const id of html.matchAll(/id="([^"]+)"/g)) nodes.set(id[1], new Node());
  nodes.get('report-data').textContent = payload;
  const body = new Node('body');
  const downloads = [];
  const revoked = [];
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id), createElement: (tag) => new Node(tag), body },
    Blob, TextEncoder, URL: { createObjectURL: (blob) => { downloads.push(blob); return 'blob:review'; }, revokeObjectURL: (url) => revoked.push(url) },
    setTimeout: (callback) => callback(),
  });
  vm.runInContext(app, context);
  return { html, nodes, body, downloads, revoked };
}
function walk(node, predicate) {
  return [node, ...node.children.flatMap((child) => walk(child, predicate))].filter(predicate);
}
const allText = (node) => walk(node, () => true).map((item) => item.textContent).join('\n');

test('escapes hostile workbook content in embedded JSON without changing data', () => {
  const hostile = '</script><img src=x onerror=alert(1)>\u2028\u2029 & <svg/onload=alert(2)>';
  const report = fixture([change(1, { column: hostile, before: cell(hostile), after: cell('safe'), sheet: hostile, key: [hostile] })]);
  report.sources.before.name = hostile;
  report.warnings = [hostile];
  const { html, nodes } = browser(report);
  const { payload, app } = scripts(html);
  assert.equal((html.match(/<script /g) || []).length, 2);
  assert.ok(!payload.includes('<'));
  assert.ok(!payload.includes('&'));
  assert.deepEqual(JSON.parse(payload), report);
  assert.equal(nodes.get('before-name').textContent, hostile);
  assert.ok(allText(nodes.get('change-list')).includes(hostile));
  assert.ok(allText(nodes.get('warning-list')).includes(hostile));
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|fetch\(|XMLHttpRequest|localStorage|sessionStorage/);
  assert.doesNotMatch(html, /<link\b|<img\b|<iframe\b|<script[^>]+src=/);
});

test('has a nonce CSP, explicit cached-result warning, and data-sharing notice', () => {
  const html = renderReport(fixture());
  const nonce = html.match(/<style nonce="([^"]+)"/)[1];
  assert.ok(nonce.length >= 24);
  assert.ok(html.includes(`script-src 'nonce-${nonce}'`));
  assert.ok(html.includes(`style-src 'nonce-${nonce}'`));
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /stored cached result, not recalculated/);
  assert.match(html, /此 HTML 包含文件名、业务键与表格数据/);
  assert.match(html, /分享或上传报告会分享其中的数据/);
});

test('keeps report summary counts distinct and displays value, formula, cache and type', () => {
  const report = fixture([
    change(1, { aspects: ['value', 'type', 'formula', 'cache'], before: cell(null, 'formula', '=SUM(A1:A2)', { type: 'number', value: 10 }), after: cell(null, 'formula', '=SUM(A1:A3)', { type: 'error', value: '#VALUE!' }) }),
    ...Array.from({ length: 7 }, (_, index) => change(index + 2, { kind: 'row-added', column: null, before: null, after: null, rowBefore: null, aspects: [] })),
  ]);
  const { nodes } = browser(report);
  assert.equal(nodes.get('addedRows').textContent, '7');
  assert.equal(nodes.get('changedCells').textContent, '1');
  assert.equal(nodes.get('change-list').children.length, 8);
  const text = allText(nodes.get('change-list'));
  for (const label of ['值 Value', '类型 Type', '公式 Formula', '缓存结果 Cache', '=SUM(A1:A2)', '=SUM(A1:A3)', '类型 Type: number', '类型 Type: error', '#VALUE!']) assert.ok(text.includes(label), label);
});

test('bounds 10,000 changes to 100 DOM cards and preserves comments through pages and filters', async () => {
  const report = fixture(Array.from({ length: 10_000 }, (_, index) => change(index + 1)));
  const { nodes } = browser(report);
  assert.equal(nodes.get('change-list').children.length, 100);
  const textarea = walk(nodes.get('change-list'), (node) => node.tag === 'textarea')[0];
  textarea.value = '核实金额';
  await textarea.dispatch('input');
  assert.equal(nodes.get('comment-count').textContent, '1');
  await nodes.get('top-next').dispatch('click');
  assert.equal(nodes.get('change-list').children.length, 100);
  assert.match(nodes.get('top-page').textContent, /2 \/ 100/);
  await nodes.get('top-previous').dispatch('click');
  assert.equal(walk(nodes.get('change-list'), (node) => node.tag === 'textarea')[0].value, '核实金额');
  nodes.get('search').value = 'change-10000';
  await nodes.get('search').dispatch('input');
  assert.equal(nodes.get('change-list').children.length, 1);
  nodes.get('aspect-filter').value = 'formula';
  await nodes.get('aspect-filter').dispatch('change');
  assert.equal(nodes.get('change-list').children.length, 0);
  assert.equal(nodes.get('empty').hidden, false);
});

test('row fields are separately bounded and retain before/after values', async () => {
  const fields = Array.from({ length: 55 }, (_, index) => ({ column: `field-${index + 1}`, before: null, after: cell(index + 1, 'number') }));
  const { nodes } = browser(fixture([change(1, { kind: 'row-added', column: null, before: null, after: null, aspects: [], fields })]));
  const list = nodes.get('change-list');
  assert.equal(walk(list, (node) => node.className === 'field').length, 20);
  assert.ok(allText(list).includes('field-20'));
  assert.ok(!allText(list).includes('field-21'));
  await walk(list, (node) => node.tag === 'button' && node.textContent === '后 20 个字段')[0].dispatch('click');
  assert.ok(allText(list).includes('field-21'));
  assert.ok(allText(list).includes('field-40'));
  assert.equal(walk(list, (node) => node.className === 'field').length, 20);
});

test('exports a validated Review JSON bound to report ID and source hashes', async () => {
  const { nodes, downloads, body, revoked } = browser(fixture([change()]));
  const textarea = walk(nodes.get('change-list'), (node) => node.tag === 'textarea')[0];
  textarea.value = 'Check <script> text & formula';
  await textarea.dispatch('input');
  await nodes.get('export-review').dispatch('click');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].type, 'application/json');
  assert.deepEqual(JSON.parse(await downloads[0].text()), {
    schemaVersion: 1, reportId: 'report-01', sourceHashes: { before: 'a'.repeat(64), after: 'b'.repeat(64) },
    comments: [{ changeId: 'change-1', text: 'Check <script> text & formula' }],
  });
  assert.equal(body.children[0].download, 'sheetdiff-review.json');
  assert.equal(body.children[0].href, 'blob:review');
  assert.equal(body.children[0].clicked, true);
  assert.equal(body.children[0].removed, true);
  assert.deepEqual(revoked, ['blob:review']);
});

test('imports safe comment text and rejects mismatched, unknown, duplicate and oversized sidecars atomically', async () => {
  const { nodes } = browser(fixture([change()]));
  const base = { schemaVersion: 1, reportId: 'report-01', sourceHashes: { before: 'a'.repeat(64), after: 'b'.repeat(64) }, comments: [{ changeId: 'change-1', text: '</textarea><script>alert(1)</script>' }] };
  const input = nodes.get('review-file');
  const load = async (review, size) => {
    const serialized = JSON.stringify(review);
    input.files = [{ size: size ?? serialized.length, text: async () => serialized }];
    await input.dispatch('change');
  };
  await load(base);
  assert.equal(walk(nodes.get('change-list'), (node) => node.tag === 'textarea')[0].value, base.comments[0].text);
  for (const invalid of [
    { ...base, reportId: 'different' },
    { ...base, sourceHashes: { ...base.sourceHashes, after: 'c'.repeat(64) } },
    { ...base, comments: [{ changeId: 'unknown', text: 'bad' }] },
    { ...base, comments: [base.comments[0], base.comments[0]] },
    { ...base, comments: [{ changeId: 'change-1', text: 'x'.repeat(4001) }] },
    { ...base, extra: true },
  ]) {
    await load(invalid);
    assert.match(nodes.get('status').textContent, /导入失败/);
    assert.equal(walk(nodes.get('change-list'), (node) => node.tag === 'textarea')[0].value, base.comments[0].text);
  }
  await load(base, 5 * 1024 * 1024 + 1);
  assert.match(nodes.get('status').textContent, /5 MiB/);
  assert.equal(input.value, '');
});
