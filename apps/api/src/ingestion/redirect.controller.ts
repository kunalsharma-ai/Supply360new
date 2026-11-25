import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import { outcomeFromSlug, outcomeSlug } from '@s360/contracts';
import { projects, redirectHits, tenants, withTenant, type Db } from '@s360/db';
import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import { Public } from '../common/decorators.js';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^[A-Za-z0-9_-]{6,128}$/;

export const redirectPath = (tenantSlug: string, projectId: string, slug: string) =>
  `/api/v1/r/${tenantSlug}/${projectId}/${slug}?uid={respondent_uid}`;

/**
 * Where SampTrek sends respondents at the end of a survey (its vendor redirect URLs, one per outcome status).
 * Records the arrival as unverified (the signed S2S callback confirms it in Phase 5) and always lands on Supply360's
 * own thank-you page: the destination never comes from the query string, so this cannot be an open redirect, and
 * an unknown tenant or project gives the same response, so it reveals nothing.
 */
@Controller('r')
export class RedirectController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get(':tenant/:project/:outcome')
  @Public()
  async land(
    @Param('tenant') tenant: string,
    @Param('project') projectId: string,
    @Param('outcome') slug: string,
    @Query('uid') uid: string | undefined,
    @Res() res: Response,
  ) {
    const outcome = outcomeFromSlug(slug);
    const done = `${this.env.WEB_ORIGIN}/done/${outcome ? outcomeSlug(outcome) : 'finished'}`;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    if (outcome && UUID.test(projectId) && /^[a-z0-9-]{2,63}$/.test(tenant)) {
      const [t] = await this.db.select().from(tenants).where(eq(tenants.slug, tenant)).limit(1);
      if (t?.status === 'active') {
        await withTenant(this.db, t.id, async (tx) => {
          const [p] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
          if (p) {
            await tx.insert(redirectHits).values({
              tenantId: t.id,
              projectId: p.id,
              outcome,
              respondentRef: uid && REF.test(uid) ? uid : null,
            });
          }
        });
      }
    }
    res.redirect(302, done);
  }
}
