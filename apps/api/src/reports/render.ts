import ExcelJS from 'exceljs';

/** Module 29 rendering. Pure, unit-tested. */
export type Cell = string | number | boolean | null | Date;
export interface Table {
  columns: string[];
  rows: Cell[][];
  /** A line printed above the data in every format, such as the synthetic-QA label. */
  notice?: string;
}

/** Text that a spreadsheet would run as a formula starts with one of these; such cells are prefixed with an apostrophe. */
const FORMULA = /^[=+\-@\t\r|%]/;
export const safeText = (s: string) => (FORMULA.test(s) ? `'${s}` : s);

/** A timestamp in the report's time zone, as YYYY-MM-DD HH:mm:ss. */
export function inZone(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const text = (v: Cell, tz: string): string =>
  v == null ? '' : v instanceof Date ? inZone(v, tz) : typeof v === 'string' ? safeText(v) : String(v);

export function toCsv(t: Table, tz: string): string {
  const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const lines = [] as string[];
  if (t.notice) lines.push(q(safeText(t.notice)));
  lines.push(t.columns.map((c) => q(safeText(c))).join(','));
  for (const r of t.rows) lines.push(r.map((v) => q(text(v, tz))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function toJson(t: Table, tz: string, meta: Record<string, unknown>): string {
  return JSON.stringify(
    {
      ...meta,
      timezone: tz,
      ...(t.notice ? { notice: t.notice } : {}),
      rows: t.rows.map((r) =>
        Object.fromEntries(t.columns.map((c, i) => [c, r[i] instanceof Date ? inZone(r[i] as Date, tz) : r[i]])),
      ),
    },
    null,
    2,
  );
}

export async function toXlsx(t: Table, tz: string, sheetName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Supply360';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  if (t.notice) {
    ws.addRow([safeText(t.notice)]).font = { bold: true, color: { argb: 'FFB45309' } };
  }
  const head = ws.addRow(t.columns.map(safeText));
  head.font = { bold: true };
  for (const r of t.rows)
    // Every value goes in as text or a number, never a formula; dates as zoned text so they read the same everywhere.
    ws.addRow(r.map((v) => (typeof v === 'number' ? v : text(v, tz))));
  ws.views = [{ state: 'frozen', ySplit: t.notice ? 2 : 1 }];
  t.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = Math.min(40, Math.max(10, c.length + 2));
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
