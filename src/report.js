import { randomBytes } from 'node:crypto';
import { validateReport, validateReview, reviewEntries } from './review.js';

const STYLE = `
:root{color-scheme:light;--ink:#182334;--muted:#59677b;--line:#dce2ea;--paper:#fff;--bg:#f3f5f8;--accent:#4648c9;--green:#23634d;--red:#a44432}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.45}button,input,select,textarea{border:1px solid var(--line);border-radius:8px}button{background:var(--paper);padding:9px 14px;color:var(--ink)}button:hover:not(:disabled){background:#eef0f8}button.primary{background:var(--accent);color:white;border-color:var(--accent)}button.primary:hover{background:#3537a4}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #a7b5ff;outline-offset:3px}input,select,textarea{background:white;color:var(--ink);padding:10px 12px;min-width:0}textarea{width:100%;resize:vertical;min-height:80px;line-height:1.5}h1,h2,h3,h4,p{margin:0}h1{font-size:clamp(25px,3.5vw,36px);line-height:1.25;letter-spacing:-.035em}h2{font-size:20px;letter-spacing:-.02em}h3{font-size:17px}h4{font-size:14px}small,.muted{color:var(--muted)}pre{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}code{font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.wrap{max-width:1180px;margin:auto;padding:28px 28px 44px}.topbar,.heading,.actions,.card-title,.pager,.field-controls{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:10px;font-weight:750;letter-spacing:-.03em}.brand-mark{display:grid;place-items:center;width:33px;height:33px;background:var(--ink);border-radius:9px;color:white;font-size:20px}.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:650}.offline{font-size:12px;color:var(--green);display:flex;align-items:center;gap:6px}.offline::before{content:"";height:7px;width:7px;background:#438568;border-radius:50%}.heading{margin:28px 0 20px;align-items:flex-start}.heading p{margin-top:9px;color:var(--muted)}.report-meta{text-align:right;font-size:12px;max-width:300px}.report-meta code{display:block;margin-top:5px}.sources{display:grid;grid-template-columns:1fr 1fr;gap:16px}.source{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:18px 20px;min-width:0}.source h2{font-size:17px;overflow-wrap:anywhere;margin:5px 0 10px}.source code{display:block;color:var(--muted);font-size:11px}.source .eyebrow{display:flex;align-items:center;gap:7px}.dot{width:6px;height:6px;border-radius:50%;background:#8491a3}.source.after .dot{background:var(--accent)}.summary{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin:16px 0}.metric{background:var(--paper);padding:15px 16px}.metric strong{display:block;font-size:25px;font-weight:650;letter-spacing:-.04em;line-height:1.3}.metric span{font-size:12px;color:var(--muted)}.metric.added strong{color:var(--green)}.metric.removed strong{color:var(--red)}.notes{font-size:12px;color:var(--muted);line-height:1.75}.notes strong{color:var(--ink);font-weight:600}.warning-box{margin-top:12px;border:1px solid #e9d7b1;background:#fff9ec;border-radius:9px;padding:10px 14px;font-size:13px;color:#705022}.warning-box summary{cursor:pointer}.warning-box ul{padding-left:20px;margin:8px 0 2px;overflow-wrap:anywhere}.review-bar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:30px 0 14px}.review-bar p{color:var(--muted);font-size:13px;margin-top:3px}.actions{gap:8px}.status{margin:0 0 14px;min-height:20px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}.status.error{color:var(--red)}.filters{display:grid;grid-template-columns:minmax(240px,2fr) repeat(3,minmax(125px,1fr));gap:12px;background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px}.control{display:flex;flex-direction:column;gap:5px}.control label{font-size:12px;font-weight:600;color:var(--muted)}.list-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:15px 0;color:var(--muted);font-size:12px}.pager{justify-content:flex-end;gap:8px}.pager button{font-size:12px;padding:6px 10px}.change-list{display:flex;flex-direction:column;gap:14px}.change-card{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:20px;min-width:0}.card-title{align-items:flex-start}.card-title-main{min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:9px}.card-title h3{overflow-wrap:anywhere}.kind,.aspect{display:inline-block;border-radius:5px;font-size:11px;padding:3px 7px;background:#edf0f7;color:#47586e;font-weight:600}.kind.added{background:#eaf5ee;color:var(--green)}.kind.removed{background:#fbeee8;color:var(--red)}.kind.changed{background:#eeedfc;color:var(--accent)}.change-id{font-size:10px;color:var(--muted);max-width:170px;text-align:right;overflow-wrap:anywhere}.context{display:flex;flex-wrap:wrap;gap:8px 20px;margin:10px 0 14px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}.context span{min-width:0}.aspects{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px}.cells{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cell{background:#f8f9fb;border:1px solid #e5e9ef;border-radius:8px;padding:12px 14px;min-width:0}.cell-label{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:11px;font-weight:650;color:var(--muted);margin-bottom:9px}.type{font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;border:1px solid var(--line);border-radius:4px;padding:2px 5px;color:#526076;max-width:50%;overflow-wrap:anywhere}.cell dl{display:grid;grid-template-columns:94px minmax(0,1fr);gap:8px 10px;font-size:12px;margin:0}.cell dt{color:var(--muted)}.cell dd{margin:0;min-width:0}.cache-type{display:block;color:var(--muted);font-size:10px;margin-bottom:2px}.absent{font-size:12px;color:var(--muted);padding:8px 0}.field-list{display:flex;flex-direction:column;gap:12px}.field h4{margin-bottom:6px;overflow-wrap:anywhere}.field-controls{margin-top:10px;font-size:12px;color:var(--muted)}.field-controls .actions button{padding:4px 9px;font-size:12px}.structural-note{font-size:13px;color:var(--muted);padding:4px 0 8px}.comment{border-top:1px solid #e7ebf0;margin-top:16px;padding-top:14px}.comment label{display:block;font-size:12px;font-weight:600;margin-bottom:6px}.comment label span{font-weight:400;color:var(--muted);margin-left:8px}.comment-foot{display:flex;justify-content:space-between;gap:15px;font-size:11px;color:var(--muted);margin-top:5px}.empty{border:1px dashed #c7d0dd;border-radius:12px;text-align:center;padding:48px 20px;color:var(--muted)}.empty h3{color:var(--ink);margin-bottom:5px}.bottom-pager{margin-top:16px}.footer{margin-top:28px;border-top:1px solid var(--line);padding-top:16px;display:flex;justify-content:space-between;gap:20px;font-size:11px;color:var(--muted)}.review-filter{margin-bottom:12px;max-width:280px}.comment select{margin-bottom:12px;max-width:100%}[hidden]{display:none!important}
@media(max-width:950px){.summary{grid-template-columns:repeat(4,1fr)}.filters{grid-template-columns:2fr 1fr}.report-meta{max-width:220px}.metric{padding:12px 14px}}
@media(max-width:600px){.wrap{padding:18px 14px 30px}.brand .eyebrow{display:none}.heading{display:block;margin-top:25px}.report-meta{text-align:left;max-width:none;margin-top:12px}.sources{grid-template-columns:1fr;gap:10px}.source{padding:14px 16px}.summary{grid-template-columns:repeat(3,1fr)}.metric strong{font-size:23px}.metric{padding:12px}.review-bar{display:block;margin-top:24px}.actions{justify-content:flex-start;flex-wrap:wrap}.review-bar .actions{margin-top:12px}.review-bar button{flex:1;white-space:nowrap;padding:9px 10px;font-size:13px}.filters{grid-template-columns:1fr 1fr;gap:10px;padding:13px}.filters .search-control{grid-column:1/-1}.filters input,.filters select{width:100%;font-size:13px}.list-meta{align-items:flex-start;flex-direction:column}.change-card{padding:15px}.card-title{gap:10px}.change-id{max-width:80px}.cells{grid-template-columns:1fr}.cell dl{grid-template-columns:90px minmax(0,1fr)}.comment-foot{display:block}.footer{display:block}.footer span{display:block;margin-top:5px}}
`;

// Only constants and DOM operations live in this function; it is embedded as-is.
function reviewApp(validateReport, validateReview, reviewEntries) {
  'use strict';
  const report = validateReport(JSON.parse(document.getElementById('report-data').textContent));
  const PAGE_SIZE = 100;
  const FIELD_PAGE_SIZE = 20;
  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  const comments = new Map();
  const decisions = new Map();
  const kindLabels = {
    'sheet-added': '新增工作表', 'sheet-removed': '删除工作表',
    'column-added': '新增列', 'column-removed': '删除列',
    'row-added': '新增行', 'row-removed': '删除行', 'cell-changed': '单元格变化',
  };
  const aspectLabels = { value: '值 Value', type: '类型 Type', formula: '公式 Formula', cache: '缓存结果 Cache' };
  const byId = (id) => document.getElementById(id);
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  };
  const displayValue = (value) => value === null ? 'null（空值）' : value === '' ? '""（空字符串）' : String(value);
  const status = (message, error = false) => {
    byId('status').textContent = message;
    byId('status').className = error ? 'status error' : 'status';
  };
  const commentCount = () => Array.from(comments.values()).filter((text) => text.trim()).length;
  const updateCommentCount = () => {
    byId('comment-count').textContent = String(commentCount());
    const accepted = [...decisions.values()].filter((v) => v === 'accepted').length;
    const needsChange = [...decisions.values()].filter((v) => v === 'needs-change').length;
    byId('review-progress').textContent = `${accepted} 已接受 · ${needsChange} 需修改 · ${report.changes.length - accepted - needsChange} 待审`;
  };

  byId('report-id').textContent = report.reportId;
  for (const side of ['before', 'after']) {
    byId(`${side}-name`).textContent = report.sources[side].name;
    byId(`${side}-hash`).textContent = `SHA-256  ${report.sources[side].sha256}`;
  }
  const summaryFields = ['addedRows', 'removedRows', 'changedCells', 'addedColumns', 'removedColumns', 'addedSheets', 'removedSheets'];
  for (const field of summaryFields) byId(field).textContent = report.summary[field].toLocaleString();
  byId('alignment').textContent = report.options.keyColumns.length
    ? `业务键：${report.options.keyColumns.join(' + ')} · 表头行：${report.options.headerRow}`
    : `按位置对齐 · 表头行：${report.options.headerRow}`;
  if (report.warnings.length) {
    byId('warnings').hidden = false;
    byId('warning-count').textContent = `${report.warnings.length} 条比较提示`;
    for (const warning of report.warnings) byId('warning-list').append(el('li', '', warning));
  }
  for (const sheet of [...new Set(report.changes.map((change) => change.sheet))].sort()) {
    const option = el('option', '', sheet);
    option.value = sheet;
    byId('sheet-filter').append(option);
  }

  function renderCell(cell, label) {
    const panel = el('div', 'cell');
    const heading = el('div', 'cell-label');
    heading.append(el('span', '', label));
    if (cell) heading.append(el('span', 'type', cell.type));
    panel.append(heading);
    if (cell === null) {
      panel.append(el('p', 'absent', '此侧不存在该单元格'));
      return panel;
    }
    const details = el('dl');
    const appendValue = (name, content) => {
      details.append(el('dt', '', name));
      const value = el('dd');
      value.append(content);
      details.append(value);
    };
    appendValue('值 Value', el('pre', '', displayValue(cell.value)));
    appendValue('公式 Formula', el('pre', '', cell.formula === null ? '—' : cell.formula));
    const cache = el('div');
    if (cell.cache) {
      cache.append(el('span', 'cache-type', `类型 Type: ${cell.cache.type}`), el('pre', '', displayValue(cell.cache.value)));
    } else cache.append(el('span', 'muted', '—'));
    appendValue('缓存 Cache', cache);
    panel.append(details);
    return panel;
  }

  function renderCells(before, after) {
    const cells = el('div', 'cells');
    cells.append(renderCell(before, 'BEFORE · 之前'), renderCell(after, 'AFTER · 之后'));
    return cells;
  }

  function renderFields(fields) {
    const wrapper = el('div');
    const list = el('div', 'field-list');
    const controls = el('div', 'field-controls');
    const count = el('span');
    const actions = el('div', 'actions');
    const previous = el('button', '', '前 20 个字段');
    const next = el('button', '', '后 20 个字段');
    previous.type = next.type = 'button';
    let fieldPage = 0;
    function draw() {
      list.replaceChildren();
      const start = fieldPage * FIELD_PAGE_SIZE;
      for (const field of fields.slice(start, start + FIELD_PAGE_SIZE)) {
        const entry = el('div', 'field');
        entry.append(el('h4', '', field.column), renderCells(field.before, field.after));
        list.append(entry);
      }
      count.textContent = `字段 ${start + 1}–${Math.min(start + FIELD_PAGE_SIZE, fields.length)} / ${fields.length}`;
      previous.disabled = fieldPage === 0;
      next.disabled = start + FIELD_PAGE_SIZE >= fields.length;
    }
    previous.addEventListener('click', () => { fieldPage--; draw(); });
    next.addEventListener('click', () => { fieldPage++; draw(); });
    actions.append(previous, next);
    controls.append(count, actions);
    wrapper.append(list);
    if (fields.length > FIELD_PAGE_SIZE) wrapper.append(controls);
    draw();
    return wrapper;
  }

  function renderChange(change, index) {
    const card = el('article', 'change-card');
    const heading = el('div', 'card-title');
    const main = el('div', 'card-title-main');
    const tone = change.kind.endsWith('added') ? 'added' : change.kind.endsWith('removed') ? 'removed' : 'changed';
    main.append(el('span', `kind ${tone}`, kindLabels[change.kind]), el('h3', '', change.column || change.sheet));
    heading.append(main, el('code', 'change-id', change.id));
    const context = el('div', 'context');
    context.append(el('span', '', `工作表：${change.sheet}`));
    context.append(el('span', '', change.key === null ? '对齐：按位置' : `业务键：${JSON.stringify(change.key)}`));
    if (change.rowBefore !== null || change.rowAfter !== null) {
      context.append(el('span', '', `行：${change.rowBefore ?? '—'} → ${change.rowAfter ?? '—'}`));
    }
    card.append(heading, context);
    if (change.aspects.length) {
      const aspects = el('div', 'aspects');
      for (const aspect of change.aspects) aspects.append(el('span', 'aspect', aspectLabels[aspect]));
      card.append(aspects);
    }
    if (change.kind === 'cell-changed') card.append(renderCells(change.before, change.after));
    else if (change.fields?.length) card.append(renderFields(change.fields));
    else card.append(el('p', 'structural-note', kindLabels[change.kind] + '；结构差异不计入单元格变化数量。'));

    const comment = el('div', 'comment');
    const decisionLabel = el('label', '', '审阅结论');
    decisionLabel.htmlFor = `decision-${index}`;
    const decision = el('select');
    decision.id = `decision-${index}`;
    for (const [value, title] of [['pending', '待审'], ['accepted', '接受'], ['needs-change', '需修改（请写明原因）']]) {
      const option = el('option', '', title); option.value = value; decision.append(option);
    }
    decision.value = decisions.get(change.id) || 'pending';
    decision.addEventListener('change', () => {
      if (decision.value === 'pending') decisions.delete(change.id);
      else decisions.set(change.id, decision.value);
      updateCommentCount();
      status('审阅结论已更新。导出 JSON 以保存进度。');
    });
    const label = el('label', '', '审阅批注');
    const inputId = `comment-${index}`;
    label.htmlFor = inputId;
    label.append(el('span', '', '可选 · 仅保留在当前页面'));
    const input = el('textarea');
    input.id = inputId;
    input.maxLength = 4000;
    input.rows = 2;
    input.placeholder = '记录问题、判断或需要核实的事项…';
    input.value = comments.get(change.id) || '';
    const foot = el('div', 'comment-foot');
    const length = el('span', '', `${input.value.length} / 4000`);
    foot.append(el('span', '', '批注不写入工作簿。关闭页面前请导出 JSON。'), length);
    input.addEventListener('input', () => {
      if (input.value) comments.set(change.id, input.value);
      else comments.delete(change.id);
      length.textContent = `${input.value.length} / 4000`;
      updateCommentCount();
      status('批注已更新，仅保留在当前页面；请导出以保存。');
    });
    comment.append(decisionLabel, decision, label, input, foot);
    card.append(comment);
    return card;
  }

  const searchable = report.changes.map((change) => JSON.stringify(change).toLocaleLowerCase());
  let filtered = report.changes.map((_, index) => index);
  let page = 0;
  function renderList() {
    const list = byId('change-list');
    list.replaceChildren();
    const start = page * PAGE_SIZE;
    for (const index of filtered.slice(start, start + PAGE_SIZE)) list.append(renderChange(report.changes[index], index));
    byId('empty').hidden = filtered.length > 0;
    byId('result-count').textContent = filtered.length
      ? `显示 ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} / ${filtered.length.toLocaleString()} 条（报告共 ${report.changes.length.toLocaleString()} 条）`
      : `0 条匹配（报告共 ${report.changes.length.toLocaleString()} 条）`;
    for (const location of ['top', 'bottom']) {
      byId(`${location}-page`).textContent = `第 ${page + 1} / ${Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))} 页`;
      byId(`${location}-previous`).disabled = page === 0;
      byId(`${location}-next`).disabled = start + PAGE_SIZE >= filtered.length;
    }
  }
  function filter() {
    const query = byId('search').value.trim().toLocaleLowerCase();
    const kind = byId('kind-filter').value;
    const aspect = byId('aspect-filter').value;
    const sheet = byId('sheet-filter').value;
    const decision = byId('decision-filter').value;
    filtered = [];
    report.changes.forEach((change, index) => {
      if ((!query || searchable[index].includes(query)) && (!kind || change.kind === kind)
        && (!aspect || change.aspects.includes(aspect)) && (!sheet || change.sheet === sheet)
        && (!decision || (decisions.get(change.id) || 'pending') === decision)) filtered.push(index);
    });
    page = 0;
    renderList();
  }
  byId('search').addEventListener('input', filter);
  for (const id of ['kind-filter', 'aspect-filter', 'sheet-filter', 'decision-filter']) byId(id).addEventListener('change', filter);
  for (const location of ['top', 'bottom']) {
    byId(`${location}-previous`).addEventListener('click', () => { page--; renderList(); });
    byId(`${location}-next`).addEventListener('click', () => { page++; renderList(); });
  }

  function buildReview() {
    return validateReview(report, {
      schemaVersion: 2,
      reportId: report.reportId,
      sourceHashes: { before: report.sources.before.sha256, after: report.sources.after.sha256 },
      entries: report.changes.flatMap((change) => {
        const text = comments.get(change.id) || '';
        const decision = decisions.get(change.id) || 'pending';
        return text.trim() || decision !== 'pending' ? [{ changeId: change.id, status: decision, text }] : [];
      }),
    });
  }
  byId('export-review').addEventListener('click', () => {
    try {
      const serialized = JSON.stringify(buildReview(), null, 2);
      const blob = new Blob([serialized], { type: 'application/json' });
      if (blob.size > MAX_FILE_SIZE) throw new Error('审阅 JSON 超过 5 MiB，请减少批注内容。');
      const url = URL.createObjectURL(blob);
      const link = el('a');
      link.href = url;
      link.download = 'sheetdiff-review.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status(`已导出 ${commentCount()} 条批注；请保留这份 JSON 以便继续审阅。`);
    } catch (error) { status(`导出失败：${error.message}`, true); }
  });
  byId('import-review').addEventListener('click', () => byId('review-file').click());
  byId('review-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > MAX_FILE_SIZE) throw new Error('审阅 JSON 文件不能超过 5 MiB。');
      const imported = validateReview(report, JSON.parse(await file.text()));
      const entries = reviewEntries(imported);
      for (const item of entries) {
        comments.set(item.changeId, item.text);
        decisions.set(item.changeId, item.status);
      }
      filter();
      updateCommentCount();
      status(`已导入 ${entries.length} 条审阅记录；同一差异的结论与批注已替换，其余当前记录已保留。`);
    } catch (error) { status(`导入失败，当前批注未改变：${error.message}`, true); }
    finally { event.target.value = ''; }
  });
  updateCommentCount();
  renderList();
}

/** Render a portable offline review. Workbook text is always treated as data. */
export function renderReport(report) {
  validateReport(report);
  const nonce = randomBytes(18).toString('base64');
  const payload = JSON.stringify(report).replace(/[<>&\u2028\u2029]/g, (character) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[character]);
  const script = `const validateReport = ${validateReport.toString()}; const validateReview = ${validateReview.toString()}; const reviewEntries = ${reviewEntries.toString()}; (${reviewApp.toString()})(validateReport, validateReview, reviewEntries);`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>SheetDiff · 离线审阅</title><style nonce="${nonce}">${STYLE}</style></head>
<body><div class="wrap">
<header><div class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">S</span>SheetDiff <span class="eyebrow">Spreadsheet review</span></div><span class="offline">离线 · 只读</span></div>
<div class="heading"><div><h1>每一处变化，都有依据。</h1><p>对照两份表格，审阅值、类型、公式与文件中存储的缓存结果。</p></div><div class="report-meta">报告 ID<code id="report-id"></code></div></div></header>
<section class="sources" aria-label="比较文件"><div class="source"><div class="eyebrow"><span class="dot" aria-hidden="true"></span>Before · 之前</div><h2 id="before-name"></h2><code id="before-hash"></code></div><div class="source after"><div class="eyebrow"><span class="dot" aria-hidden="true"></span>After · 之后</div><h2 id="after-name"></h2><code id="after-hash"></code></div></section>
<section class="summary" aria-label="报告汇总"><div class="metric added"><strong id="addedRows">0</strong><span>新增行</span></div><div class="metric removed"><strong id="removedRows">0</strong><span>删除行</span></div><div class="metric"><strong id="changedCells">0</strong><span>变化单元格</span></div><div class="metric added"><strong id="addedColumns">0</strong><span>新增列</span></div><div class="metric removed"><strong id="removedColumns">0</strong><span>删除列</span></div><div class="metric added"><strong id="addedSheets">0</strong><span>新增工作表</span></div><div class="metric removed"><strong id="removedSheets">0</strong><span>删除工作表</span></div></section>
<div class="notes"><p id="alignment"></p><p><strong>缓存结果是文件内已存储的结果，未重新计算</strong>（stored cached result, not recalculated）。公式与缓存变化分别展示。</p><p>隐私提示：此 HTML 包含文件名、业务键与表格数据。页面不联网；分享或上传报告会分享其中的数据。</p></div>
<details id="warnings" class="warning-box" hidden><summary id="warning-count"></summary><ul id="warning-list"></ul></details>
<main><div class="review-bar"><div><h2>审阅差异</h2><p id="review-progress"></p><p>已有 <span id="comment-count">0</span> 条批注 · 批注不会修改源工作簿</p></div><div class="actions"><button id="import-review" type="button">导入批注 JSON</button><button id="export-review" class="primary" type="button">导出审阅 JSON</button><input id="review-file" type="file" accept=".json,application/json" aria-label="选择审阅 JSON 文件" hidden></div></div>
<div class="control review-filter"><label for="decision-filter">按审阅结论筛选</label><select id="decision-filter"><option value="">全部结论</option><option value="pending">待审</option><option value="accepted">已接受</option><option value="needs-change">需修改</option></select></div>
<p id="status" class="status" role="status" aria-live="polite">结论与批注仅保留在当前页面。关闭前请导出 JSON。需修改的差异必须写明原因；未标记的差异始终为待审。</p>
<section class="filters" aria-label="筛选差异"><div class="control search-control"><label for="search">搜索差异</label><input id="search" type="search" placeholder="业务键、列名、值或公式…"></div><div class="control"><label for="kind-filter">变化类别</label><select id="kind-filter"><option value="">全部类别</option><option value="cell-changed">单元格变化</option><option value="row-added">新增行</option><option value="row-removed">删除行</option><option value="column-added">新增列</option><option value="column-removed">删除列</option><option value="sheet-added">新增工作表</option><option value="sheet-removed">删除工作表</option></select></div><div class="control"><label for="aspect-filter">变化维度</label><select id="aspect-filter"><option value="">全部维度</option><option value="value">值 Value</option><option value="type">类型 Type</option><option value="formula">公式 Formula</option><option value="cache">缓存 Cache</option></select></div><div class="control"><label for="sheet-filter">工作表</label><select id="sheet-filter"><option value="">全部工作表</option></select></div></section>
<div class="list-meta"><span id="result-count" aria-live="polite"></span><nav class="pager" aria-label="顶部差异翻页"><button id="top-previous" type="button">上一页</button><span id="top-page"></span><button id="top-next" type="button">下一页</button></nav></div><div id="change-list" class="change-list"></div><div id="empty" class="empty" hidden><h3>没有符合条件的差异</h3><p>调整筛选条件，或确认两份表格没有变化。</p></div>
<nav class="pager bottom-pager" aria-label="底部差异翻页"><button id="bottom-previous" type="button">上一页</button><span id="bottom-page"></span><button id="bottom-next" type="button">下一页</button></nav></main>
<footer class="footer"><span>SheetDiff · 文件指纹绑定审阅</span><span>当前页面内存保存批注 · 无自动上传 · 无本地持久化</span></footer><noscript>请启用 JavaScript 以查看离线差异和添加批注。此报告不会连接网络。</noscript>
</div><script id="report-data" type="application/json" nonce="${nonce}">${payload}</script><script nonce="${nonce}">${script}</script></body></html>`;
}
