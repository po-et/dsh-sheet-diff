import ExcelJS from 'exceljs';
import { checkAbort, inspectXlsxArchive } from './archive.js';

export const PARSE_LIMITS = Object.freeze({ inputBytes: 20 * 1024 * 1024, populatedCells: 100000, columns: 16384, rows: 1048576 });
export const BLANK_CELL = Object.freeze({ type: 'blank', value: null, formula: null, cache: null });

function scalar(value) {
  if (value === undefined || value === null) return { type: 'blank', value: null };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (value instanceof Date && Number.isFinite(value.getTime())) return { type: 'date', value: value.toISOString() };
  if (typeof value === 'object' && typeof value.error === 'string') return { type: 'error', value: value.error };
  throw new Error('Unsupported spreadsheet cell value.');
}

function spreadsheetCell(cell, warnings) {
  if (cell.type === ExcelJS.ValueType.Merge) return BLANK_CELL;
  const raw = cell.value;
  if (raw && typeof raw === 'object' && ('formula' in raw || 'sharedFormula' in raw)) {
    const formula = cell.formula;
    if (typeof formula !== 'string' || formula.length === 0) throw new Error(`Unsupported or unresolved formula at ${cell.address}.`);
    // Excel escapes quotes inside string literals by doubling them. Literal text
    // can resemble an external reference without referring to another workbook.
    const literalsMasked = formula.replace(/"(?:[^"]|"")*"/g, '""');
    // INDIRECT can turn its text argument into a workbook reference. Keep the
    // original conservative check for these formulas rather than resolving it.
    const references = /\bINDIRECT\s*\(/i.test(literalsMasked) ? formula : literalsMasked;
    if (/\[[^\]]+\][^!]*!/.test(references)) throw new Error(`External workbook formula is unsupported at ${cell.address}.`);
    // ExcelJS's cell.value getter drops 0/false caches, while cell.result retains them.
    return { type: 'formula', value: null, formula, cache: cell.result === undefined ? null : scalar(cell.result) };
  }
  let value = raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.richText)) {
    value = raw.richText.map(run => run.text).join('');
    warnings.add('Rich text formatting is ignored; visible text is compared.');
  } else if (raw && typeof raw === 'object' && typeof raw.hyperlink === 'string') {
    value = raw.text ?? raw.hyperlink;
    warnings.add('Hyperlinks are displayed as text; their targets are not compared or opened.');
  }
  return { ...scalar(value), formula: null, cache: null };
}

function meaningful(cell) { return cell.type !== 'blank' && !(cell.type === 'string' && cell.value === ''); }

function tabulate(name, rawRows, headerRow) {
  const header = rawRows.get(headerRow) ?? new Map();
  let maxColumn = 0;
  let dataBeforeHeader = false;
  for (const [rowNumber, row] of rawRows) {
    for (const [column, cell] of row) {
      if (!meaningful(cell)) continue;
      if (rowNumber < headerRow) dataBeforeHeader = true;
      else maxColumn = Math.max(maxColumn, column);
    }
  }
  if (maxColumn === 0 && dataBeforeHeader) throw new Error(`Sheet ${JSON.stringify(name)} has header row ${headerRow} after all nonempty data; choose an existing header row.`);
  const columns = [];
  const seen = new Set();
  for (let column = 1; column <= maxColumn; column++) {
    const cell = header.get(column) ?? BLANK_CELL;
    if (cell.type !== 'string' || cell.value.trim().length === 0) {
      throw new Error(`Sheet ${JSON.stringify(name)} has a missing or non-text header in column ${column} (header row ${headerRow}).`);
    }
    if (seen.has(cell.value)) throw new Error(`Sheet ${JSON.stringify(name)} has an ambiguous duplicate header: ${JSON.stringify(cell.value)}.`);
    seen.add(cell.value);
    columns.push(cell.value);
  }
  const rows = [];
  for (const [rowNumber, row] of rawRows) {
    if (rowNumber <= headerRow || ![...row.values()].some(meaningful)) continue;
    // Keep sparse rows sparse: a distant column must not allocate a whole rectangular grid.
    const cells = new Map([...row].filter(([column]) => column <= columns.length).map(([column, cell]) => [columns[column - 1], cell]));
    rows.push({ rowNumber, cells });
  }
  return { name, columns, rows };
}

/** A strict CSV record parser. Quoting and embedded newlines preserve the original field text. */
export function parseCsvRecords(text, signal) {
  const records = [];
  let row = [];
  let fieldStart = 0;
  let fieldEnd = 0;
  let state = 'start';
  let totalFields = 0;
  let recordStarted = false;
  const addField = end => {
    const field = state === 'closed' ? text.slice(fieldStart, fieldEnd).replaceAll('""', '"') : text.slice(fieldStart, end);
    totalFields += 1;
    if (totalFields > PARSE_LIMITS.populatedCells) throw new Error(`CSV exceeds ${PARSE_LIMITS.populatedCells} fields, including empty fields.`);
    row.push(field);
    if (row.length > PARSE_LIMITS.columns) throw new Error(`CSV exceeds ${PARSE_LIMITS.columns} columns.`);
    state = 'start';
  };
  const addRow = end => {
    addField(end);
    records.push(row);
    if (records.length > PARSE_LIMITS.rows) throw new Error(`CSV exceeds ${PARSE_LIMITS.rows} records.`);
    row = [];
    recordStarted = false;
  };
  for (let index = 0; index < text.length; index++) {
    if (index % 4096 === 0) checkAbort(signal);
    const character = text[index];
    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') index++;
        else { fieldEnd = index; state = 'closed'; }
      }
      continue;
    }
    if (character === ',') { addField(index); fieldStart = index + 1; recordStarted = true; continue; }
    if (character === '\n' || character === '\r') {
      const end = index;
      if (character === '\r' && text[index + 1] === '\n') index++;
      addRow(end);
      fieldStart = index + 1;
      continue;
    }
    if (state === 'closed') throw new Error('Malformed CSV: characters after a closing quote.');
    if (character === '"') {
      if (state !== 'start') throw new Error('Malformed CSV: a quote inside an unquoted field.');
      state = 'quoted';
      fieldStart = index + 1;
      recordStarted = true;
      continue;
    }
    state = 'unquoted';
    recordStarted = true;
  }
  if (state === 'quoted') throw new Error('Malformed CSV: an unterminated quoted field.');
  if (recordStarted || row.length > 0 || state === 'closed') addRow(text.length);
  checkAbort(signal);
  return records;
}

function validateBytes(bytes, name) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Spreadsheet input must be a Buffer or Uint8Array.');
  if (bytes.byteLength > PARSE_LIMITS.inputBytes) throw new Error(`Input ${JSON.stringify(name)} exceeds ${PARSE_LIMITS.inputBytes / 1024 / 1024} MiB.`);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export async function parseBuffer(bytes, name, { headerRow = 1, sheet, signal } = {}) {
  checkAbort(signal);
  const buffer = validateBytes(bytes, name);
  if (typeof name !== 'string' || name.length === 0) throw new Error('A source filename is required.');
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > PARSE_LIMITS.rows) throw new Error('headerRow must be a positive integer within spreadsheet row limits.');
  if (sheet !== undefined && (typeof sheet !== 'string' || sheet.length === 0)) throw new Error('sheet must be a nonempty worksheet name.');
  const extension = name.toLowerCase().match(/\.([^.\/\\]+)$/)?.[1];
  const warnings = new Set(['Formatting, number formats, merged layout, hidden rows/columns and workbook presentation are outside the comparison scope.']);
  if (extension === 'csv') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new Error('CSV must be valid UTF-8.'); }
    if (text.startsWith('\uFEFF')) text = text.slice(1);
    if (text.includes('\0')) throw new Error('CSV contains a NUL character and may be an unsupported binary file.');
    const records = parseCsvRecords(text, signal);
    const rawRows = new Map(records.map((row, index) => [index + 1, new Map(row.map((value, column) => [column + 1, { type: 'string', value, formula: null, cache: null }]))]));
    warnings.add('CSV fields remain strings; delimiter, encoding and value types are not inferred.');
    const parsed = tabulate('CSV', rawRows, headerRow);
    if (sheet !== undefined && sheet !== 'CSV') throw new Error('CSV has one logical sheet named CSV.');
    return { sheets: [parsed], warnings: [...warnings].sort() };
  }
  if (extension !== 'xlsx') throw new Error('Only .csv and .xlsx files are supported; legacy .xls and macro-enabled workbooks are unsupported.');
  const archive = await inspectXlsxArchive(buffer, { signal });
  for (const warning of archive.warnings) warnings.add(warning);
  checkAbort(signal);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch (error) { throw new Error(`Invalid XLSX workbook: ${error.message}`); }
  checkAbort(signal);
  warnings.add('Formulas are compared as literal expressions and cached results. Formulas are never recalculated; row/column moves can change references without changing meaning.');
  warnings.add('Data validation rules, named ranges and conditional formatting are outside the comparison scope.');
  const sheets = [];
  let populatedCells = 0;
  for (const worksheet of workbook.worksheets) {
    checkAbort(signal);
    // Count the complete workbook even when one sheet is selected.
    const rawRows = new Map();
    worksheet.eachRow({ includeEmpty: false }, row => {
      checkAbort(signal);
      const cells = new Map();
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        const value = spreadsheetCell(cell, warnings);
        if (value.type !== 'blank') populatedCells += 1;
        if (populatedCells > PARSE_LIMITS.populatedCells) throw new Error(`XLSX exceeds ${PARSE_LIMITS.populatedCells} populated cells.`);
        cells.set(column, value);
      });
      rawRows.set(row.number, cells);
    });
    if (sheet === undefined || sheet === worksheet.name) sheets.push(tabulate(worksheet.name, rawRows, headerRow));
  }
  return { sheets, warnings: [...warnings].sort() };
}
