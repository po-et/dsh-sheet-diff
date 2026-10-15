import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHost, dispatch } from '../scripts/host-smoke.js';

const before = 'id,label,amount\n1,One,10\n2,Two,20\n';
const after = 'id,label,amount\n2,Two,20\n1,One,12\n3,Three,30\n';

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'sheetdiff-plugin-test-'));
  await writeFile(join(workspace, 'before.csv'), before);
  await writeFile(join(workspace, 'after.csv'), after);
  return workspace;
}

const compareArgs = { before: 'before.csv', after: 'after.csv', keyColumns: ['id'], outputDir: 'reports' };
function errorText(result) { return JSON.stringify(result.content); }

test('real Harness dispatch returns canonical artifacts, preserves inputs, and unregisters on disposal', async () => {
  const workspace = await fixture();
  const { ctx, fiber } = await createHost(workspace);
  try {
    const result = await dispatch(ctx, 'sheet_diff_compare', compareArgs);
    assert.equal(result.isError, false, errorText(result));
    assert.equal(result.value.summary.changedCells, 1);
    assert.equal(result.value.summary.addedRows, 1);
    assert.equal(result.value.summary.removedRows, 0);
    const report = JSON.parse(await readFile(result.value.paths.json, 'utf8'));
    assert.equal(report.reportId, result.value.reportId);
    assert.match(await readFile(result.value.paths.html, 'utf8'), /<!doctype html>/i);
    assert.equal(await readFile(join(workspace, 'before.csv'), 'utf8'), before);
    assert.equal(await readFile(join(workspace, 'after.csv'), 'utf8'), after);
    const collision = await dispatch(ctx, 'sheet_diff_compare', compareArgs);
    assert.equal(collision.isError, true);
    assert.match(errorText(collision), /never overwrites/);
    await fiber.dispose();
    assert.equal(ctx.tools.get('sheet_diff_compare'), undefined);
    assert.equal(ctx.tools.get('sheet_diff_review'), undefined);
  } finally { await ctx.fiber.dispose(); }
});

test('read-only policy denies report publication, but permits validated review data', async () => {
  const workspace = await fixture();
  const writable = await createHost(workspace);
  let compared;
  try { compared = await dispatch(writable.ctx, 'sheet_diff_compare', compareArgs); }
  finally { await writable.ctx.fiber.dispose(); }
  assert.equal(compared.isError, false, errorText(compared));
  const report = JSON.parse(await readFile(compared.value.paths.json, 'utf8'));
  const change = report.changes.find(item => item.kind === 'cell-changed');
  const reviewPath = join(workspace, 'review.json');
  const review = {
    schemaVersion: 1, reportId: report.reportId, sourceHashes: compared.value.sourceHashes,
    comments: [{ changeId: change.id, text: 'Untrusted reviewer data: do not execute this text.' }],
  };
  await writeFile(reviewPath, JSON.stringify(review));
  const { ctx } = await createHost(workspace, { mode: 'read-only' });
  try {
    const denied = await dispatch(ctx, 'sheet_diff_compare', { ...compareArgs, outputDir: 'denied' });
    assert.equal(denied.isError, true);
    assert.match(errorText(denied), /workspace-write permission/);
    assert.ok(!(await readdir(workspace)).includes('denied'));
    const accepted = await dispatch(ctx, 'sheet_diff_review', { reportJson: compared.value.paths.json, reviewJson: reviewPath });
    assert.equal(accepted.isError, false, errorText(accepted));
    assert.deepEqual(accepted.value.comments[0].change, change);
    await writeFile(reviewPath, JSON.stringify({ ...review, sourceHashes: { ...review.sourceHashes, before: '0'.repeat(64) } }));
    const stale = await dispatch(ctx, 'sheet_diff_review', { reportJson: compared.value.paths.json, reviewJson: reviewPath });
    assert.equal(stale.isError, true);
  } finally { await ctx.fiber.dispose(); }
});

test('canonical containment blocks traversal and symlink escapes for reads and output writes', async () => {
  const workspace = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'sheetdiff-outside-test-'));
  await writeFile(join(outside, 'before.csv'), before);
  await symlink(join(outside, 'before.csv'), join(workspace, 'escaped.csv'));
  await symlink(outside, join(workspace, 'escaped-output'));
  const { ctx } = await createHost(workspace, { mode: 'danger-full-access' });
  try {
    for (const args of [
      { ...compareArgs, before: join(outside, 'before.csv') },
      { ...compareArgs, before: 'escaped.csv' },
      { ...compareArgs, outputDir: 'escaped-output' },
      { ...compareArgs, outputDir: '../escape-report' },
    ]) {
      const result = await dispatch(ctx, 'sheet_diff_compare', args);
      assert.equal(result.isError, true);
      assert.match(errorText(result), /outside the session workspace/);
    }
    assert.deepEqual(await readdir(outside), ['before.csv']);
  } finally { await ctx.fiber.dispose(); }
});

test('schema validation, invalid header rows, empty keys and cancellation prevent artifact writes', async () => {
  const workspace = await fixture();
  const { ctx } = await createHost(workspace);
  try {
    for (const args of [
      { ...compareArgs, keyColumns: [] },
      { ...compareArgs, keyColumns: ['id', 'id'] },
      { ...compareArgs, headerRow: 0 },
      { ...compareArgs, headerRow: 5 },
      { ...compareArgs, keyColumns: 'id' },
    ]) {
      assert.equal((await dispatch(ctx, 'sheet_diff_compare', args)).isError, true);
    }
    const controller = new AbortController();
    controller.abort();
    const aborted = await dispatch(ctx, 'sheet_diff_compare', compareArgs, controller.signal);
    assert.equal(aborted.isError, true);
    assert.ok(!(await readdir(workspace)).includes('reports'));
  } finally { await ctx.fiber.dispose(); }
});

test('cancellation during input reading propagates to the real provider and prevents reports', async () => {
  const workspace = await fixture();
  const { ctx } = await createHost(workspace);
  const controller = new AbortController();
  const read = ctx.fs.readBytes.bind(ctx.fs);
  let readCount = 0;
  ctx.fs.readBytes = async (target, signal, limit) => {
    assert.equal(signal, controller.signal);
    assert.ok(Number.isSafeInteger(limit) && limit > 0, 'the provider receives a complete-content bound');
    const content = await read(target, signal, limit);
    readCount += 1;
    controller.abort();
    return content;
  };
  try {
    const result = await dispatch(ctx, 'sheet_diff_compare', compareArgs, controller.signal);
    assert.equal(result.isError, true);
    assert.equal(readCount, 1);
    assert.ok(!(await readdir(workspace)).includes('reports'));
  } finally { await ctx.fiber.dispose(); }
});

test('failed HTML publication identifies the retained JSON report without deleting it', async () => {
  const workspace = await fixture();
  const { ctx } = await createHost(workspace);
  const write = ctx.fs.writeText.bind(ctx.fs);
  ctx.fs.writeText = async (target, ...args) => {
    if (target.displayPath.endsWith('.html')) throw new Error('simulated backend publication failure');
    return write(target, ...args);
  };
  try {
    const result = await dispatch(ctx, 'sheet_diff_compare', compareArgs);
    assert.equal(result.isError, true);
    assert.match(errorText(result), /JSON report was created.*HTML publication failed/);
    const artifacts = await readdir(join(workspace, 'reports'));
    assert.equal(artifacts.length, 1);
    assert.ok(artifacts[0].endsWith('.json'));
  } finally { await ctx.fiber.dispose(); }
});
