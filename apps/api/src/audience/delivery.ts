/**
 * Delivery channel for invitations and reminders. The spec has MADP deliver them (no second communication
 * platform), but MADP's Supply360 API has no send endpoint yet: invitations/authorize records an invitation and
 * says "MADP delivers once sending is approved". So:
 *
 * - FIXTURE: a labelled DEMO channel that accepts the hand-off and sends nothing anywhere.
 * - LIVE: answers `unavailable`, so batches and reminders stop safely as blocked, instead of pretending to send.
 *
 * When MADP adds its send endpoint, LIVE calls it here with the same idempotency key.
 */
export interface DeliveryRequest {
  idempotencyKey: string;
  kind: 'invitation' | 'reminder';
  madpInvitationId: string;
  /** Supply360's participation link: an opaque token, no personal data. */
  link: string;
}
export type DeliveryResult = { status: 'accepted' } | { status: 'unavailable'; detail: string };

export interface DeliveryChannel {
  readonly mode: 'fixture' | 'live';
  send(r: DeliveryRequest): Promise<DeliveryResult>;
}

const sent = new Map<string, Map<string, DeliveryRequest>>();
/** What the FIXTURE channel accepted for one MADP connection, by idempotency key. */
export const fixtureOutbox = (connectionId: string) => {
  let m = sent.get(connectionId);
  if (!m) sent.set(connectionId, (m = new Map()));
  return m;
};

export class FixtureDelivery implements DeliveryChannel {
  readonly mode = 'fixture' as const;
  constructor(private readonly connectionId: string) {}
  async send(r: DeliveryRequest): Promise<DeliveryResult> {
    fixtureOutbox(this.connectionId).set(r.idempotencyKey, r);
    return { status: 'accepted' };
  }
}

export class LiveMadpDelivery implements DeliveryChannel {
  readonly mode = 'live' as const;
  async send(): Promise<DeliveryResult> {
    return { status: 'unavailable', detail: 'MADP has no invitation send endpoint yet; nothing was sent' };
  }
}
