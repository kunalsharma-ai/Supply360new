import { Inject, Injectable } from '@nestjs/common';
import { permissionsFor, type LoginRequest, type LoginResponse, type Role } from '@s360/contracts';
import { sessions, tenants, users, withTenant, type Db } from '@s360/db';
import * as argon2 from 'argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { ENV, type Env } from '../config.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { sealerFor, Sealer } from '../crypto/sealer.js';
import { DB } from '../db/db.module.js';
import { SessionTokens } from './session-token.js';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
/** Password-stage sessions only live long enough to enter a code. */
const MFA_STAGE_SECONDS = 10 * 60;
/** Used when the account does not exist, so timing does not reveal which e-mails are registered. */
const DUMMY_HASH = await argon2.hash('not-a-real-password-placeholder', { type: argon2.argon2id });

export interface Issued {
  token: string;
  maxAgeSeconds: number;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
  correlationId: string;
}

@Injectable()
export class AuthService {
  readonly tokens: SessionTokens;
  readonly sealer: Sealer;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {
    this.tokens = new SessionTokens(env.SESSION_SECRET);
    this.sealer = sealerFor(env);
  }

  static hashPassword(p: string) {
    return argon2.hash(p, { type: argon2.argon2id });
  }

  async login(req: LoginRequest, client: ClientInfo): Promise<{ response: LoginResponse; issued: Issued }> {
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.slug, req.tenant)).limit(1);
    if (!tenant || tenant.status !== 'active') {
      await argon2.verify(DUMMY_HASH, req.password);
      throw problem.unauthorized('invalid_credentials', 'Workspace, e-mail or password is wrong');
    }
    // Failures are committed (counter, lock, audit) and only then reported, so a throw cannot roll them back.
    const outcome = await withTenant(
      this.db,
      tenant.id,
      async (
        tx,
      ): Promise<
        { ok: true; response: LoginResponse; issued: Issued } | { ok: false; error: 'invalid' | 'locked' }
      > => {
        const [user] = await tx
          .select()
          .from(users)
          .where(and(eq(users.tenantId, tenant.id), eq(users.email, req.email)))
          .for('update')
          .limit(1);
        const actor = {
          tenantId: tenant.id,
          userId: user?.id ?? null,
          email: req.email,
          correlationId: client.correlationId,
        };
        if (!user) {
          await argon2.verify(DUMMY_HASH, req.password);
          await this.audit.write(tx, actor, {
            action: 'auth.sign_in_failed',
            targetType: 'user',
            details: { reason: 'unknown_user' },
          });
          return { ok: false, error: 'invalid' };
        }
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          await this.audit.write(tx, actor, {
            action: 'auth.sign_in_refused_locked',
            targetType: 'user',
            targetId: user.id,
          });
          return { ok: false, error: 'locked' };
        }
        const ok = await argon2.verify(user.passwordHash, req.password);
        if (!ok || user.status !== 'active') {
          const failures = user.failedSignIns + 1;
          const lock = failures >= MAX_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
          await tx
            .update(users)
            .set({ failedSignIns: lock ? 0 : failures, lockedUntil: lock })
            .where(eq(users.id, user.id));
          await this.audit.write(tx, actor, {
            action: lock ? 'auth.account_locked' : 'auth.sign_in_failed',
            targetType: 'user',
            targetId: user.id,
            details: { reason: ok ? 'disabled' : 'bad_password' },
          });
          return { ok: false, error: lock ? 'locked' : 'invalid' };
        }
        await tx.update(users).set({ failedSignIns: 0, lockedUntil: null }).where(eq(users.id, user.id));

        let response: LoginResponse;
        if (user.mfaEnabled && user.totpSecret) {
          response = { stage: 'mfa_challenge' };
        } else {
          const secret = newTotpSecret();
          await tx
            .update(users)
            .set({ totpSecret: this.sealer.seal(secret, `totp:${user.id}`) })
            .where(eq(users.id, user.id));
          response = { stage: 'mfa_setup', otpauthUri: otpauthUri(secret, `${tenant.slug}:${user.email}`) };
        }
        const [s] = await tx
          .insert(sessions)
          .values({
            tenantId: tenant.id,
            userId: user.id,
            stage: 'password',
            expiresAt: new Date(Date.now() + MFA_STAGE_SECONDS * 1000),
            ip: client.ip,
            userAgent: client.userAgent?.slice(0, 300) ?? null,
          })
          .returning({ id: sessions.id });
        await this.audit.write(tx, actor, { action: 'auth.password_accepted', targetType: 'user', targetId: user.id });
        const token = await this.tokens.sign({ sid: s!.id, tid: tenant.id }, MFA_STAGE_SECONDS);
        return { ok: true, response, issued: { token, maxAgeSeconds: MFA_STAGE_SECONDS } };
      },
    );
    if (outcome.ok) return { response: outcome.response, issued: outcome.issued };
    if (outcome.error === 'locked')
      throw problem.locked('Too many attempts. Try again in 15 minutes or ask an admin to unlock the account.');
    throw problem.unauthorized('invalid_credentials', 'Workspace, e-mail or password is wrong');
  }

  /** Completes MFA (first enrolment or a challenge) and swaps the password-stage session for a full one. */
  async completeMfa(ctx: RequestContext, code: string, client: ClientInfo): Promise<Issued> {
    const issued = await withTenant(this.db, ctx.tenantId, async (tx): Promise<Issued | null> => {
      const [user] = await tx.select().from(users).where(eq(users.id, ctx.userId)).for('update').limit(1);
      if (!user?.totpSecret) throw problem.badRequest('mfa_not_started', 'Sign in again to set up your authenticator');
      const secret = this.sealer.open(user.totpSecret, `totp:${user.id}`);
      const step = verifyTotp(secret, code);
      const actor = { tenantId: ctx.tenantId, userId: user.id, email: user.email, correlationId: client.correlationId };
      if (step === null || (user.totpLastStep !== null && step <= user.totpLastStep)) {
        await this.audit.write(tx, actor, { action: 'auth.mfa_failed', targetType: 'user', targetId: user.id });
        return null;
      }
      const enrolling = !user.mfaEnabled;
      await tx
        .update(users)
        .set({ mfaEnabled: true, totpLastStep: step, lastSignInAt: new Date() })
        .where(eq(users.id, user.id));
      await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, ctx.sessionId));
      const ttl = this.env.SESSION_TTL_HOURS * 3600;
      const [s] = await tx
        .insert(sessions)
        .values({
          tenantId: ctx.tenantId,
          userId: user.id,
          stage: 'full',
          expiresAt: new Date(Date.now() + ttl * 1000),
          ip: client.ip,
          userAgent: client.userAgent?.slice(0, 300) ?? null,
        })
        .returning({ id: sessions.id });
      await this.audit.write(tx, actor, {
        action: enrolling ? 'auth.mfa_enrolled' : 'auth.signed_in',
        targetType: 'user',
        targetId: user.id,
      });
      return { token: await this.tokens.sign({ sid: s!.id, tid: ctx.tenantId }, ttl), maxAgeSeconds: ttl };
    });
    if (!issued)
      throw problem.unauthorized('invalid_code', 'That code is not valid. Use the current code from your app.');
    return issued;
  }

  async logout(ctx: RequestContext): Promise<void> {
    await withTenant(this.db, ctx.tenantId, async (tx) => {
      await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, ctx.sessionId));
      await this.audit.write(
        tx,
        { tenantId: ctx.tenantId, userId: ctx.userId, email: ctx.email, correlationId: ctx.correlationId },
        {
          action: 'auth.signed_out',
          targetType: 'session',
          targetId: ctx.sessionId,
        },
      );
    });
  }

  /** Resolves a cookie to a context, or null when the session is unknown, revoked, expired or the user is disabled. */
  async resolve(token: string, correlationId: string): Promise<(RequestContext & { stage: string }) | null> {
    const claims = await this.tokens.verify(token);
    if (!claims) return null;
    return withTenant(this.db, claims.tid, async (tx) => {
      const [row] = await tx
        .select({ s: sessions, u: users, t: tenants })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .innerJoin(tenants, eq(tenants.id, sessions.tenantId))
        .where(and(eq(sessions.id, claims.sid), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`))
        .limit(1);
      if (!row || row.u.status !== 'active' || row.t.status !== 'active') return null;
      const roles = row.u.roles as Role[];
      return {
        tenantId: row.t.id,
        tenantSlug: row.t.slug,
        tenantName: row.t.name,
        userId: row.u.id,
        email: row.u.email,
        name: row.u.name,
        roles,
        permissions: permissionsFor(roles),
        sessionId: row.s.id,
        correlationId,
        stage: row.s.stage,
      };
    });
  }
}
