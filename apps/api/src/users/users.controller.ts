import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ROLE_LABELS, ROLE_PERMISSIONS, Role, UserCreate, UserRolesUpdate, UserStatusUpdate } from '@s360/contracts';
import { z } from 'zod';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { UsersService } from './users.service.js';

const Q = z.object({ after: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @RequirePermissions('users.read')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    return this.users.list(ctx, q.after, q.limit);
  }

  @Get('users/:id')
  @RequirePermissions('users.read')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(ctx, id);
  }

  @Post('users')
  @RequirePermissions('users.manage')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(UserCreate)) body: UserCreate) {
    return this.users.create(ctx, body);
  }

  @Patch('users/:id/roles')
  @RequirePermissions('users.manage')
  roles(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UserRolesUpdate)) b: z.infer<typeof UserRolesUpdate>,
  ) {
    return this.users.setRoles(ctx, id, b.roles);
  }

  @Patch('users/:id/status')
  @RequirePermissions('users.manage')
  status(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UserStatusUpdate)) b: z.infer<typeof UserStatusUpdate>,
  ) {
    return this.users.setStatus(ctx, id, b.status, b.reason);
  }

  /** The role matrix, so the UI shows exactly what the server enforces. */
  @Get('roles')
  @RequirePermissions('roles.read')
  roleMatrix() {
    return Role.options.map((r) => ({ role: r, label: ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r] }));
  }
}
