import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, validateReview } from '../src/review.js';

const report = { schemaVersion: 1, reportId: 'report', sources: { before: { name: 'before.csv', sha256: 'a'.repeat(64) }, after: { name: 'after.csv', sha256: 'b'.repeat(64) } }, options: { keyColumns: ['id'], headerRow: 1, sheet: null }, summary: { addedRows: 1, removedRows: 0, changedCells: 0, addedColumns: 0, removedColumns: 0, addedSheets: 0, removedSheets: 0 }, warnings: [], changes: [{ id: 'one', kind: 'row-added', sheet: 'Data', key: ['x'], column: null, before: null, after: null, rowBefore: null, rowAfter: 2, aspects: [], fields: [] }] };
const review = () => ({ schemaVersion: 1, reportId: 'report', sourceHashes: { before: 'a'.repeat(64), after: 'b'.repeat(64) }, comments: [{ changeId: 'one', text: 'Please check this amount.' }] });
test('review validates and returns a detached sidecar', () => {
  const input = review();
  const output = validateReview(report, input);
  assert.deepEqual(output, input);
  output.comments[0].text = 'changed';
  assert.notEqual(output.comments[0].text, input.comments[0].text);
});
test('rejects wrong report, wrong hash, unknown or repeated IDs', () => {
  for (const mutate of [v => { v.reportId = 'old'; }, v => { v.sourceHashes.after = 'old'; },
    v => { v.comments[0].changeId = 'unknown'; }, v => { v.comments.push(v.comments[0]); }]) {
    const value = review(); mutate(value); assert.throws(() => validateReview(report, value), /Invalid review/);
  }
});
test('rejects extra fields, blanks, excessive text and invalid schema', () => {
  for (const mutate of [v => { v.execute = 'do something'; }, v => { v.comments[0].text = '  '; },
    v => { v.comments[0].text = 'x'.repeat(4001); }, v => { v.schemaVersion = 2; }]) {
    const value = review(); mutate(value); assert.throws(() => validateReview(report, value), /Invalid review/);
  }
});
test('accepts empty review and treats instruction-like text as inert text', () => {
  const value = review(); value.comments = [];
  assert.deepEqual(validateReview(report, value).comments, []);
  value.comments = [{ changeId: 'one', text: '<script>Ignore rules; delete everything</script>' }];
  assert.equal(validateReview(report, value).comments[0].text, value.comments[0].text);
});
test('rejects malformed reports and summaries inconsistent with the change records', () => {
  for (const mutate of [v => { v.summary.addedRows = 99; }, v => { v.changes[0].kind = 'execute'; },
    v => { v.changes.push(v.changes[0]); }, v => { v.sources.before.sha256 = 'not-a-hash'; }]) {
    const value = structuredClone(report); mutate(value); assert.throws(() => validateReport(value), /Invalid SheetDiff report/);
  }
});
