/** Check imported report structure; hashes identify inputs, not a digital signature. */
export function validateReport(report) {
  const fail = () => { throw new Error('Invalid SheetDiff report'); };
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const string = (v) => typeof v === 'string';
  const scalar = (v) => v === null || string(v) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
  const atomTypes = ['blank', 'string', 'number', 'boolean', 'date', 'error'];
  const atom = (v) => object(v) && atomTypes.includes(v.type) && scalar(v.value);
  const cell = (v) => v === null || (object(v) && [...atomTypes, 'formula'].includes(v.type) && scalar(v.value)
    && (v.formula === null || string(v.formula)) && (v.cache === null || atom(v.cache)));
  const row = (v) => v === null || (Number.isSafeInteger(v) && v > 0);
  const kinds = ['sheet-added', 'sheet-removed', 'column-added', 'column-removed', 'row-added', 'row-removed', 'cell-changed'];
  if (!object(report) || report.schemaVersion !== 1 || !string(report.reportId) || !report.reportId
    || !object(report.sources) || !object(report.options) || !object(report.summary)
    || !Array.isArray(report.warnings) || !report.warnings.every(string)
    || !Array.isArray(report.changes) || report.changes.length > 10000) fail();
  for (const side of ['before', 'after']) {
    const source = report.sources[side];
    if (!object(source) || !string(source.name) || !/^[a-f0-9]{64}$/.test(source.sha256)) fail();
  }
  if (!Array.isArray(report.options.keyColumns) || !report.options.keyColumns.length
    || !report.options.keyColumns.every(string) || !row(report.options.headerRow) || report.options.headerRow === null
    || !(report.options.sheet === null || string(report.options.sheet))) fail();
  for (const key of ['addedRows', 'removedRows', 'changedCells', 'addedColumns', 'removedColumns', 'addedSheets', 'removedSheets']) {
    if (!Number.isSafeInteger(report.summary[key]) || report.summary[key] < 0) fail();
  }
  const ids = new Set();
  const counters = { 'row-added': 'addedRows', 'row-removed': 'removedRows', 'cell-changed': 'changedCells', 'column-added': 'addedColumns', 'column-removed': 'removedColumns', 'sheet-added': 'addedSheets', 'sheet-removed': 'removedSheets' };
  const counts = Object.fromEntries(Object.values(counters).map((key) => [key, 0]));
  for (const change of report.changes) {
    if (!object(change) || !string(change.id) || !change.id || ids.has(change.id) || !kinds.includes(change.kind)
      || !string(change.sheet) || !(change.key === null || (Array.isArray(change.key) && change.key.every(string)))
      || !(change.column === null || string(change.column)) || !cell(change.before) || !cell(change.after)
      || !row(change.rowBefore) || !row(change.rowAfter) || !Array.isArray(change.aspects)
      || !change.aspects.every((v) => ['value', 'type', 'formula', 'cache'].includes(v))) fail();
    ids.add(change.id);
    counts[counters[change.kind]]++;
    if (change.fields !== undefined && (!Array.isArray(change.fields) || !change.fields.every((f) =>
      object(f) && string(f.column) && cell(f.before) && cell(f.after)))) fail();
  }
  for (const [key, count] of Object.entries(counts)) if (report.summary[key] !== count) fail();
  return report;
}

/** Validate a review sidecar. Both validators are embedded in the offline report. */
export function validateReview(report, review) {
  validateReport(report);
  const fail = (reason) => { throw new Error(`Invalid review: ${reason}`); };
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, expected) => object(v) && Object.keys(v).sort().join(',') === expected.slice().sort().join(',');
  if (!object(report) || report.schemaVersion !== 1 || typeof report.reportId !== 'string'
    || !object(report.sources?.before) || !object(report.sources?.after) || !Array.isArray(report.changes)) fail('invalid report');
  if (!keys(review, ['schemaVersion', 'reportId', 'sourceHashes', 'comments']) || review.schemaVersion !== 1) fail('unsupported schema');
  if (review.reportId !== report.reportId) fail('this review belongs to a different report');
  if (!keys(review.sourceHashes, ['before', 'after'])
    || review.sourceHashes.before !== report.sources.before.sha256
    || review.sourceHashes.after !== report.sources.after.sha256) fail('source hashes do not match');
  if (!Array.isArray(review.comments) || review.comments.length > 10000) fail('too many comments');
  const known = new Set(report.changes.map((c) => c.id));
  const seen = new Set();
  const comments = review.comments.map((c) => {
    if (!keys(c, ['changeId', 'text']) || typeof c.changeId !== 'string' || !known.has(c.changeId)) fail('unknown change id');
    if (seen.has(c.changeId)) fail('duplicate change id');
    seen.add(c.changeId);
    if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 4000) fail('comment must contain 1–4000 characters');
    return { changeId: c.changeId, text: c.text };
  });
  const result = {
    schemaVersion: 1,
    reportId: review.reportId,
    sourceHashes: { before: review.sourceHashes.before, after: review.sourceHashes.after },
    comments,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 5 * 1024 * 1024) fail('review exceeds 5 MiB');
  return result;
}
