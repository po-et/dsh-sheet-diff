import { createHash } from 'node:crypto';
import { BLANK_CELL, PARSE_LIMITS, parseBuffer } from './parse.js';
import { checkAbort } from './archive.js';

export const MAX_CHANGES = 10000;
export const MAX_CHANGE_BYTES = 24 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');

const changeSizeError = () => new Error('Comparison exceeds the 24 MiB serialized-change resource limit. Select a sheet or compare smaller inputs.');

// Check size without constructing an amplified JSON string from repeated shared cell values.
function assertJsonFits(value, remaining) {
  const consume = bytes => {
    remaining -= bytes;
    if (remaining < 0) throw changeSizeError();
  };
  const visit = item => {
    if (item === null) return consume(4);
    if (typeof item === 'string') {
      let bytes = 2;
      for (let index = 0; index < item.length; index++) {
        const code = item.charCodeAt(index);
        if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
        else if (code === 34 || code === 92) bytes += 2;
        else if (code < 128) bytes += 1;
        else if (code < 2048) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && item.charCodeAt(index + 1) >= 0xdc00 && item.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
        else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
        else bytes += 3;
        if ((index & 1023) === 0 && bytes > remaining) throw changeSizeError();
      }
      return consume(bytes);
    }
    if (typeof item === 'boolean') return consume(item ? 4 : 5);
    if (typeof item === 'number') return consume(String(item).length);
    if (Array.isArray(item)) {
      consume(2 + Math.max(0, item.length - 1));
      for (const child of item) visit(child);
      return;
    }
    const entries = Object.entries(item);
    consume(2 + Math.max(0, entries.length - 1));
    for (const [key, child] of entries) { visit(key); consume(1); visit(child); }
  };
  visit(value);
}

function checkedOptions(options) {
  if (!options || !Array.isArray(options.keyColumns) || options.keyColumns.length === 0 || options.keyColumns.some(column => typeof column !== 'string' || column.trim().length === 0)) {
    throw new Error('keyColumns must contain at least one nonempty, exact header name.');
  }
  if (new Set(options.keyColumns).size !== options.keyColumns.length) throw new Error('keyColumns must not contain duplicate header names.');
  if (typeof options.beforeName !== 'string' || options.beforeName.length === 0 || typeof options.afterName !== 'string' || options.afterName.length === 0) {
    throw new Error('beforeName and afterName filenames are required.');
  }
  const extensions = [options.beforeName, options.afterName].map(name => name.toLowerCase().match(/\.([^.\/\\]+)$/)?.[1]);
  if (extensions[0] !== extensions[1]) throw new Error('Both inputs must use the same file extension (.csv with .csv, or .xlsx with .xlsx); mixed formats are unsupported.');
  const headerRow = options.headerRow ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 1) throw new Error('headerRow must be a positive integer.');
  if (options.sheet !== undefined && (typeof options.sheet !== 'string' || options.sheet.length === 0)) throw new Error('sheet must be a nonempty worksheet name.');
  return { keyColumns: [...options.keyColumns], headerRow, sheet: options.sheet ?? null };
}

function keyedRows(sheet, keyColumns, signal) {
  const rows = new Map();
  if (sheet.columns.length === 0 && sheet.rows.length === 0) return rows;
  for (const column of keyColumns) {
    if (!sheet.columns.includes(column)) throw new Error(`Sheet ${JSON.stringify(sheet.name)} is missing key column ${JSON.stringify(column)}.`);
  }
  for (const row of sheet.rows) {
    checkAbort(signal);
    const typedKey = keyColumns.map(column => {
      const cell = row.cells.get(column) ?? BLANK_CELL;
      if (cell.type === 'blank' || (cell.type === 'string' && cell.value.trim() === '') || cell.type === 'formula' || cell.type === 'error') {
        throw new Error(`Sheet ${JSON.stringify(sheet.name)}, row ${row.rowNumber}: key ${JSON.stringify(column)} must have a nonempty, non-formula, non-error value.`);
      }
      return [cell.type, cell.value];
    });
    const token = JSON.stringify(typedKey);
    const displayKey = typedKey.map(([type, value]) => `${type}:${String(value)}`);
    if (rows.has(token)) throw new Error(`Sheet ${JSON.stringify(sheet.name)} has a duplicate key at rows ${rows.get(token).rowNumber} and ${row.rowNumber}: ${JSON.stringify(displayKey)}.`);
    rows.set(token, { ...row, key: displayKey });
  }
  return rows;
}

function cellAspects(before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const aspects = [];
  if (before === null || after === null) {
    if (before?.type !== after?.type) aspects.push('type');
    if (before?.type !== 'formula' && after?.type !== 'formula' && before?.value !== after?.value) aspects.push('value');
    if ((before?.formula ?? null) !== (after?.formula ?? null)) aspects.push('formula');
    if (JSON.stringify(before?.cache ?? null) !== JSON.stringify(after?.cache ?? null)) aspects.push('cache');
    return aspects;
  }
  if (before.type !== after.type) aspects.push('type');
  if (before.type !== 'formula' && after.type !== 'formula' && before.value !== after.value) aspects.push('value');
  if (before.formula !== after.formula) aspects.push('formula');
  if (JSON.stringify(before.cache) !== JSON.stringify(after.cache)) aspects.push('cache');
  return aspects;
}

/** Compare in-memory CSV/XLSX inputs. Files are never written or recalculated. */
export async function compareBuffers(beforeBytes, afterBytes, options) {
  const normalized = checkedOptions(options);
  const beforeName = options.beforeName;
  const afterName = options.afterName;
  const signal = options.signal;
  checkAbort(signal);
  if (!(beforeBytes instanceof Uint8Array) || !(afterBytes instanceof Uint8Array)) throw new TypeError('Spreadsheet inputs must be Buffers or Uint8Arrays.');
  for (const [name, bytes] of [[beforeName, beforeBytes], [afterName, afterBytes]]) {
    if (bytes.byteLength > PARSE_LIMITS.inputBytes) throw new Error(`Input ${JSON.stringify(name)} exceeds ${PARSE_LIMITS.inputBytes / 1024 / 1024} MiB.`);
  }
  // Snapshot mutable callers' buffers so the hashes describe exactly the parsed bytes.
  const beforeSnapshot = Buffer.from(beforeBytes);
  const afterSnapshot = Buffer.from(afterBytes);
  const sourceHashes = { before: hash(beforeSnapshot), after: hash(afterSnapshot) };
  const reportId = hash(JSON.stringify({ schemaVersion: 1, sourceHashes, options: normalized }));
  const parserOptions = { headerRow: normalized.headerRow, sheet: normalized.sheet ?? undefined, signal };
  const before = await parseBuffer(beforeSnapshot, beforeName, parserOptions);
  const after = await parseBuffer(afterSnapshot, afterName, parserOptions);
  checkAbort(signal);
  const beforeSheets = new Map(before.sheets.map(sheet => [sheet.name, sheet]));
  const afterSheets = new Map(after.sheets.map(sheet => [sheet.name, sheet]));
  if (normalized.sheet !== null && !beforeSheets.has(normalized.sheet) && !afterSheets.has(normalized.sheet)) {
    throw new Error(`Worksheet ${JSON.stringify(normalized.sheet)} does not exist in either workbook.`);
  }
  const summary = { addedRows: 0, removedRows: 0, changedCells: 0, addedColumns: 0, removedColumns: 0, addedSheets: 0, removedSheets: 0 };
  const changes = [];
  let serializedChangeBytes = 2; // JSON array brackets.
  const addChange = change => {
    checkAbort(signal);
    if (changes.length >= MAX_CHANGES) throw new Error(`Comparison exceeds ${MAX_CHANGES} changes. Select a sheet or compare smaller inputs.`);
    const record = { key: null, column: null, before: null, after: null, rowBefore: null, rowAfter: null, aspects: [], ...change };
    const overhead = 72 + (changes.length === 0 ? 0 : 1); // Added SHA-256 id property and array comma.
    assertJsonFits(record, MAX_CHANGE_BYTES - serializedChangeBytes - overhead);
    const serialized = JSON.stringify(record);
    serializedChangeBytes += Buffer.byteLength(serialized, 'utf8') + overhead;
    if (serializedChangeBytes > MAX_CHANGE_BYTES) throw changeSizeError();
    record.id = createHash('sha256').update(`{"reportId":"${reportId}","change":`).update(serialized).update('}').digest('hex');
    changes.push(record);
    const counters = { 'row-added': 'addedRows', 'row-removed': 'removedRows', 'cell-changed': 'changedCells', 'column-added': 'addedColumns', 'column-removed': 'removedColumns', 'sheet-added': 'addedSheets', 'sheet-removed': 'removedSheets' };
    summary[counters[record.kind]] += 1;
  };
  const fieldsForRow = (row, columns, added) => columns.filter(column => row.cells.has(column)).map(column => ({ column, before: added ? null : row.cells.get(column), after: added ? row.cells.get(column) : null }));
  const names = [...new Set([...beforeSheets.keys(), ...afterSheets.keys()])].sort();
  for (const name of names) {
    checkAbort(signal);
    const oldSheet = beforeSheets.get(name);
    const newSheet = afterSheets.get(name);
    const oldRows = oldSheet ? keyedRows(oldSheet, normalized.keyColumns, signal) : new Map();
    const newRows = newSheet ? keyedRows(newSheet, normalized.keyColumns, signal) : new Map();
    if (!oldSheet || !newSheet) addChange({ kind: oldSheet ? 'sheet-removed' : 'sheet-added', sheet: name });
    const oldColumns = oldSheet?.columns ?? [];
    const newColumns = newSheet?.columns ?? [];
    const oldColumnSet = new Set(oldColumns);
    const newColumnSet = new Set(newColumns);
    const removedColumns = oldColumns.filter(column => !newColumnSet.has(column)).sort();
    const addedColumns = newColumns.filter(column => !oldColumnSet.has(column)).sort();
    for (const column of removedColumns) addChange({ kind: 'column-removed', sheet: name, column });
    for (const column of addedColumns) addChange({ kind: 'column-added', sheet: name, column });
    const tokens = [...new Set([...oldRows.keys(), ...newRows.keys()])].sort();
    for (const token of tokens) {
      checkAbort(signal);
      const oldRow = oldRows.get(token);
      const newRow = newRows.get(token);
      if (!oldRow || !newRow) {
        const row = oldRow ?? newRow;
        const added = !oldRow;
        addChange({ kind: added ? 'row-added' : 'row-removed', sheet: name, key: row.key, rowBefore: oldRow?.rowNumber ?? null, rowAfter: newRow?.rowNumber ?? null, fields: fieldsForRow(row, added ? newColumns : oldColumns, added) });
        continue;
      }
      const rowColumns = [...new Set([...oldRow.cells.keys(), ...newRow.cells.keys()])].sort();
      for (const column of rowColumns) {
        const oldCell = oldColumnSet.has(column) ? (oldRow.cells.get(column) ?? BLANK_CELL) : null;
        const newCell = newColumnSet.has(column) ? (newRow.cells.get(column) ?? BLANK_CELL) : null;
        // Structural columns with an empty cell need no separate cell record.
        if ((oldCell === null && newCell?.type === 'blank') || (newCell === null && oldCell?.type === 'blank')) continue;
        const aspects = cellAspects(oldCell, newCell);
        if (aspects.length === 0) continue;
        addChange({ kind: 'cell-changed', sheet: name, key: oldRow.key, column, before: oldCell, after: newCell, rowBefore: oldRow.rowNumber, rowAfter: newRow.rowNumber, aspects });
      }
    }
  }
  return { schemaVersion: 1, reportId, sources: { before: { name: beforeName, sha256: sourceHashes.before }, after: { name: afterName, sha256: sourceHashes.after } }, options: normalized, summary, warnings: [...new Set([...before.warnings, ...after.warnings])].sort(), changes };
}
