import { describe, expect, it } from 'vitest';
import { cellKey, matchCells } from './match.js';

const cell = (
  id: string,
  countryCode: string,
  group: string,
  name: string,
  conditionsHash = id,
  isMarketCell = false,
) => ({
  id,
  countryCode,
  group,
  name,
  conditionsHash,
  isMarketCell,
});

describe('matching quota cells between projects', () => {
  it('matches by market, group and name, ignoring case and spacing', () => {
    expect(cellKey(cell('a', 'US', 'Gender ', ' Female'))).toBe(cellKey(cell('b', 'US', 'gender', 'female')));
    const m = matchCells(
      [cell('s1', 'US', 'Gender', 'Female'), cell('s2', 'US', 'Gender', 'Male')],
      [cell('t1', 'US', 'gender', 'MALE'), cell('t2', 'GB', 'Gender', 'Male')],
    );
    expect(m.get('t1')?.id).toBe('s2');
    expect(m.has('t2')).toBe(false);
  });

  it('matches whole-market cells by country, and falls back to identical conditions', () => {
    const m = matchCells(
      [cell('s1', 'DE', '', 'Whole market', 'h0', true), cell('s2', 'DE', 'Age', '18 to 34', 'h1')],
      [cell('t1', 'DE', '', 'All of DE', 'x', true), cell('t2', 'DE', 'Age group', 'Young adults', 'h1')],
    );
    expect(m.get('t1')?.id).toBe('s1');
    expect(m.get('t2')?.id).toBe('s2');
  });

  it('uses each source cell once', () => {
    const m = matchCells(
      [cell('s1', 'US', 'G', 'A', 'h')],
      [cell('t1', 'US', 'G', 'A', 'h'), cell('t2', 'US', 'X', 'Y', 'h')],
    );
    expect([...m.keys()]).toEqual(['t1']);
  });
});
