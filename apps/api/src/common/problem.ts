import { HttpException, HttpStatus } from '@nestjs/common';

/** Throws an RFC 9457 problem with a stable machine code. */
export class ProblemException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    title: string,
    detail?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super({ title, detail }, status);
  }
}

export const problem = {
  badRequest: (code: string, detail: string, errors?: { path: string; message: string }[]) =>
    new ProblemException(HttpStatus.BAD_REQUEST, code, 'Bad request', detail, errors),
  unauthorized: (code = 'unauthenticated', detail = 'Sign in first') =>
    new ProblemException(HttpStatus.UNAUTHORIZED, code, 'Unauthorized', detail),
  forbidden: (code = 'forbidden', detail = 'You do not have permission for this') =>
    new ProblemException(HttpStatus.FORBIDDEN, code, 'Forbidden', detail),
  notFound: (detail = 'Not found') => new ProblemException(HttpStatus.NOT_FOUND, 'not_found', 'Not found', detail),
  conflict: (code: string, detail: string) => new ProblemException(HttpStatus.CONFLICT, code, 'Conflict', detail),
  gone: (detail: string) => new ProblemException(HttpStatus.GONE, 'expired', 'Gone', detail),
  locked: (detail: string) => new ProblemException(HttpStatus.LOCKED, 'account_locked', 'Locked', detail),
  badGateway: (code: string, detail: string) =>
    new ProblemException(HttpStatus.BAD_GATEWAY, code, 'Upstream service failed', detail),
};
