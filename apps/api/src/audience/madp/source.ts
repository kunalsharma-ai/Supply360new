import type { AudienceCriteria } from '@s360/contracts';
import type { MdAttributes, MdCounts, MdMatch, MdReservation } from './types.js';

/** MADP's Supply360 service API, in FIXTURE (labelled DEMO population) or LIVE (signed HTTP) mode. */
export interface AudienceSource {
  readonly mode: 'fixture' | 'live';
  attributes(): Promise<MdAttributes>;
  counts(criteria: AudienceCriteria): Promise<MdCounts>;
  match(q: AudienceCriteria & { projectRef: string; limit: number }): Promise<MdMatch>;
  reserve(q: { projectRef: string; refs: string[]; expiresAt: string }, idempotencyKey: string): Promise<MdReservation>;
  release(reservationId: string): Promise<void>;
}

export class AudienceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}
