import ExcelJS from 'exceljs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { compareBuffers } from '../src/compare.js';
import { renderReport } from '../src/report.js';

// Synthetic data only. No customer workbook is used in the demo.
await mkdir(resolve('artifacts'), { recursive: true });
const directory = await mkdtemp(resolve('artifacts/demo-'));
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
for (const [name, data] of [ ['orders-before.xlsx', before], ['orders-after.xlsx', after],
  ['report.json', `${JSON.stringify(report, null, 2)}\n`], ['report.html', renderReport(report)] ]) {
  await writeFile(join(directory, name), data, { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ directory, report: join(directory, 'report.html'), expected: '3 added rows; 4 changed cells (2 amounts, 1 formula/cache, 1 number-to-text type change); row and column reorder ignored', summary: report.summary }, null, 2));
