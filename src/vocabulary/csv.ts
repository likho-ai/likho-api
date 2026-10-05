/**
 * The vocabulary as CSV, in and out. RFC 4180: fields with commas, quotes or line breaks are
 * quoted, a quote inside is doubled, lines end with CR LF (LF is read too). The first line names
 * the columns, in any order and case; columns that are not known are ignored.
 */
import { invalid } from '../common/errors.js';

const MAX_ROWS = 10_000;
const YES = new Set(['true', 'yes', 'y', '1', 'on']);
const NO = new Set(['false', 'no', 'n', '0', 'off']);

/** Rows of cells. Blank lines are dropped; a byte-order mark is ignored. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

export type Cell = string | number | boolean | Date | null | undefined;

export function formatCsv(rows: Cell[][]): string {
  const cell = (value: Cell): string => {
    const text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

type Record_ = Record<string, string> & { __line: number };

/** The rows under a header line as records; `required` columns must be named in the header. */
function table(text: string, required: string[], optional: string[]): Record_[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw invalid('The CSV is empty.');
  const header = rows[0]!.map((name) =>
    name
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
  for (const name of required) {
    if (!header.includes(name))
      throw invalid(
        `The first line must name the columns, and "${name}" is missing. Expected: ${[...required, ...optional].join(', ')}.`,
      );
  }
  if (rows.length - 1 > MAX_ROWS) throw invalid(`At most ${MAX_ROWS} rows at a time.`);
  return rows.slice(1).map((cells, index) => {
    const record = { __line: index + 2 } as Record_;
    header.forEach((name, column) => {
      if (name) record[name] = (cells[column] ?? '').trim();
    });
    return record;
  });
}

function flag(value: string | undefined, column: string, line: number): boolean {
  if (value === undefined || value === '') return true;
  const word = value.toLowerCase();
  if (YES.has(word)) return true;
  if (NO.has(word)) return false;
  throw invalid(`Line ${line}: ${column} must be true or false, not "${value}".`);
}

export interface GlossaryRow {
  term: string;
  language: string;
  enabled: boolean;
  note: string;
}

/** Columns: term (required), language (default hi), enabled (default true), note. */
export function parseGlossaryCsv(text: string): GlossaryRow[] {
  return table(text, ['term'], ['language', 'enabled', 'note']).map((row) => {
    if (!row.term) throw invalid(`Line ${row.__line}: the term is empty.`);
    return {
      term: row.term,
      language: (row.language || 'hi').toLowerCase(),
      enabled: flag(row.enabled, 'enabled', row.__line),
      note: row.note ?? '',
    };
  });
}

export interface SpellingRow {
  source: string;
  target: string;
  enabled: boolean;
}

/** Columns: source and target (required), enabled (default true). */
export function parseSpellingsCsv(text: string): SpellingRow[] {
  return table(text, ['source', 'target'], ['enabled']).map((row) => {
    if (!row.source || !row.target)
      throw invalid(`Line ${row.__line}: both the source and the target are required.`);
    return { source: row.source, target: row.target, enabled: flag(row.enabled, 'enabled', row.__line) };
  });
}
