import type { AudienceCriteria } from '@s360/contracts';
import type {
  MdAttributes,
  MdAuthorize,
  MdConsent,
  MdCounts,
  MdMatch,
  MdParticipation,
  MdReservation,
} from './types.js';

/** MADP's Supply360 service API, in FIXTURE (labelled DEMO population) or LIVE (signed HTTP) mode. */
export interface AudienceSource {
  readonly mode: 'fixture' | 'live';
  attributes(): Promise<MdAttributes>;
  counts(criteria: AudienceCriteria): Promise<MdCounts>;
  match(q: AudienceCriteria & { projectRef: string; limit: number }): Promise<MdMatch>;
  reserve(q: { projectRef: string; refs: string[]; expiresAt: string }, idempotencyKey: string): Promise<MdReservation>;
  release(reservationId: string): Promise<void>;
  /** Re-checks each reserved reference and records a MADP invitation for those who pass. Sends nothing. */
  authorize(q: { reservationId: string; refs: string[] }, idempotencyKey: string): Promise<MdAuthorize>;
  consent(refs: string[]): Promise<MdConsent>;
  participation(
    events: { eventId: string; invitationId: string; event: string; occurredAt: string }[],
  ): Promise<MdParticipation>;
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
