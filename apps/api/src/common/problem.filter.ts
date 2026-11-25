import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemException } from './problem.js';

const CODES: Record<number, string> = { 404: 'not_found', 429: 'rate_limited', 413: 'payload_too_large' };

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Problem');
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const correlationId = req.correlationId;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { title: 'Internal error', code: 'internal_error' };
    if (err instanceof ProblemException) {
      status = err.getStatus();
      const r = err.getResponse() as { title: string; detail?: string };
      body = { title: r.title, detail: r.detail, code: err.code, errors: err.errors };
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      body = { title: err.message, code: CODES[status] ?? 'http_error' };
    } else {
      this.log.error({ correlationId, err: err instanceof Error ? err.stack : String(err) });
    }
    res
      .status(status)
      .type('application/problem+json')
      .json({ type: 'about:blank', status, ...body, correlationId });
  }
}
