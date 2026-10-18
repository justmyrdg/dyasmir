/** Stops spreadsheet apps from evaluating cell text as a formula. */
export function safeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

type Cell = string | number | null | undefined;

/** CSV that Excel opens correctly: UTF-8 BOM, CRLF line ends, quotes where needed. Cells are written as given. */
export function toCsv(rows: Cell[][]): string {
  const esc = (v: Cell) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
