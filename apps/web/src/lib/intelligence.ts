export interface Rate {
  value: number;
  low: number;
  high: number;
  numerator: number;
  denominator: number;
  basis: 'observed' | 'assumption' | 'source_brief';
}
export interface Range {
  value: number;
  low: number;
  high: number;
}
export type Risk = 'reached' | 'on_track' | 'at_risk' | 'off_track' | 'no_deadline' | 'not_enough_data';
export interface ProjectForecast {
  project: { id: string; projectCode: string; name: string; lifecycle: string; daysLeft: number | null };
  modelVersion: string;
  risk: Risk;
  riskLabel: string;
  rates: { start: Rate; qualification: Rate; qualifiedToComplete: Rate };
  completesPerInvite: Range;
  remaining: { provisional: number | null; approved: number | null };
  invitationsNeeded: Range | null;
  heldNotInvited: number;
  shortfall: number | null;
  pace: { perDay: number; neededPerDay: number | null };
  projectedCompletesByDeadline: { low: number; high: number } | null;
  assumptionsUsed: string[];
  sampleSizes: { sent: number; matured: number; screened: number; qualified: number };
  target: number | null;
  complete: number;
  underperformingCells: {
    id: string;
    name: string;
    countryCode: string;
    target: number;
    complete: number;
    progress: number;
    expected: number;
    incidence: number | null;
  }[];
  recommendation: { size: number; why: string };
  assumptionsConfigured: boolean;
  history: { risk: Risk; at: string; invitationsNeeded: number | null }[];
}
export interface PortfolioRow {
  id: string;
  projectCode: string;
  name: string;
  lifecycle: string;
  daysLeft: number | null;
  target: number | null;
  complete: number;
  risk: Risk;
  riskLabel: string;
  invitationsNeeded: Range | null;
  heldNotInvited: number;
  shortfall: number | null;
  pace: { perDay: number; neededPerDay: number | null };
  underperformingCells: number;
  usesAssumptions: boolean;
}
export interface Assumptions {
  startRatePercent: number;
  qualificationRatePercent: number;
  qualifiedToCompletePercent: number;
  configured: boolean;
  version: number;
}
export interface Perf {
  key: string;
  sent: number;
  started: number;
  complete: number;
  terminate: number;
  qualityFail: number;
  startRate: number | null;
  incidence: number | null;
  completesPerInvite: number | null;
  medianLoiMinutes: number | null;
  enoughData: boolean;
}
export const RISK_TONE: Record<Risk, 'success' | 'warning' | 'danger' | 'neutral' | 'accent'> = {
  reached: 'success',
  on_track: 'success',
  at_risk: 'warning',
  off_track: 'danger',
  no_deadline: 'neutral',
  not_enough_data: 'neutral',
};
export const p1 = (x: number) => `${Math.round(x * 1000) / 10}%`;
