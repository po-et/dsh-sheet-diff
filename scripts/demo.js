import ExcelJS from 'exceljs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { compareBuffers } from '../src/compare.js';
import { renderReport } from '../src/report.js';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1] || args[1].startsWith('--'))) {
  throw new Error('Usage: node scripts/demo.js [--out NEW_DIRECTORY]');
}

// Synthetic data only. No customer workbook is used in the demo.
async function workbook(columns, rows) {
  const book = new ExcelJS.Workbook();
  book.created = new Date('2026-01-01T00:00:00Z');
  book.modified = book.created;
  const sheet = book.addWorksheet('Orders');
  sheet.addRow(columns);
  for (const row of rows) sheet.addRow(columns.map(column => row[column]));
  sheet.getRow(1).font = { bold: true };
  return Buffer.from(await book.xlsx.writeBuffer());
}
const rows = [
  { OrderID: 'ORD-101', Customer: 'Northwind', Amount: 1200, Tax: { formula: '1200*0.06', result: 72 }, Status: 'open' },
  { OrderID: 'ORD-102', Customer: 'Acme', Amount: 800, Tax: 48, Status: 'open' },
  { OrderID: 'ORD-103', Customer: 'Contoso', Amount: 350, Tax: 21, Status: 'paid' },
  { OrderID: 'ORD-104', Customer: 'Fabrikam', Amount: 500, Tax: 30, Status: 'open' },
];
const before = await workbook(['OrderID', 'Customer', 'Amount', 'Tax', 'Status'], rows);
const after = await workbook(['Status', 'Amount', 'OrderID', 'Tax', 'Customer'], [
  rows[2], { ...rows[0], Amount: 1450, Tax: { formula: '1450*0.06', result: 87 } },
  { ...rows[1], Amount: 920 }, { ...rows[3], Amount: '500' },
  { OrderID: 'ORD-105', Customer: 'Adventure Works', Amount: 270, Tax: 16.2, Status: 'open' },
  { OrderID: 'ORD-106', Customer: 'Woodgrove', Amount: 110, Tax: 6.6, Status: 'open' },
  { OrderID: 'ORD-107', Customer: 'Tailspin', Amount: 680, Tax: 40.8, Status: 'open' },
]);
const report = await compareBuffers(before, after, { beforeName: 'orders-before.xlsx', afterName: 'orders-after.xlsx', keyColumns: ['OrderID'] });
const guide = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>SheetDiff · 两分钟审阅体验 / Try a review</title>
<style>
:root{color-scheme:light;font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182334;background:#f3f5f8}*{box-sizing:border-box}body{margin:0}main{max-width:820px;margin:auto;padding:44px 24px 60px}h1{font-size:clamp(28px,5vw,42px);line-height:1.2;letter-spacing:-.03em;margin:16px 0}h2{font-size:21px;margin:0 0 14px}p{margin:10px 0}.brand{font-weight:750}.eyebrow{font-size:13px;color:#59677b}.en{display:block;color:#59677b;font-size:14px;margin-top:5px}section{background:#fff;border:1px solid #dce2ea;border-radius:12px;padding:24px;margin-top:24px}a{color:#383bb6;text-underline-offset:3px}.start{display:inline-block;background:#4648c9;color:#fff;border-radius:8px;padding:12px 18px;margin-top:12px;font-weight:650;text-decoration:none}a:focus-visible{outline:3px solid #8e9cff;outline-offset:4px}li{padding-left:4px;margin:0 0 18px}li:last-child{margin-bottom:0}code{background:#edf0f7;border-radius:4px;padding:2px 5px;font-size:.9em;overflow-wrap:anywhere}ul.files{list-style:none;padding:0}ul.files li{margin:10px 0;padding:0}.note{font-size:14px;color:#59677b}.privacy{border-left:3px solid #438568;padding-left:14px;margin:22px 0}footer{margin-top:28px;font-size:14px;color:#59677b}footer a{margin-right:16px}
</style></head><body><main>
<div class="brand">SheetDiff <span class="eyebrow">Synthetic sample · 合成样例</span></div>
<h1>找出一处不该发生的改动。</h1>
<p lang="en">Catch one spreadsheet change before accepting it.</p>
<p>这份订单表被重新排序，还修改了金额、公式和数据类型。试着找出其中一个问题，留下理由，再保存并恢复你的审阅。
<span class="en" lang="en">The revised orders have reordered rows and columns, changed amounts and a formula, and one changed data type. Find that type change, request a correction, then save and restore your review.</span></p>
<a class="start" href="report.html">打开示例审阅 / Open sample review</a>
<div class="privacy">无需安装、登录或 API Key。全部是合成订单，没有上传入口，也不发送分析事件。
<span class="en" lang="en">No installation, login or API key. All orders are synthetic. This demo has no upload control or analytics. Opening the hosted page still uses its normal web hosting connection.</span></div>
<section aria-labelledby="task"><h2 id="task">两分钟任务 / A two-minute review</h2>
<ol>
<li><strong>搜索 <code>ORD-104</code>。</strong> 查看 <code>Amount</code>：数值 <code>500</code> 变成了文本 <code>"500"</code>。显示相似，类型不同。
<span class="en" lang="en">Search for ORD-104. Its Amount changed from the number 500 to the text "500". The displayed amount looks similar, but its type changed.</span></li>
<li><strong>选择“需修改”，写下原因。</strong> 例如：“请保留数值类型，后续还要汇总金额。”其余改动保持待审。
<span class="en" lang="en">Choose “需修改” (needs change) and add a reason, such as “Keep Amount numeric so it can be summed.” Leave the other changes pending.</span></li>
<li><strong>导出审阅 JSON。</strong> 保存下载的 <code>sheetdiff-review.json</code>。审阅结论不会写回 Excel，页面关闭后也不会自动保存。
<span class="en" lang="en">Export the review JSON and keep sheetdiff-review.json. Decisions do not modify the workbook and are not automatically saved when you close the page.</span></li>
<li><strong>重新打开报告，再导入这份 JSON。</strong> 检查你的“需修改”和原因是否恢复。
<span class="en" lang="en">Reopen the report, import the exported JSON, and check that your decision and reason return.</span></li>
</ol>
<p class="note">样例预期：3 条新增记录、4 处单元格变化，其中包括 1 处类型变化和 1 处公式及缓存变化。行列重排不计作修改。
<span class="en" lang="en">Expected: 3 added rows and 4 changed cells, including one type change and one formula/cache change. Row and column reordering does not count as a change.</span></p></section>
<section aria-labelledby="files"><h2 id="files">核对样例 / Inspect the files</h2>
<p class="note">报告由下面两份文件通过 SheetDiff 实际比较生成，没有预先替你批准任何改动。
<span class="en" lang="en">SheetDiff generated the report by comparing these workbooks. No change has been approved for you.</span></p>
<ul class="files"><li><a href="orders-before.xlsx" download>原始工作簿 / Original workbook</a></li>
<li><a href="orders-after.xlsx" download>修改后工作簿 / Revised workbook</a></li>
<li><a href="report.json" download>比较结果 JSON / Comparison data</a></li>
<li><a href="README.txt">离线使用说明 / Offline instructions</a></li></ul>
<p class="note">下载完整目录或样例 ZIP 后，直接打开 <code>index.html</code> 或 <code>report.html</code>；离线审阅不需要服务器。
<span class="en" lang="en">After downloading the complete directory or sample ZIP, open index.html or report.html directly. Offline review needs no server.</span></p></section>
<footer><a href="https://github.com/po-et/dsh-sheet-diff">使用你自己的表格 / Use your own files</a><a href="https://github.com/po-et/dsh-sheet-diff/issues/1">反馈一次实际体验 / Share what worked or broke</a>
<p>反馈时请说明卡在哪一步；不要上传机密工作簿。 / Tell us which step worked or failed. Do not post confidential workbooks.</p></footer>
</main></body></html>
`;
const instructions = `SheetDiff synthetic review sample / SheetDiff 合成审阅样例

Open index.html for the guided task, or report.html for the interactive report.
打开 index.html 查看引导；打开 report.html 开始审阅。
The complete directory works offline without a server, installation or API key.
完整目录可以离线使用，不需要服务器、安装程序或 API Key。

All workbook records are synthetic. The report was produced by SheetDiff's real
comparison and report renderer. It contains no preset decisions or comments.
所有订单均为合成数据；报告由真实比较与渲染生成，没有预设审阅结论或批注。

Try: search ORD-104, inspect Amount's number-to-text change, choose needs-change,
write a reason, export sheetdiff-review.json, reopen the report, and import it.
试一试：搜索 ORD-104，检查 Amount 从数值到文本的变化，选择需修改并写原因，
导出 sheetdiff-review.json，重新打开报告，再导入以恢复审阅。

Keep your exported JSON before closing the page. Decisions remain in browser
memory until exported. No spreadsheet is edited. No data or analytics is sent
by the report. Visiting repository/feedback links needs a network connection.
关闭页面前请导出 JSON；页面不会自动保存进度、修改表格、上传数据或发送分析事件。
访问仓库或反馈链接需要网络连接。

Expected comparison: 3 added rows; 4 changed cells (2 amounts, 1 formula/cache,
1 number-to-text change). Reordering rows and columns creates no changes.
预期：3 条新增记录、4 处单元格变化；行列重排不计作修改。

Use your own files: https://github.com/po-et/dsh-sheet-diff
Feedback: https://github.com/po-et/dsh-sheet-diff/issues/1
Do not post confidential workbooks. 请勿提交机密工作簿。
`;
let directory;
if (args.length) {
  directory = resolve(args[1]);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
} else {
  await mkdir(resolve('artifacts'), { recursive: true });
  directory = await mkdtemp(resolve('artifacts/demo-'));
}
for (const [name, data] of [ ['orders-before.xlsx', before], ['orders-after.xlsx', after],
  ['report.json', `${JSON.stringify(report, null, 2)}\n`], ['report.html', renderReport(report)],
  ['index.html', guide], ['README.txt', instructions] ]) {
  await writeFile(join(directory, name), data, { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ directory, guide: join(directory, 'index.html'), report: join(directory, 'report.html'), expected: '3 added rows; 4 changed cells (2 amounts, 1 formula/cache, 1 number-to-text type change); row and column reorder ignored', summary: report.summary }, null, 2));
