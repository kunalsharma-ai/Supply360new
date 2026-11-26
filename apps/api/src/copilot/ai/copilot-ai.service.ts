import { Inject, Injectable } from '@nestjs/common';
import type { CopilotAiUpdate, CopilotModelList } from '@s360/contracts';
import { copilotAi, copilotInteractions, withTenant, type Db } from '@s360/db';
import { and, count, gte, like } from 'drizzle-orm';
import { actorOf, AuditService } from '../../audit/audit.service.js';
import type { RequestContext } from '../../common/context.js';
import { assertHttpsAddress, EgressRefused } from '../../common/egress.js';
import { problem } from '../../common/problem.js';
import { ENV, type Env } from '../../config.js';
import { sealerFor, type Sealer } from '../../crypto/sealer.js';
import { DB } from '../../db/db.module.js';
import { complete, listModels, ModelUnavailable, type Connection } from './providers.js';
import { understandPrompt, type Complete } from './understand.js';

type Row = typeof copilotAi.$inferSelect;
const context = (tenantId: string) => `copilot-ai:${tenantId}`;
export const AI_VERSION_PREFIX = 'copilot-ai:';

function checkAddress(url: string | null) {
  if (!url) return;
  try {
    assertHttpsAddress(url);
  } catch (e) {
    if (e instanceof EgressRefused)
      throw problem.badRequest(`address_${e.reason}`, 'Use a public https:// address, not a local or private one');
    throw e;
  }
}

/** The tenant's AI for the Copilot: settings, a test call and the model list. */
@Injectable()
export class CopilotAiService {
  private readonly sealer: Sealer;
  /** Replaced in tests by a fake model. */
  complete: Complete = (c, p) => complete(c, p);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) env: Env,
    private readonly audit: AuditService,
  ) {
    this.sealer = sealerFor(env);
  }

  private conn(r: Row, key?: string): Connection {
    return {
      kind: r.kind as Connection['kind'],
      baseUrl: r.baseUrl,
      authStyle: r.authStyle as Connection['authStyle'],
      model: r.model,
      apiKey: key ?? (r.sealedKey ? this.sealer.open(r.sealedKey, context(r.tenantId)) : null),
      timeoutMs: r.timeoutMs,
      maxOutputTokens: 600,
    };
  }

  private view(r: Row | undefined, usedToday: number) {
    return r
      ? {
          configured: true,
          kind: r.kind,
          label: r.label,
          baseUrl: r.baseUrl,
          authStyle: r.authStyle,
          model: r.model,
          hasKey: !!r.sealedKey,
          enabled: r.enabled,
          timeoutMs: r.timeoutMs,
          dailyLimit: r.dailyLimit,
          usedToday,
          updatedAt: r.updatedAt.toISOString(),
        }
      : { configured: false, enabled: false, usedToday };
  }

  private usedToday(tx: Parameters<Parameters<typeof withTenant>[2]>[0]) {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    return tx
      .select({ n: count() })
      .from(copilotInteractions)
      .where(
        and(
          gte(copilotInteractions.createdAt, midnight),
          like(copilotInteractions.modelVersion, `${AI_VERSION_PREFIX}%`),
        ),
      )
      .then((r) => r[0]?.n ?? 0);
  }

  get(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [r] = await tx.select().from(copilotAi).limit(1);
      return this.view(r, await this.usedToday(tx));
    });
  }

  /** The connection to use for this question, or null to use the rules (off, no key, or today's limit reached). */
  async active(tenantId: string): Promise<Connection | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [r] = await tx.select().from(copilotAi).limit(1);
      if (!r?.enabled || !r.sealedKey) return null;
      if ((await this.usedToday(tx)) >= r.dailyLimit) return null;
      return this.conn(r);
    });
  }

  save(ctx: RequestContext, b: CopilotAiUpdate) {
    if (b.kind === 'openai_compatible' && !b.baseUrl)
      throw problem.badRequest('base_url_required', 'Add the base URL from the provider’s API docs');
    const baseUrl = b.baseUrl?.replace(/\/+$/, '') ?? null;
    checkAddress(baseUrl);
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [prev] = await tx.select().from(copilotAi).limit(1);
      const moved =
        !!prev && (prev.kind !== b.kind || (prev.baseUrl ?? null) !== baseUrl || prev.authStyle !== b.authStyle);
      if (moved && prev.sealedKey && !b.apiKey)
        throw problem.badRequest('key_reentry_required', 'The API type or address changed, so enter the key again');
      const sealedKey = b.apiKey ? this.sealer.seal(b.apiKey, context(ctx.tenantId)) : (prev?.sealedKey ?? null);
      if (b.enabled && !sealedKey) throw problem.badRequest('key_required', 'Add an API key before turning the AI on');
      const values = {
        kind: b.kind,
        label: b.label,
        baseUrl,
        authStyle: b.authStyle,
        model: b.model,
        sealedKey,
        enabled: b.enabled,
        timeoutMs: b.timeoutMs,
        dailyLimit: b.dailyLimit,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      };
      await tx
        .insert(copilotAi)
        .values({ tenantId: ctx.tenantId, ...values })
        .onConflictDoUpdate({ target: copilotAi.tenantId, set: values });
      await this.audit.write(tx, actorOf(ctx), {
        action: 'copilot.ai_configured',
        targetType: 'tenant',
        targetId: ctx.tenantId,
        details: {
          kind: b.kind,
          label: b.label,
          baseUrl,
          model: b.model,
          enabled: b.enabled,
          keyChanged: !!b.apiKey,
          dailyLimit: b.dailyLimit,
        },
      });
      const [r] = await tx.select().from(copilotAi).limit(1);
      return this.view(r, await this.usedToday(tx));
    });
  }

  /** One small routing question, so a person sees the AI understands before turning it on. */
  async test(ctx: RequestContext) {
    const r = await withTenant(this.db, ctx.tenantId, async (tx) => (await tx.select().from(copilotAi).limit(1))[0]);
    if (!r) throw problem.notFound('Save the Copilot AI first');
    const started = Date.now();
    try {
      const c = await this.complete(this.conn(r), understandPrompt('PRX10001 ka risk kya hai?', ['PRX10001']));
      return {
        ok: true,
        reason: null,
        detail: null,
        modelVersion: c.modelVersion,
        latencyMs: Date.now() - started,
        sample: c.text.slice(0, 300),
      };
    } catch (e) {
      if (e instanceof ModelUnavailable)
        return {
          ok: false,
          reason: e.reason,
          detail: e.detail ?? null,
          modelVersion: null,
          latencyMs: Date.now() - started,
          sample: null,
        };
      throw e;
    }
  }

  async models(ctx: RequestContext, b: CopilotModelList) {
    if (b.kind === 'openai_compatible' && !b.baseUrl)
      throw problem.badRequest('base_url_required', 'Add the base URL first');
    const baseUrl = b.baseUrl?.replace(/\/+$/, '') ?? null;
    checkAddress(baseUrl);
    let apiKey = b.apiKey ?? null;
    if (!apiKey) {
      const r = await withTenant(this.db, ctx.tenantId, async (tx) => (await tx.select().from(copilotAi).limit(1))[0]);
      // The stored key is only used for the same API and address it was saved with.
      if (r?.sealedKey && r.kind === b.kind && (r.baseUrl ?? null) === baseUrl && r.authStyle === b.authStyle)
        apiKey = this.conn(r).apiKey;
    }
    if (!apiKey) throw problem.badRequest('key_required', 'Enter the API key to load the model list');
    try {
      const models = await listModels({
        kind: b.kind,
        baseUrl,
        authStyle: b.authStyle,
        model: '',
        apiKey,
        timeoutMs: 15_000,
        maxOutputTokens: 16,
      });
      return { ok: true, models, reason: null, detail: null };
    } catch (e) {
      if (e instanceof ModelUnavailable) return { ok: false, models: [], reason: e.reason, detail: e.detail ?? null };
      throw e;
    }
  }
}
