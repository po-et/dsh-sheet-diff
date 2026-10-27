import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateReport } from '../src/review.js';

const script = fileURLToPath(new URL('../scripts/demo.js', import.meta.url));
const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('publishable demo has genuine source hashes and refuses an existing destination', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sheetdiff-demo-'));
  const out = join(cwd, 'publish', 'sample');
  const result = run(cwd, '--out', out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).guide, join(out, 'index.html'));
  assert.deepEqual((await readdir(out)).sort(), ['README.txt', 'index.html', 'orders-after.xlsx', 'orders-before.xlsx', 'report.html', 'report.json']);
  const report = validateReport(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')));
  assert.equal(report.summary.addedRows, 3);
  assert.equal(report.summary.changedCells, 4);
  for (const side of ['before', 'after']) {
    const source = await readFile(join(out, `orders-${side}.xlsx`));
    assert.equal(createHash('sha256').update(source).digest('hex'), report.sources[side].sha256);
  }
  const typeChange = report.changes.find(change => change.kind === 'cell-changed' && change.column === 'Amount' && change.aspects.includes('type'));
  assert.ok(typeChange.key.some(key => key.includes('ORD-104')));
  assert.equal(typeChange.before.type, 'number');
  assert.equal(typeChange.before.value, 500);
  assert.equal(typeChange.after.type, 'string');
  assert.equal(typeChange.after.value, '500');
  const guide = await readFile(join(out, 'index.html'), 'utf8');
  for (const file of ['report.html', 'orders-before.xlsx', 'orders-after.xlsx', 'report.json', 'README.txt']) {
    assert.ok(guide.includes(`href="${file}"`));
  }
  assert.doesNotMatch(guide, /<script\b|<link\b|<img\b|<iframe\b|<form\b/i);
  const html = await readFile(join(out, 'report.html'), 'utf8');
  const payload = html.match(/<script id="report-data"[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(payload), report);
  const filesBeforeRetry = await Promise.all((await readdir(out)).sort().map(async file => [file, await readFile(join(out, file))]));
  assert.notEqual(run(cwd, '--out', out).status, 0);
  for (const [file, data] of filesBeforeRetry) assert.deepEqual(await readFile(join(out, file)), data);
});

test('default demo keeps creating distinct artifacts/demo directories', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sheetdiff-demo-default-'));
  const first = run(cwd), second = run(cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const one = JSON.parse(first.stdout), two = JSON.parse(second.stdout);
  const prefix = join(await realpath(cwd), 'artifacts', 'demo-');
  assert.ok(one.directory.startsWith(prefix));
  assert.ok(two.directory.startsWith(prefix));
  assert.notEqual(one.directory, two.directory);
});
