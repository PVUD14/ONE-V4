/**
 * The one CSV writer for institution exports (INST-08).
 *
 * Formula injection is handled here, on output (INST-SR-13): a text cell that a spreadsheet
 * would run as a formula — first character `=`, `+`, `-`, `@`, tab or carriage return — is
 * prefixed with `'`. Every cell is quoted and embedded quotes doubled, so a comma, quote or
 * line break inside a name cannot move a value into another column. Numbers the server
 * produced are written as numbers. Stored values are never altered for this.
 *
 * The header is checked against ADR-024's forbidden fields before anything is written, so a
 * future column cannot carry offer compensation out in a file.
 */
import { institutionForbiddenDisclosureFields } from '@planthepath/authorization/src/index.js';

export type CsvValue = string | number | boolean | null | undefined;

const formulaStart = /^[=+\-@\t\r]/;
const byteOrderMark = '﻿';

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '""';
    return String(value);
  }
  const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
  const safe = formulaStart.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

/** True when a header names a field ADR-024 keeps from institutions, in any spelling. */
export function isForbiddenExportHeader(header: string): boolean {
  const normalised = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalised.startsWith('compensation') || (institutionForbiddenDisclosureFields as readonly string[]).includes(normalised);
}

/** A whole CSV document: byte-order mark, header row, data rows, CRLF line ends. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  if (header.some(isForbiddenExportHeader)) throw new Error('export header names a forbidden disclosure field');
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    if (row.length !== header.length) throw new Error('export row does not match its header');
    lines.push(row.map(csvCell).join(','));
  }
  return byteOrderMark + lines.join('\r\n') + '\r\n';
}
