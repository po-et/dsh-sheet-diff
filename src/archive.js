import yauzl from 'yauzl';

export const ARCHIVE_LIMITS = Object.freeze({ entries: 2000, expandedBytes: 64 * 1024 * 1024, partBytes: 8 * 1024 * 1024 });
const MAX_XML_CELLS = 100000;

function checkedCoordinate(value, part) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  let column = 0;
  if (match) for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  if (!match || column > 16384 || Number(match[2]) > 1048576) throw new Error(`XLSX has an invalid or out-of-bounds cell coordinate in ${part}: ${value}`);
  return { column, row: Number(match[2]) };
}

function checkedRange(value, part) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`XLSX has a missing cell range in ${part}.`);
  const coordinates = value.split(':');
  if (coordinates.length > 2) throw new Error(`XLSX has an invalid range in ${part}: ${value}`);
  const first = checkedCoordinate(coordinates[0], part);
  const last = coordinates.length === 1 ? first : checkedCoordinate(coordinates[1], part);
  return (Math.abs(last.column - first.column) + 1) * (Math.abs(last.row - first.row) + 1);
}

// Scan XML opening tags once, without a backtracking regex over untrusted XML.
// ExcelJS still validates XML; this preflight limits the work its range expansion can create.
function* openingTags(xml, part) {
  const namePattern = /[A-Za-z_][\w.:-]*/y;
  let cursor = 0;
  while ((cursor = xml.indexOf('<', cursor)) !== -1) {
    let terminator;
    if (xml.startsWith('<!--', cursor)) terminator = '-->';
    else if (xml.startsWith('<![CDATA[', cursor)) terminator = ']]>';
    else if (xml.startsWith('<?', cursor)) terminator = '?>';
    if (terminator) {
      const end = xml.indexOf(terminator, cursor + 2);
      if (end === -1) throw new Error(`Malformed XML in ${part}.`);
      cursor = end + terminator.length;
      continue;
    }
    if (xml[cursor + 1] === '/') {
      const end = xml.indexOf('>', cursor + 2);
      if (end === -1) throw new Error(`Malformed XML in ${part}.`);
      const closingStart = cursor;
      namePattern.lastIndex = cursor + 2;
      const tag = namePattern.exec(xml);
      if (!tag) throw new Error(`Malformed XML tag in ${part}.`);
      cursor = end + 1;
      yield { name: tag[0].split(':').pop(), closing: true, start: closingStart, end: cursor };
      continue;
    }
    const start = cursor;
    namePattern.lastIndex = ++cursor;
    const tag = namePattern.exec(xml);
    if (!tag) throw new Error(`Malformed XML tag in ${part}.`);
    cursor = namePattern.lastIndex;
    const attributes = new Map();
    let selfClosing = false;
    while (cursor < xml.length && xml[cursor] !== '>') {
      if (cursor - start > 65536) throw new Error(`XML tag exceeds the 64 KiB preflight limit in ${part}.`);
      if (/\s/.test(xml[cursor])) { cursor++; continue; }
      if (xml[cursor] === '/' && xml[cursor + 1] === '>') { selfClosing = true; cursor++; break; }
      namePattern.lastIndex = cursor;
      const attribute = namePattern.exec(xml);
      if (!attribute) throw new Error(`Malformed XML attribute in ${part}.`);
      cursor = namePattern.lastIndex;
      while (/\s/.test(xml[cursor] ?? '')) cursor++;
      if (xml[cursor++] !== '=') throw new Error(`Malformed XML attribute in ${part}.`);
      while (/\s/.test(xml[cursor] ?? '')) cursor++;
      const quote = xml[cursor++];
      if (quote !== '"' && quote !== "'") throw new Error(`Malformed XML attribute in ${part}.`);
      const end = xml.indexOf(quote, cursor);
      if (end === -1 || end - start > 65536) throw new Error(`Malformed or oversized XML attribute in ${part}.`);
      if (attributes.has(attribute[0])) throw new Error(`Duplicate XML attribute in ${part}.`);
      attributes.set(attribute[0], xml.slice(cursor, end));
      cursor = end + 1;
    }
    if (xml[cursor] !== '>') throw new Error(`Malformed XML tag in ${part}.`);
    cursor++;
    yield { name: tag[0].split(':').pop(), attributes, selfClosing, start, end: cursor };
  }
}

function inspectWorksheetXml(xml, part, budget) {
  let cell;
  const finishCell = () => {
    if (cell?.formula && cell.type === 'str' && cell.emptyCache) throw new Error(`Unsupported empty string formula cache in ${part} at ${cell.reference ?? 'an unaddressed cell'}; the XLSX parser cannot preserve this cache exactly.`);
    cell = undefined;
  };
  for (const tag of openingTags(xml, part)) {
    const { name, attributes } = tag;
    if (tag.closing) {
      if (name === 'v' && cell?.cacheBodyStart !== undefined) {
        const text = xml.slice(cell.cacheBodyStart, tag.start).replace(/<!--[\s\S]*?-->/g, '').replaceAll('<![CDATA[', '').replaceAll(']]>', '');
        cell.emptyCache = text.length === 0;
        delete cell.cacheBodyStart;
      }
      if (name === 'c') finishCell();
      continue;
    }
    if (name === 'c') {
      finishCell();
      cell = { type: attributes.get('t'), reference: attributes.get('r'), formula: false, emptyCache: false };
      budget.cells += 1;
      if (budget.cells > MAX_XML_CELLS) throw new Error(`XLSX exceeds ${MAX_XML_CELLS} serialized cells before parsing, including styled empty cells.`);
      if (attributes.has('r')) checkedCoordinate(attributes.get('r'), part);
    } else if (name === 'row') {
      budget.rows += 1;
      if (budget.rows > MAX_XML_CELLS) throw new Error(`XLSX exceeds ${MAX_XML_CELLS} serialized rows before parsing.`);
      const reference = attributes.get('r');
      if (reference !== undefined && (!/^[1-9]\d{0,6}$/.test(reference) || Number(reference) > 1048576)) throw new Error(`XLSX has an invalid or out-of-bounds row coordinate in ${part}: ${reference}`);
    } else if (name === 'dimension') {
      if (attributes.has('ref')) checkedRange(attributes.get('ref'), part);
    } else if (name === 'mergeCell') {
      budget.merges += 1;
      budget.mergedCells += checkedRange(attributes.get('ref'), part);
      if (budget.merges > 2000 || budget.mergedCells > MAX_XML_CELLS) throw new Error(`XLSX merged ranges exceed ${MAX_XML_CELLS} expanded cells or 2000 ranges before parsing.`);
    } else if (name === 'col') {
      const minimum = attributes.get('min');
      const maximum = attributes.get('max');
      if (!/^[1-9]\d{0,4}$/.test(minimum ?? '') || !/^[1-9]\d{0,4}$/.test(maximum ?? '') || Number(maximum) > 16384 || Number(minimum) > Number(maximum)) throw new Error(`XLSX has an invalid or out-of-bounds column range in ${part}.`);
      budget.columns += Number(maximum) - Number(minimum) + 1;
      if (budget.columns > MAX_XML_CELLS) throw new Error(`XLSX column definitions exceed ${MAX_XML_CELLS} expanded columns before parsing.`);
    } else if (name === 'dataValidation') {
      const ranges = attributes.get('sqref')?.trim().split(/\s+/) ?? [];
      if (ranges.length === 0) throw new Error(`XLSX has a missing data-validation range in ${part}.`);
      for (const range of ranges) budget.validationCells += checkedRange(range, part);
      if (budget.validationCells > MAX_XML_CELLS) throw new Error(`XLSX data-validation ranges exceed ${MAX_XML_CELLS} expanded cells before parsing.`);
    } else if (name === 'f' && cell) {
      cell.formula = true;
    } else if (name === 'v' && cell) {
      if (tag.selfClosing) cell.emptyCache = true;
      else cell.cacheBodyStart = tag.end;
    }
  }
  finishCell();
}

export function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('Comparison cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

/** Inspect and fully stream every ZIP part before handing the archive to ExcelJS. No extraction. */
export async function inspectXlsxArchive(bytes, { signal } = {}) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let zip;
    let activeStream;
    let settled = false;
    let entries = 0;
    let expandedBytes = 0;
    const names = new Set();
    const warnings = new Set();
    const xmlBudget = { cells: 0, rows: 0, merges: 0, mergedCells: 0, columns: 0, validationCells: 0 };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      activeStream?.destroy();
      zip?.close();
      if (error) reject(error);
      else resolve({ warnings: [...warnings].sort() });
    };
    const onAbort = () => {
      const error = new Error('Comparison cancelled.');
      error.name = 'AbortError';
      finish(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, openedZip) => {
      if (error) return finish(new Error(`Invalid XLSX archive: ${error.message}`));
      zip = openedZip;
      if (settled) return zip.close();
      zip.on('error', error => finish(new Error(`Invalid XLSX archive: ${error.message}`)));
      zip.on('end', () => {
        if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
          return finish(new Error('Unsupported ZIP: an XLSX workbook is required.'));
        }
        finish();
      });
      zip.on('entry', entry => {
        try {
          checkAbort(signal);
          const name = entry.fileName;
          entries += 1;
          if (entries > ARCHIVE_LIMITS.entries) throw new Error(`XLSX archive exceeds ${ARCHIVE_LIMITS.entries} entries.`);
          if (names.has(name)) throw new Error(`Duplicate XLSX archive entry: ${name}`);
          names.add(name);
          if (name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').some(piece => piece === '..' || piece === '.') || /%2e|%2f|%5c/i.test(name) || name.includes('\0')) {
            throw new Error(`Unsafe XLSX archive entry: ${name}`);
          }
          if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error('Encrypted XLSX archives are unsupported.');
          if (![0, 8].includes(entry.compressionMethod)) throw new Error('Unsupported XLSX ZIP compression.');
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (unixMode === 0xa000) throw new Error('Symbolic links in XLSX archives are unsupported.');
          if (entry.uncompressedSize > ARCHIVE_LIMITS.partBytes) throw new Error(`XLSX part exceeds ${ARCHIVE_LIMITS.partBytes / 1024 / 1024} MiB: ${name}`);
          if (/(?:^|\/)(?:vbaProject\.bin|vbaData\.xml)(?:$|\/)|^xl\/(?:externalLinks|activeX|embeddings|connections|queryTables)(?:\/|\.)/i.test(name)) {
            throw new Error(`Unsupported XLSX active or external content: ${name}`);
          }
          if (/^xl\/(?:drawings|charts|pivotTables|pivotCache|comments|threadedComments)(?:\/|\d|\.)/i.test(name)) {
            warnings.add('Drawings, charts, pivot tables and comments are outside the comparison scope.');
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return finish(new Error(`Invalid XLSX part ${name}: ${streamError.message}`));
            if (settled) return stream.destroy();
            activeStream = stream;
            let actualSize = 0;
            const inspectXml = /\.(?:xml|rels)$/i.test(name);
            const chunks = [];
            stream.on('error', partError => finish(new Error(`Invalid XLSX part ${name}: ${partError.message}`)));
            stream.on('data', chunk => {
              actualSize += chunk.length;
              expandedBytes += chunk.length;
              if (actualSize > ARCHIVE_LIMITS.partBytes || expandedBytes > ARCHIVE_LIMITS.expandedBytes) {
                return finish(new Error(`XLSX expanded content exceeds the resource limit (${ARCHIVE_LIMITS.expandedBytes / 1024 / 1024} MiB total, ${ARCHIVE_LIMITS.partBytes / 1024 / 1024} MiB per part).`));
              }
              if (inspectXml) chunks.push(chunk);
            });
            stream.on('end', () => {
              if (settled) return;
              activeStream = undefined;
              try {
                checkAbort(signal);
                if (actualSize !== entry.uncompressedSize) throw new Error(`XLSX part size does not match its metadata: ${name}`);
                if (inspectXml) {
                  const xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
                  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`XML entity declarations are unsupported: ${name}`);
                  if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) inspectWorksheetXml(xml, name, xmlBudget);
                  if (name === '[Content_Types].xml' && /macroEnabled|vbaProject|activeX/i.test(xml)) throw new Error('Macro-enabled or active XLSX content is unsupported.');
                  if (/TargetMode\s*=\s*["']External["']/i.test(xml)) {
                    warnings.add('External hyperlinks are displayed as text; their targets are not compared or opened.');
                    // Formula external workbook links are rejected by their dedicated archive parts.
                  }
                }
                zip.readEntry();
              } catch (partError) { finish(partError); }
            });
          });
        } catch (entryError) { finish(entryError); }
      });
      zip.readEntry();
    });
  });
}
