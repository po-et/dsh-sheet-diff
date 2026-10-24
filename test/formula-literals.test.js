import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBuffer } from '../src/parse.js';
import { compareBuffers } from '../src/compare.js';
import { createHost, dispatch } from '../scripts/host-smoke.js';

async function workbook(formula, result = 'ready') {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Data').addRows([['ID', 'Value'], [1, { formula, result }]]);
  book.addWorksheet('Lookup').addRows([['ID', 'Value'], [1, 'ready']]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

for (const formula of [
  '"[note]"&Lookup!B2',
  'IF(Lookup!B2="[pending]",Lookup!B2,0)',
  'IF(Lookup!B2="say ""[ready]""",Lookup!B2,0)',
  '"[Book.xlsx]Sheet1!A1"&Lookup!B2',
  '"INDIRECT(""[Book.xlsx]Sheet1!A1"")"&Lookup!B2',
  'INDIRECT("Lookup!B2")',
]) {
  test(`brackets inside formula text remain literal: ${formula}`, async () => {
    const parsed = await parseBuffer(await workbook(formula), 'data.xlsx', { sheet: 'Data' });
    assert.deepEqual(parsed.sheets[0].rows[0].cells.get('Value'), {
      type: 'formula', value: null, formula, cache: { type: 'string', value: 'ready' },
    });
  });
}

for (const formula of [
  '[Book.xlsx]Sheet1!A1',
  "'[Book.xlsx]Other Sheet'!A1",
  '"label [note]"&[Book.xlsx]Sheet1!A1',
  'IF(Lookup!B2="say ""[safe]""",0,[Book.xlsx]Sheet1!A1)',
  'INDIRECT("[Book.xlsx]Data!A1")',
  'INDIRECT("\'[Book.xlsx]Other Sheet\'!A1")',
  'iNdIrEcT ("[Book.xlsx]Data!A1")',
  'IF(Lookup!B2="",0,INDIRECT("[Book.xlsx]"&"Data!A1"))',
  'LET(address,"[Book.xlsx]Data!A1",INDIRECT(address))',
  '_xlfn.INDIRECT("[1]Data!A1")',
  'INDIRECT("[1]Data!A1")',
]) {
  test(`actual workbook references remain unsupported: ${formula}`, async () => {
    await assert.rejects(parseBuffer(await workbook(formula), 'data.xlsx'), /External workbook formula is unsupported at B2/);
  });
}

const beforeFormula = '"[old]"&Lookup!B2';
const afterFormula = '"[new]"&Lookup!B2';
const options = { beforeName: 'before.xlsx', afterName: 'after.xlsx', keyColumns: ['ID'], sheet: 'Data' };

test('formula text and cached results survive a keyed comparison', async () => {
  const report = await compareBuffers(await workbook(beforeFormula, '[old]ready'), await workbook(afterFormula, '[new]ready'), options);
  assert.equal(report.summary.changedCells, 1);
  assert.equal(report.changes.length, 1);
  assert.deepEqual(report.changes[0].aspects, ['formula', 'cache']);
  assert.equal(report.changes[0].before.formula, beforeFormula);
  assert.equal(report.changes[0].after.formula, afterFormula);
  assert.deepEqual(report.changes[0].after.cache, { type: 'string', value: '[new]ready' });
  await assert.rejects(compareBuffers(await workbook(beforeFormula), await workbook('INDIRECT("[Book.xlsx]Data!A1")'), options), /External workbook formula is unsupported/);
});

test('the CLI publishes the same literal-formula comparison without changing input bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sheetdiff-literal-cli-'));
  const before = join(directory, 'before.xlsx');
  const after = join(directory, 'after.xlsx');
  const out = join(directory, 'review');
  const beforeBytes = await workbook(beforeFormula);
  const afterBytes = await workbook(afterFormula);
  await writeFile(before, beforeBytes);
  await writeFile(after, afterBytes);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, before, after, '--key', 'ID', '--sheet', 'Data', '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.equal(report.summary.changedCells, 1);
  assert.deepEqual(report.changes[0].aspects, ['formula']);
  assert.deepEqual(await readFile(before), beforeBytes);
  assert.deepEqual(await readFile(after), afterBytes);
  const external = join(directory, 'external.xlsx');
  await writeFile(external, await workbook('INDIRECT("[Book.xlsx]Data!A1")'));
  const rejected = spawnSync(process.execPath, [cli, before, external, '--key', 'ID', '--sheet', 'Data', '--out', join(directory, 'blocked')], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /External workbook formula is unsupported/);
});

test('the registered tool accepts literal brackets and retains external-workbook rejection', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sheetdiff-literal-tool-'));
  await writeFile(join(workspace, 'before.xlsx'), await workbook(beforeFormula));
  await writeFile(join(workspace, 'after.xlsx'), await workbook(afterFormula));
  await writeFile(join(workspace, 'external.xlsx'), await workbook('[Book.xlsx]Sheet1!A1'));
  await writeFile(join(workspace, 'indirect.xlsx'), await workbook('INDIRECT("[Book.xlsx]Data!A1")'));
  const { ctx } = await createHost(workspace);
  try {
    const args = { before: 'before.xlsx', after: 'after.xlsx', keyColumns: ['ID'], sheet: 'Data', outputDir: 'reports' };
    const accepted = await dispatch(ctx, 'sheet_diff_compare', args);
    assert.equal(accepted.isError, false, JSON.stringify(accepted.content));
    assert.equal(accepted.value.summary.changedCells, 1);
    for (const after of ['external.xlsx', 'indirect.xlsx']) {
      const rejected = await dispatch(ctx, 'sheet_diff_compare', { ...args, after, outputDir: `blocked-${after}` });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected.content), /External workbook formula is unsupported at B2/);
    }
  } finally {
    await ctx.fiber.dispose();
  }
});
