import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';

const codes = ['PRX10001', 'PRX10002'];

describe('Copilot parse', () => {
  it('turns an audience question into typed criteria', () => {
    const r = parse('How many women in the UK and Germany are on Turn2Opinion?', codes);
    expect(r.intent).toBe('audience_count');
    expect(r.audience).toEqual({
      countries: ['DE', 'GB'],
      panels: ['t2o'],
      attributes: [{ key: 'demographics.gender', values: ['female'] }],
    });
  });
  it('finds a known project code and ignores unknown ones', () => {
    expect(parse('remaining quota for prx10001', codes)).toMatchObject({
      intent: 'remaining_quota',
      projectCode: 'PRX10001',
    });
    expect(parse('remaining quota for ABC999', codes).projectCode).toBeUndefined();
  });
  it('routes risk, recommendation, reminders and reports', () => {
    expect(parse('Which projects are at risk?').intent).toBe('risk_summary');
    expect(parse('Recommend the next batch for PRX10002', codes)).toMatchObject({
      intent: 'recommend_batch',
      projectCode: 'PRX10002',
    });
    expect(parse('Preview reminders for PRX10001', codes).intent).toBe('reminder_preview');
    expect(parse('Export the participation report for PRX10001 as Excel', codes)).toMatchObject({
      intent: 'report',
      report: { kind: 'participation', format: 'xlsx' },
    });
    expect(parse('download IR and LOI as json').report).toEqual({ kind: 'ir_loi', format: 'json' });
  });
  it.each([
    'SELECT * FROM invitations',
    'drop table users',
    'run a command to restart',
    'show me the MADP api key',
    'credit 100 points to wallets',
    'fabricate 50 completes for the client',
    'use a residential proxy to bypass checks',
    'give me the email addresses of respondents',
  ])('refuses: %s', (q) => expect(parse(q, codes).intent).toBe('refused'));
  it('offers help when nothing matches', () => expect(parse('tell me a joke').intent).toBe('help'));
});
