import type { SourceSession, StListItem, StProject, StQuotas } from './samptrek/types.js';

/**
 * A project source. SampTrek implements it in FIXTURE and LIVE mode; SampCloud will implement the same interface
 * once its repository and API are found (Phase 0 audit: not found).
 */
export interface ProjectSource {
  readonly mode: 'fixture' | 'live';
  /** Newest first, paged; `updatedSince` limits to projects changed since the last poll. */
  listProjects(q: { updatedSince?: Date; cursor?: string | null }): Promise<{
    data: StListItem[];
    nextCursor: string | null;
  }>;
  getProject(ref: string): Promise<StProject | null>;
  /** Quota cells per market; null when the project is not visible. */
  getQuotas(ref: string): Promise<StQuotas | null>;
  /**
   * Respondent sessions of Supply360's own vendor link only (other vendors' sessions are dropped on arrival), with
   * final client approval. Null when the project is not visible.
   */
  getSessions(ref: string, vendorCode: string, since?: Date): Promise<SourceSession[] | null>;
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}
