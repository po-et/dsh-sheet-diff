import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { compareBuffers, MAX_CHANGES, MAX_CHANGE_BYTES } from '../src/compare.js';

const options = { beforeName: 'before.xlsx', afterName: 'after.xlsx', keyColumns: ['ID'] };
async function xlsx(rows, columns = ['ID', 'Amount', 'Note'], name = 'Data') {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(name);
  sheet.addRow(columns);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}
const csvOptions = { beforeName: 'before.csv', afterName: 'after.csv', keyColumns: ['ID'] };
const csv = text => Buffer.from(text);

test('out-of-range header rows cannot produce a false unchanged report', async () => {
  await assert.rejects(compareBuffers(csv('ID,Amount\n1,10'), csv('ID,Amount\n1,999'), {
    ...csvOptions, headerRow: 3,
  }), /header row 3.*after.*nonempty data/);
  await assert.rejects(compareBuffers(await xlsx([[1, 10]]), await xlsx([[1, 999]]), {
    ...options, headerRow: 3,
  }), /header row 3.*after.*nonempty data/);
});

test('aligns typed row keys and exact header names despite row/column order', async () => {
  const before = await xlsx([[1, 42, 'one'], [2, 8, 'two']]);
  const after = await xlsx([['two', 8, 2], ['one', 42, 1]], ['Note', 'Amount', 'ID']);
  const report = await compareBuffers(before, after, options);
  assert.equal(report.changes.length, 0);
  assert.equal(report.summary.changedCells, 0);
  assert.match(report.warnings.join('\n'), /never recalculated/);
});

test('reports one keyed cell change for a value/type change', async () => {
  const report = await compareBuffers(await xlsx([[1, 42, 'same']]), await xlsx([[1, '42', 'same']]), options);
  assert.equal(report.changes.length, 1);
  assert.equal(report.changes[0].column, 'Amount');
  assert.deepEqual(report.changes[0].key, ['number:1']);
  assert.deepEqual(report.changes[0].aspects, ['type', 'value']);
  assert.equal(report.changes[0].before.type, 'number');
  assert.equal(report.changes[0].after.type, 'string');
});

test('keeps formulas and their cached results independently visible', async () => {
  const before = await xlsx([[1, { formula: '1+1', result: 2 }, null], [2, { formula: '2+2', result: 4 }, null]]);
  const after = await xlsx([[1, { formula: '2*1', result: 2 }, null], [2, { formula: '2+2', result: 5 }, null]]);
  const report = await compareBuffers(before, after, options);
  assert.equal(report.changes.length, 2);
  assert.deepEqual(report.changes.find(change => change.key[0] === 'number:1').aspects, ['formula']);
  assert.deepEqual(report.changes.find(change => change.key[0] === 'number:2').aspects, ['cache']);
  assert.deepEqual(report.changes[0].before.cache, { type: 'number', value: 2 });
});

test('represents added/removed rows once, with field values and source row numbers', async () => {
  const report = await compareBuffers(await xlsx([[1, 10, 'old'], [2, 20, 'same']]), await xlsx([[2, 20, 'same'], [3, 30, 'new']]), options);
  assert.equal(report.changes.length, 2);
  assert.equal(report.summary.removedRows, 1);
  assert.equal(report.summary.addedRows, 1);
  const removed = report.changes.find(change => change.kind === 'row-removed');
  const added = report.changes.find(change => change.kind === 'row-added');
  assert.equal(removed.rowBefore, 2);
  assert.equal(added.rowAfter, 3);
  assert.deepEqual(added.fields.map(field => field.column), ['ID', 'Amount', 'Note']);
  assert.equal(added.fields[1].after.value, 30);
  assert.equal(removed.fields[1].before.value, 10);
});

test('reports columns and preserves keyed data for their populated cells', async () => {
  const report = await compareBuffers(await xlsx([[1, 'old']], ['ID', 'Removed']), await xlsx([[1, 'new']], ['ID', 'Added']), options);
  assert.equal(report.summary.removedColumns, 1);
  assert.equal(report.summary.addedColumns, 1);
  assert.equal(report.summary.changedCells, 2);
  const addedValue = report.changes.find(change => change.kind === 'cell-changed' && change.column === 'Added');
  assert.equal(addedValue.before, null);
  assert.equal(addedValue.after.value, 'new');
  assert.deepEqual(addedValue.aspects, ['type', 'value']);
});

test('different key types never collapse into one row', async () => {
  const report = await compareBuffers(await xlsx([[1, 10, null], ['1', 20, null]]), await xlsx([['1', 21, null], [1, 10, null]]), options);
  assert.equal(report.summary.changedCells, 1);
  assert.deepEqual(report.changes[0].key, ['string:1']);
});

test('composite keys use exact string boundaries', async () => {
  const before = await xlsx([['a:b', 'c', 1], ['a', 'b:c', 2]], ['ID', 'Part', 'Amount']);
  const after = await xlsx([['a', 'b:c', 3], ['a:b', 'c', 1]], ['ID', 'Part', 'Amount']);
  const report = await compareBuffers(before, after, { ...options, keyColumns: ['ID', 'Part'] });
  assert.equal(report.changes.length, 1);
  assert.deepEqual(report.changes[0].key, ['string:a', 'string:b:c']);
});

test('rejects duplicate, missing, error, formula and absent-column keys', async () => {
  const valid = await xlsx([[1, 1, null]]);
  for (const [rows, pattern] of [
    [[[1, 1, null], [1, 2, null]], /duplicate key/],
    [[[null, 2, null]], /nonempty, non-formula, non-error/],
    [[[' \t ', 2, null]], /nonempty, non-formula, non-error/],
    [[[{ error: '#N/A' }, 2, null]], /nonempty, non-formula, non-error/],
    [[[{ formula: '1', result: 1 }, 2, null]], /nonempty, non-formula, non-error/],
  ]) await assert.rejects(compareBuffers(await xlsx(rows), valid, options), pattern);
  await assert.rejects(compareBuffers(await xlsx([[1, 2]], ['Other', 'Amount']), valid, options), /missing key column/);
});

test('error, boolean and date values remain typed', async () => {
  const before = await xlsx([[1, { error: '#N/A' }, true], [2, new Date('2026-01-01T00:00:00Z'), null]]);
  const after = await xlsx([[1, { error: '#VALUE!' }, false], [2, new Date('2026-01-02T00:00:00Z'), null]]);
  const report = await compareBuffers(before, after, options);
  assert.equal(report.summary.changedCells, 3);
  assert.equal(report.changes.find(change => change.column === 'Amount' && change.key[0] === 'number:1').before.type, 'error');
  assert.equal(report.changes.find(change => change.column === 'Note').after.type, 'boolean');
  assert.equal(report.changes.find(change => change.key[0] === 'number:2').after.value, '2026-01-02T00:00:00.000Z');
});

test('sheet additions/removals are explicit, and selected-sheet absence is not a silent no-op', async () => {
  const report = await compareBuffers(await xlsx([[1, 1]], ['ID', 'Value'], 'Old'), await xlsx([[2, 2]], ['ID', 'Value'], 'New'), options);
  assert.equal(report.summary.addedSheets, 1);
  assert.equal(report.summary.removedSheets, 1);
  assert.equal(report.summary.addedRows, 1);
  assert.equal(report.summary.removedRows, 1);
  const selected = await compareBuffers(await xlsx([[1, 1]], ['ID', 'Value'], 'Old'), await xlsx([[2, 2]], ['ID', 'Value'], 'New'), { ...options, sheet: 'Old' });
  assert.equal(selected.summary.removedSheets, 1);
  assert.equal(selected.summary.addedSheets, 0);
  await assert.rejects(compareBuffers(await xlsx([]), await xlsx([]), { ...options, sheet: 'Missing' }), /does not exist in either/);
});

test('skips blank rows and supports explicit header rows', async () => {
  const before = csv('metadata\nID,Value\n\n1,a\n,\n2,b\n');
  const after = csv('different metadata\nID,Value\n2,b\n1,a\n');
  const report = await compareBuffers(before, after, { ...csvOptions, headerRow: 2 });
  assert.equal(report.changes.length, 0);
});

test('reports and change IDs are deterministic and bound to input hashes/options', async () => {
  const before = csv('ID,Value\n1,a\n');
  const after = csv('ID,Value\n1,b\n');
  const one = await compareBuffers(before, after, csvOptions);
  const two = await compareBuffers(before, after, csvOptions);
  assert.deepEqual(one, two);
  assert.match(one.sources.before.sha256, /^[a-f0-9]{64}$/);
  assert.match(one.reportId, /^[a-f0-9]{64}$/);
  assert.notEqual(one.reportId, (await compareBuffers(after, before, csvOptions)).reportId);
  assert.notEqual(one.changes[0].id, (await compareBuffers(after, before, csvOptions)).changes[0].id);
});

test('input bytes and source names are snapshotted across async parsing', async () => {
  const before = csv('ID,Value\n1,a\n');
  const after = csv('ID,Value\n1,b\n');
  const mutableOptions = { ...csvOptions };
  const pending = compareBuffers(before, after, mutableOptions);
  after.fill(0);
  mutableOptions.afterName = 'mutated.xlsx';
  const report = await pending;
  assert.equal(report.sources.after.name, 'after.csv');
  assert.equal(report.changes[0].after.value, 'b');
});

test('rejects invalid options and cancellation', async () => {
  const data = csv('ID,Value\n1,a');
  for (const keyColumns of [[], [''], ['ID', 'ID'], undefined]) {
    await assert.rejects(compareBuffers(data, data, { ...csvOptions, keyColumns }), /keyColumns/);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(compareBuffers(data, data, { ...csvOptions, signal: controller.signal }), { name: 'AbortError' });
});

test('fails clearly at the change limit instead of returning a truncated report', async () => {
  const before = csv(`ID,Value\n${Array.from({ length: MAX_CHANGES + 1 }, (_, index) => `${index},a`).join('\n')}`);
  const after = csv(`ID,Value\n${Array.from({ length: MAX_CHANGES + 1 }, (_, index) => `${index},b`).join('\n')}`);
  await assert.rejects(compareBuffers(before, after, csvOptions), /exceeds 10000 changes/);
});

test('fails clearly at the cumulative serialized-change byte cap below input and change-count limits', async () => {
  const valueBytes = MAX_CHANGE_BYTES / 8;
  const beforeValue = 'a'.repeat(valueBytes);
  const afterValue = 'b'.repeat(valueBytes);
  const before = csv(`ID,Value\n${Array.from({ length: 5 }, (_, index) => `${index},${beforeValue}`).join('\n')}`);
  const after = csv(`ID,Value\n${Array.from({ length: 5 }, (_, index) => `${index},${afterValue}`).join('\n')}`);
  assert.ok(before.byteLength < 20 * 1024 * 1024);
  assert.ok(after.byteLength < 20 * 1024 * 1024);
  await assert.rejects(compareBuffers(before, after, csvOptions), /24 MiB serialized-change resource limit/);
});

test('bounds a single amplified row before serialization, including escaped characters', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Data');
  const large = '\\'.repeat(1024 * 1024);
  const columns = ['ID', ...Array.from({ length: 13 }, (_, index) => `Value${index}`)];
  sheet.addRow(columns);
  sheet.addRow([1, ...Array(13).fill(large)]);
  const before = await xlsx([], columns);
  const after = Buffer.from(await book.xlsx.writeBuffer());
  assert.ok(after.byteLength < 20 * 1024 * 1024);
  await assert.rejects(compareBuffers(before, after, options), /24 MiB serialized-change resource limit/);
});

test('rejects mixed CSV/XLSX extensions before interpreting tables', async () => {
  await assert.rejects(compareBuffers(csv('ID,Value\n1,a'), await xlsx([[1, 'a']]), { ...csvOptions, afterName: 'after.xlsx' }), /same file extension.*mixed formats/);
  const report = await compareBuffers(csv('ID,Value\n1,a'), csv('ID,Value\n1,b'), { ...csvOptions, afterName: 'AFTER.CSV' });
  assert.equal(report.summary.changedCells, 1);
});
