export type Scalar = string | number | boolean | null;
export type AtomType = 'blank' | 'string' | 'number' | 'boolean' | 'date' | 'error';
export interface Cell {
  type: AtomType | 'formula';
  value: Scalar;
  formula: string | null;
  cache: { type: AtomType; value: Scalar } | null;
}
export interface FieldChange { column: string; before: Cell | null; after: Cell | null }
export interface Change {
  id: string;
  kind: 'sheet-added' | 'sheet-removed' | 'column-added' | 'column-removed' | 'row-added' | 'row-removed' | 'cell-changed';
  sheet: string;
  key: string[] | null;
  column: string | null;
  before: Cell | null;
  after: Cell | null;
  rowBefore: number | null;
  rowAfter: number | null;
  aspects: Array<'value' | 'type' | 'formula' | 'cache'>;
  fields?: FieldChange[];
}
export interface Report {
  schemaVersion: 1;
  reportId: string;
  sources: { before: { name: string; sha256: string }; after: { name: string; sha256: string } };
  options: { keyColumns: string[]; headerRow: number; sheet: string | null };
  summary: { addedRows: number; removedRows: number; changedCells: number; addedColumns: number; removedColumns: number; addedSheets: number; removedSheets: number };
  warnings: string[];
  changes: Change[];
}
export interface CompareOptions {
  beforeName: string;
  afterName: string;
  keyColumns: string[];
  headerRow?: number;
  sheet?: string;
  signal?: AbortSignal;
}
export interface Review {
  schemaVersion: 1;
  reportId: string;
  sourceHashes: { before: string; after: string };
  comments: { changeId: string; text: string }[];
}
