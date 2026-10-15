import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parseBuffer, parseCsvRecords, PARSE_LIMITS } from '../src/parse.js';
import { inspectXlsxArchive, ARCHIVE_LIMITS } from '../src/archive.js';

test('CSV quotes, escaped quotes, commas, BOM and embedded CRLF preserve exact strings', async () => {
  const bytes = Buffer.from('\uFEFFID,Text,Number\r\n01,"a,""b""\r\nnext",42\r\n');
  const result = await parseBuffer(bytes, 'data.csv');
  assert.deepEqual(result.sheets[0].columns, ['ID', 'Text', 'Number']);
  assert.equal(result.sheets[0].rows[0].cells.get('Text').value, 'a,"b"\r\nnext');
  assert.equal(result.sheets[0].rows[0].cells.get('Number').type, 'string');
  assert.equal(result.sheets[0].rows[0].cells.get('ID').value, '01');
  assert.deepEqual(parseCsvRecords('a,b,\n"",c,'), [['a', 'b', ''], ['', 'c', '']]);
});

test('malformed quoting, invalid UTF-8 and binary CSV fail explicitly', async () => {
  for (const text of ['ID,Value\n1,"unterminated', 'ID,Value\n1,ab"c', 'ID,Value\n1,"a"b', 'ID,Value\n1,"a" ']) {
    await assert.rejects(parseBuffer(Buffer.from(text), 'data.csv'), /Malformed CSV/);
  }
  await assert.rejects(parseBuffer(Buffer.from([0xc3, 0x28]), 'data.csv'), /valid UTF-8/);
  await assert.rejects(parseBuffer(Buffer.from('ID,Value\n1,a\0'), 'data.csv'), /NUL/);
});

test('ambiguous or missing headers fail instead of silently dropping data', async () => {
  for (const [text, pattern] of [['ID,ID\n1,2', /duplicate header/], ['ID,\n1,2', /missing or non-text header/], ['ID\n1,2', /missing or non-text header/]]) {
    await assert.rejects(parseBuffer(Buffer.from(text), 'data.csv'), pattern);
  }
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Data').addRows([[1, 'Value'], [1, 'a']]);
  await assert.rejects(parseBuffer(Buffer.from(await book.xlsx.writeBuffer()), 'data.xlsx'), /non-text header/);
});

test('empty inputs and trailing blank CSV columns do not invent data', async () => {
  assert.deepEqual((await parseBuffer(Buffer.alloc(0), 'empty.csv')).sheets[0], { name: 'CSV', columns: [], rows: [] });
  const sheet = (await parseBuffer(Buffer.from('ID,Value,\n1,a,,\n,,,\n'), 'data.csv')).sheets[0];
  assert.deepEqual(sheet.columns, ['ID', 'Value']);
  assert.equal(sheet.rows.length, 1);
  assert.equal(sheet.rows[0].cells.has(undefined), false);
});

test('a header row after nonempty data fails instead of discarding the sheet', async () => {
  for (const suffix of ['', '\n,,\n,,']) {
    await assert.rejects(parseBuffer(Buffer.from(`ID,Value\n1,a${suffix}`), 'data.csv', { headerRow: 3 }), /header row 3.*after.*nonempty data/);
  }
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Data');
  sheet.addRows([['ID', 'Value'], [1, 'a']]);
  sheet.getCell('A5').font = { bold: true };
  await assert.rejects(parseBuffer(Buffer.from(await book.xlsx.writeBuffer()), 'data.xlsx', { headerRow: 3 }), /header row 3.*after.*nonempty data/);
});

test('custom header rows still allow preambles, empty tables and truly empty sheets', async () => {
  const parsed = await parseBuffer(Buffer.from('Preamble\nID,Value\n1,a'), 'data.csv', { headerRow: 2 });
  assert.deepEqual(parsed.sheets[0].columns, ['ID', 'Value']);
  assert.equal(parsed.sheets[0].rows[0].rowNumber, 3);
  const emptyTable = await parseBuffer(Buffer.from('Preamble\nID,Value'), 'data.csv', { headerRow: 2 });
  assert.deepEqual(emptyTable.sheets[0].columns, ['ID', 'Value']);
  assert.deepEqual(emptyTable.sheets[0].rows, []);
  const emptySheet = await parseBuffer(Buffer.from('\n,,\n'), 'data.csv', { headerRow: 3 });
  assert.deepEqual(emptySheet.sheets[0], { name: 'CSV', columns: [], rows: [] });
});

test('input and CSV field resource bounds are explicit', async () => {
  await assert.rejects(parseBuffer(Buffer.alloc(PARSE_LIMITS.inputBytes + 1), 'large.csv'), /exceeds 20 MiB/);
  await assert.rejects(parseBuffer(Buffer.from(`ID,Value\n${'1,a\n'.repeat(50000)}`), 'large.csv'), /exceeds 100000 fields/);
  await assert.rejects(parseBuffer(Buffer.from(''), 'legacy.xls'), /Only .csv and .xlsx/);
  await assert.rejects(parseBuffer(Buffer.from(''), 'macro.xlsm'), /Only .csv and .xlsx/);
});

test('XLSX formulas can distinguish no cached result from a cached error', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Data');
  sheet.addRows([['ID', 'NoCache', 'ErrorCache'], [1, { formula: '1/0' }, { formula: '1/0', result: { error: '#DIV/0!' } }]]);
  const parsed = await parseBuffer(Buffer.from(await book.xlsx.writeBuffer()), 'data.xlsx');
  assert.equal(parsed.sheets[0].rows[0].cells.get('NoCache').cache, null);
  assert.deepEqual(parsed.sheets[0].rows[0].cells.get('ErrorCache').cache, { type: 'error', value: '#DIV/0!' });
});

test('zero and false formula caches remain present and typed', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Data').addRows([['ID', 'Zero', 'False'], [1, { formula: '0', result: 0 }, { formula: 'FALSE()', result: false }]]);
  const parsed = await parseBuffer(Buffer.from(await book.xlsx.writeBuffer()), 'data.xlsx');
  assert.deepEqual(parsed.sheets[0].rows[0].cells.get('Zero').cache, { type: 'number', value: 0 });
  assert.deepEqual(parsed.sheets[0].rows[0].cells.get('False').cache, { type: 'boolean', value: false });
});

test('explicit empty string formula caches fail clearly rather than becoming absent caches', async () => {
  for (const value of ['<v/>', '<v></v>', '<v><!--empty--></v>', '<v><![CDATA[]]></v>']) {
    const xml = `<worksheet><sheetData><row r="1"><c r="A1" t="str"><f>""</f>${value}</c></row></sheetData></worksheet>`;
    await assert.rejects(inspectXlsxArchive(await minimalZip([['xl/worksheets/sheet1.xml', xml]])), /Unsupported empty string formula cache/);
  }
});

test('XLSX merged dependents are blank and rich text uses visible characters', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Data');
  sheet.addRows([['ID', 'Text', 'Merged'], [1, { richText: [{ text: 'one' }, { text: 'two', font: { bold: true } }] }, null]]);
  sheet.mergeCells('B2:C2');
  const parsed = await parseBuffer(Buffer.from(await book.xlsx.writeBuffer()), 'data.xlsx');
  assert.equal(parsed.sheets[0].rows[0].cells.get('Text').value, 'onetwo');
  assert.equal(parsed.sheets[0].rows[0].cells.get('Merged').type, 'blank');
  assert.match(parsed.warnings.join('\n'), /Rich text formatting/);
});

test('XLSX remains sparse across distant columns', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Data');
  sheet.addRow(Array.from({ length: 1000 }, (_, column) => column === 0 ? 'ID' : `Column${column}`));
  sheet.getCell('A2').value = 1;
  sheet.getCell(2, 1000).value = 'far';
  const parsed = await parseBuffer(Buffer.from(await book.xlsx.writeBuffer()), 'data.xlsx');
  assert.equal(parsed.sheets[0].rows[0].cells.size, 2);
});

async function minimalZip(extra = []) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('xl/workbook.xml', '<workbook/>');
  for (const [name, value] of extra) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('archive inspection rejects unsafe paths, active content, entities and unsupported ZIPs', async () => {
  for (const [entries, pattern] of [
    [[['../escape.xml', '<x/>']], /invalid relative path|Unsafe/],
    [[['xl/vbaProject.bin', 'macro']], /active or external content/],
    [[['xl/externalLinks/externalLink1.xml', '<x/>']], /active or external content/],
    [[['xl/worksheets/sheet1.xml', '<!DOCTYPE x [<!ENTITY y "z">]><x/>']], /entity declarations/],
    [[['xl/%2e%2e/escape.xml', '<x/>']], /Unsafe/],
  ]) await assert.rejects(inspectXlsxArchive(await minimalZip(entries)), pattern);
  await assert.rejects(inspectXlsxArchive(Buffer.from('invalid')), /Invalid XLSX archive/);
  const plain = new JSZip();
  plain.file('text.txt', 'text');
  await assert.rejects(inspectXlsxArchive(await plain.generateAsync({ type: 'nodebuffer' })), /XLSX workbook is required/);
});

test('archive inspection bounds each decompressed part and the expanded total', async () => {
  const oversized = await minimalZip([['part.bin', Buffer.alloc(ARCHIVE_LIMITS.partBytes + 1)]]);
  await assert.rejects(inspectXlsxArchive(oversized), /part exceeds 8 MiB/);
  const entries = Array.from({ length: 8 }, (_, index) => [`part${index}.bin`, Buffer.alloc(ARCHIVE_LIMITS.partBytes)]);
  await assert.rejects(inspectXlsxArchive(await minimalZip(entries)), /expanded content exceeds the resource limit/);
});

test('archive rejects duplicated filenames and forged size metadata', async () => {
  const original = await minimalZip([['aa.xml', 'a'], ['bb.xml', 'b']]);
  const duplicate = Buffer.from(original);
  // Equal-length filenames can be changed in local and central headers without changing offsets.
  for (let index = duplicate.indexOf('bb.xml'); index !== -1; index = duplicate.indexOf('bb.xml', index + 6)) duplicate.write('aa.xml', index);
  await assert.rejects(inspectXlsxArchive(duplicate), /Duplicate XLSX archive entry/);
  const forged = Buffer.from(await minimalZip([['part.bin', Buffer.alloc(1024 * 1024)]]));
  for (let index = 0; index < forged.length - 46; index++) {
    if (forged.readUInt32LE(index) === 0x02014b50) {
      const nameLength = forged.readUInt16LE(index + 28);
      if (forged.subarray(index + 46, index + 46 + nameLength).toString() === 'part.bin') forged.writeUInt32LE(1, index + 24);
    }
  }
  await assert.rejects(inspectXlsxArchive(forged), /size|bytes/);
});

test('archive preflights actual worksheet cells and coordinates regardless of claimed dimensions', async () => {
  for (const [xml, pattern] of [
    ['<worksheet><dimension ref="A1:A1"/><sheetData><row r="999999999"><c r="A999999999"/></row></sheetData></worksheet>', /out-of-bounds/],
    ['<worksheet><sheetData><row r="1"><c r="XFE1"/></row></sheetData></worksheet>', /out-of-bounds/],
    ['<worksheet><dimension ref="A1:XFE1"/></worksheet>', /out-of-bounds/],
    ['<worksheet><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A&#49;"/></row></sheetData></worksheet>', /out-of-bounds/],
    [`<worksheet><sheetData>${'<c s="1"/>'.repeat(100001)}</sheetData></worksheet>`, /serialized cells before parsing/],
    [`<worksheet><sheetData>${'<row/>'.repeat(100001)}</sheetData></worksheet>`, /serialized rows before parsing/],
    ['<worksheet><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>', /merged ranges exceed/],
    ['<worksheet><dataValidations><dataValidation sqref="A1:XFD1048576"/></dataValidations></worksheet>', /data-validation ranges exceed/],
    ['<worksheet><cols><col min="1" max="999999999"/></cols></worksheet>', /out-of-bounds column range/],
    [`<worksheet>${'<c '.repeat(100000)}</worksheet>`, /Malformed XML/],
  ]) await assert.rejects(inspectXlsxArchive(await minimalZip([['xl/worksheets/sheet1.xml', xml]])), pattern);
});

test('archive honours cancellation while a compressed part is streaming', async () => {
  const bytes = await minimalZip([['part.bin', Buffer.alloc(ARCHIVE_LIMITS.partBytes)]]);
  const controller = new AbortController();
  const pending = inspectXlsxArchive(bytes, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: 'AbortError' });
});
