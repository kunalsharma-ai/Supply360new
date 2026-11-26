import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { inZone, safeText, toCsv, toJson, toXlsx, validZone, type Table } from './render.js';

const t: Table = {
  columns: ['name', 'n', 'at'],
  rows: [
    ['=HYPERLINK("http://x")', 3, new Date('2026-11-26T12:00:00Z')],
    ['a,b "c"', null, null],
  ],
  notice: 'SYNTHETIC QA',
};

describe('render', () => {
  it('neutralises spreadsheet formulas', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '|cmd']) expect(safeText(s).startsWith("'")).toBe(true);
    expect(safeText('plain')).toBe('plain');
  });
  it('writes timestamps in the requested time zone', () => {
    expect(inZone(new Date('2026-11-26T12:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-26 17:30:00');
    expect(validZone('Europe/Berlin')).toBe(true);
    expect(validZone('Mars/Olympus')).toBe(false);
  });
  it('CSV quotes, prefixes formulas and keeps the notice', () => {
    const csv = toCsv(t, 'UTC');
    expect(csv.startsWith('﻿SYNTHETIC QA\r\nname,n,at\r\n')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")",3,2026-11-26 12:00:00`);
    expect(csv).toContain('"a,b ""c""",,');
  });
  it('JSON keeps types and zoned times', () => {
    const j = JSON.parse(toJson(t, 'UTC', { kind: 'x' }));
    expect(j.rows[0]).toEqual({ name: '=HYPERLINK("http://x")', n: 3, at: '2026-11-26 12:00:00' });
    expect(j.notice).toBe('SYNTHETIC QA');
  });
  it('XLSX has no formulas', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await toXlsx(t, 'UTC', 'Report')) as never);
    const ws = wb.worksheets[0]!;
    expect(ws.getCell('A1').value).toBe('SYNTHETIC QA');
    expect(ws.getCell('A3').value).toBe(`'=HYPERLINK("http://x")`);
    expect(ws.getCell('B3').value).toBe(3);
    ws.eachRow((r) => r.eachCell((c) => expect(c.formula).toBeUndefined()));
  });
});
