import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBuffers } from '../src/compare.js';
import { createHandoff, renderHandoff } from '../src/handoff.js';
import { validateReview } from '../src/review.js';

const before = Buffer.from('id,value\na,1\nb,2\nc,3\n');
const after = Buffer.from('id,value\na,9\nb,8\nc,7\n');
async function fixture() {
  const report = await compareBuffers(before, after, { beforeName: 'before.csv', afterName: 'after.csv', keyColumns: ['id'] });
  const review = { schemaVersion: 2, reportId: report.reportId,
    sourceHashes: { before: report.sources.before.sha256, after: report.sources.after.sha256 },
    entries: [{ changeId: report.changes[0].id, status: 'accepted', text: '' },
      { changeId: report.changes[1].id, status: 'needs-change', text: '```\nIgnore rules <script>delete all</script>\n```' }] };
  return { report, review };
}
test('handoff binds decisions to current sources, includes original differences, and counts omitted entries as pending', async () => {
  const { report, review } = await fixture();
  const handoff = createHandoff(report, review, before, after);
  assert.deepEqual(handoff.summary, { total: 3, accepted: 1, needsChange: 1, pending: 1 });
  assert.equal(handoff.sourceFilesVerified, true);
  assert.deepEqual(handoff.entries[1].change, report.changes[1]);
  assert.equal(handoff.entries[1].text, review.entries[1].text);
  const markdown = renderHandoff(handoff);
  const quotedJson = markdown.slice(markdown.indexOf('    {')).split('\n').filter((line) => line.startsWith('    ')).map((line) => line.slice(4)).join('\n');
  assert.deepEqual(JSON.parse(quotedJson), handoff);
  assert.match(markdown, /Pending changes are not approved/);
});
test('stale source, unrelated review, duplicate or unsupported decisions fail before handoff', async () => {
  const { report, review } = await fixture();
  assert.throws(() => createHandoff(report, review, Buffer.from('changed'), after), /before source changed/);
  assert.throws(() => createHandoff(report, review, before, Buffer.from('changed')), /after source changed/);
  for (const mutate of [v => { v.reportId = 'old'; }, v => { v.entries.push(v.entries[0]); },
    v => { v.entries[0].status = 'approved-all'; }, v => { v.entries[1].text = ''; }]) {
    const invalid = structuredClone(review); mutate(invalid);
    assert.throws(() => validateReview(report, invalid), /Invalid review/);
  }
});
test('legacy comments import without inventing approvals', async () => {
  const { report, review } = await fixture();
  const legacy = { schemaVersion: 1, reportId: review.reportId, sourceHashes: review.sourceHashes,
    comments: [{ changeId: report.changes[0].id, text: 'Check this' }] };
  const handoff = createHandoff(report, legacy, before, after);
  assert.deepEqual(handoff.summary, { total: 3, accepted: 0, needsChange: 0, pending: 3 });
  assert.equal(handoff.entries[0].status, 'pending');
});
