import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { compareBuffers } from '../src/compare.js';
import { parseBuffer } from '../src/parse.js';
import { createHost, dispatch } from '../scripts/host-smoke.js';

const options = { beforeName: 'before.xlsx', afterName: 'after.xlsx', keyColumns: ['ID'] };
const unsupported = /Unsupported ISO 8601 date cell.*B2.*ExcelJS.*numeric date/i;

// ExcelJS cannot write t="d" cells. Replace one cell in a complete workbook to
// reproduce the ISO storage used by writers such as openpyxl with iso_dates=True.
async function isoWorkbook(value, { secondSheet = false, type = 'd' } = {}) {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Data').addRows([['ID', 'Date'], [1, 1]]);
  if (secondSheet) {
    book.addWorksheet('Other', { state: 'hidden' }).addRows([['ID', 'Date'], [1, 1]]);
  }
  const archive = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  const path = `xl/worksheets/sheet${secondSheet ? 2 : 1}.xml`;
  const xml = await archive.file(path).async('string');
  const cell = `<c r="B2" t="${type}"><v>${value}</v></c>`;
  const replaced = xml.replace(/<c r="B2"[^>]*>.*?<\/c>/, cell);
  assert.notEqual(replaced, xml);
  archive.file(path, replaced);
  return archive.generateAsync({ type: 'nodebuffer' });
}

for (const [label, beforeValue, afterValue] of [
  ['date', '2026-01-01', '2026-12-31'],
  ['datetime', '2026-01-01T09:00:00.125', '2026-01-01T09:01:00.125'],
  ['time', '09:00:00.125', '09:01:00.125'],
]) {
  test(`ISO ${label} cells cannot produce a false unchanged report`, async () => {
    const before = await isoWorkbook(beforeValue);
    const after = await isoWorkbook(afterValue);
    await assert.rejects(compareBuffers(before, after, options), unsupported);
  });
}

test('identical ISO date inputs are rejected consistently, including unselected hidden sheets', async () => {
  const input = await isoWorkbook('2026-01-01');
  await assert.rejects(compareBuffers(input, input, options), unsupported);
  const hidden = await isoWorkbook('2026-01-01', { secondSheet: true });
  await assert.rejects(compareBuffers(hidden, hidden, { ...options, sheet: 'Data' }), /ISO 8601 date cell in xl\/worksheets\/sheet2\.xml at B2/);
});

test('ISO date type character references are also rejected before parsing', async () => {
  for (const type of ['&#100;', '&#x64;', '&#000100;', '&#x000064;']) {
    await assert.rejects(parseBuffer(await isoWorkbook('2026-01-01', { type }), 'data.xlsx'), unsupported);
  }
});

test('numeric Excel dates remain typed in both date systems', async () => {
  for (const date1904 of [false, true]) {
    const buffers = [];
    for (const value of ['2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z']) {
      const book = new ExcelJS.Workbook();
      book.properties.date1904 = date1904;
      book.addWorksheet('Data').addRows([['ID', 'Date'], [1, new Date(value)]]);
      buffers.push(Buffer.from(await book.xlsx.writeBuffer()));
    }
    const report = await compareBuffers(...buffers, options);
    assert.equal(report.summary.changedCells, 1);
    assert.equal(report.changes[0].before.type, 'date');
    assert.equal(report.changes[0].before.value, '2026-01-01T00:00:00.000Z');
    assert.equal(report.changes[0].after.value, '2026-12-31T00:00:00.000Z');
    assert.equal((await compareBuffers(buffers[0], buffers[0], options)).changes.length, 0);
  }
});

test('date-looking strings and t="d" text or XML comments remain ordinary data', async () => {
  const value = '<c r="B2" t="d"><v>2026-01-01</v></c>';
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Data').addRows([['ID', 'Text', 'Date'], [1, value, '2026-01-01']]);
  const archive = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  const path = 'xl/worksheets/sheet1.xml';
  archive.file(path, (await archive.file(path).async('string')).replace('<sheetData>', `<!--${value}--><sheetData>`));
  const input = await archive.generateAsync({ type: 'nodebuffer' });
  const cells = (await parseBuffer(input, 'data.xlsx')).sheets[0].rows[0].cells;
  assert.equal(cells.get('Text').value, value);
  assert.equal(cells.get('Date').type, 'string');
  assert.equal((await compareBuffers(input, input, options)).changes.length, 0);
});

test('Harness dispatch rejects ISO date data before writing review artifacts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sheetdiff-iso-date-'));
  await writeFile(join(workspace, 'before.xlsx'), await isoWorkbook('2026-01-01'));
  await writeFile(join(workspace, 'after.xlsx'), await isoWorkbook('2026-12-31'));
  const { ctx } = await createHost(workspace);
  try {
    const result = await dispatch(ctx, 'sheet_diff_compare', {
      before: 'before.xlsx', after: 'after.xlsx', keyColumns: ['ID'], outputDir: 'reports',
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), unsupported);
    assert.deepEqual((await readdir(workspace)).sort(), ['after.xlsx', 'before.xlsx']);
  } finally { await ctx.fiber.dispose(); }
});
