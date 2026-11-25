import { Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { problem } from './problem.js';

@Injectable()
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    throw problem.badRequest(
      'validation_failed',
      'Some fields are not valid',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
}
