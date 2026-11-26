import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AlertCategory, AlertSettingsUpdate, AlertSeverity } from '@s360/contracts';
import {
  alertDeliveries,
  alertMarks,
  alertSettings,
  deliveryPredictions,
  invitations,
  notifications,
  projectMarkets,
  projects,
  quotaCells,
  withTenant,
  type Db,
  type Tx,
} from '@s360/db';
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { actorOf, AuditService } from '../audit/audit.service.js';
import { assertHttpsAddress, EgressRefused } from '../common/egress.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { ENV, type Env } from '../config.js';
import { sealerFor, type Sealer } from '../crypto/sealer.js';
import { DB } from '../db/db.module.js';
import { localParts } from '../execution/policy.js';
import { incidence } from '../fieldwork/outcomes.js';
import { liveTransport, type AlertTransport, type Mail } from './transport.js';

type Settings = typeof alertSettings.$inferSelect;
type Note = typeof notifications.$inferSelect;

const SEVERITY_ORDER: Record<string, number> = { info: 0, warning: 1, danger: 2, critical: 3 };
const smtpContext = (tenantId: string) => `alerts-smtp:${tenantId}`;
const webhookContext = (tenantId: string) => `alerts-webhook:${tenantId}`;
/** IR needs this many completes plus terminates in the last 24 hours before a drop is believed. */
export const IR_MIN_SAMPLE = 30;

export function categoryOf(kind: string): AlertCategory {
  if (['low_delivery', 'quota_risk', 'target_achieved'].includes(kind)) return 'delivery';
  if (kind.startsWith('execution.')) return 'automation';
  if (kind === 'quota.cell_full') return 'quota_full';
  if (kind === 'ir.drop') return 'ir_drop';
  return 'other';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Alerts (spec: keep people informed without watching screens). Supply360 already writes in-app notifications when
 * delivery risk changes, automation escalates or the emergency stop is used. This service adds two more conditions
 * (a quota cell filling, IR far below what SampTrek expects) and sends the chosen notifications by email and to a
 * chat webhook, plus a morning digest. It only reads project data and never sends invitations.
 */
@Injectable()
export class AlertsService {
  private readonly log = new Logger('Alerts');
  private readonly sealer: Sealer;
  /** Replaced in tests by a fake that records what would be sent. */
  transport: AlertTransport = liveTransport;
  /** The public address of the web app, for links in emails. */
  private readonly baseUrl: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) env: Env,
    private readonly audit: AuditService,
  ) {
    this.sealer = sealerFor(env);
    this.baseUrl = env.WEB_ORIGIN.replace(/\/+$/, '');
  }

  // ───────────────────────────── settings ─────────────────────────────

  private async settingsOf(tx: Tx) {
    const [s] = await tx.select().from(alertSettings).limit(1);
    return s ?? null;
  }

  view(s: Settings | null) {
    return {
      emailEnabled: s?.emailEnabled ?? false,
      smtpHost: s?.smtpHost ?? '',
      smtpPort: s?.smtpPort ?? 587,
      smtpSecure: s?.smtpSecure ?? false,
      smtpUser: s?.smtpUser ?? '',
      hasSmtpPassword: !!s?.smtpPasswordSealed,
      fromAddress: s?.fromAddress ?? '',
      recipients: (s?.recipients as string[] | undefined) ?? [],
      webhookEnabled: s?.webhookEnabled ?? false,
      hasWebhook: !!s?.webhookUrlSealed,
      categories: (s?.categories as AlertCategory[] | undefined) ?? ['delivery', 'automation', 'quota_full', 'ir_drop'],
      minSeverity: (s?.minSeverity as AlertSeverity | undefined) ?? 'warning',
      irDropPoints: s?.irDropPoints ?? 15,
      digestEnabled: s?.digestEnabled ?? false,
      digestHour: s?.digestHour ?? 9,
      digestTimezone: s?.digestTimezone ?? 'Asia/Kolkata',
      lastDigestOn: s?.lastDigestOn ?? null,
      updatedAt: s?.updatedAt.toISOString() ?? null,
    };
  }

  get(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const s = await this.settingsOf(tx);
      const recent = await tx.select().from(alertDeliveries).orderBy(desc(alertDeliveries.at)).limit(30);
      return {
        settings: this.view(s),
        recent: recent.map((d) => ({
          id: d.id,
          channel: d.channel,
          kind: d.kind,
          status: d.status,
          attempts: d.attempts,
          error: d.error,
          subject: d.subject,
          at: d.at.toISOString(),
        })),
      };
    });
  }

  save(ctx: RequestContext, b: AlertSettingsUpdate) {
    if (b.smtpHost) {
      try {
        assertHttpsAddress(`https://${b.smtpHost}`);
      } catch (e) {
        if (e instanceof EgressRefused)
          throw problem.badRequest(
            'smtp_host_not_public',
            'Use a mail server on the public internet, such as smtp.zoho.in',
          );
        throw e;
      }
    }
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const prev = await this.settingsOf(tx);
      const smtpPasswordSealed = b.smtpPassword
        ? this.sealer.seal(b.smtpPassword, smtpContext(ctx.tenantId))
        : // A stored password only goes to the server it was entered for.
          prev?.smtpHost && b.smtpHost && prev.smtpHost !== b.smtpHost
          ? null
          : (prev?.smtpPasswordSealed ?? null);
      const webhookUrlSealed = b.webhookUrl
        ? this.sealer.seal(b.webhookUrl, webhookContext(ctx.tenantId))
        : (prev?.webhookUrlSealed ?? null);
      if (b.emailEnabled && (!b.smtpHost || !b.fromAddress || !b.recipients.length))
        throw problem.badRequest(
          'email_incomplete',
          'Email alerts need a mail server, a from address and at least one recipient',
        );
      if (b.webhookEnabled && !webhookUrlSealed)
        throw problem.badRequest('webhook_incomplete', 'Paste the webhook address first');
      if (b.digestEnabled && !b.emailEnabled && !b.webhookEnabled)
        throw problem.badRequest('digest_needs_channel', 'Turn on email or the chat webhook for the daily digest');
      const turningOn = (b.emailEnabled && !prev?.emailEnabled) || (b.webhookEnabled && !prev?.webhookEnabled);
      const values = {
        emailEnabled: b.emailEnabled,
        smtpHost: b.smtpHost || null,
        smtpPort: b.smtpPort,
        smtpSecure: b.smtpSecure,
        smtpUser: b.smtpUser || null,
        smtpPasswordSealed,
        fromAddress: b.fromAddress ?? null,
        recipients: b.recipients,
        webhookEnabled: b.webhookEnabled,
        webhookUrlSealed,
        categories: b.categories,
        minSeverity: b.minSeverity,
        irDropPoints: b.irDropPoints,
        digestEnabled: b.digestEnabled,
        digestHour: b.digestHour,
        digestTimezone: b.digestTimezone,
        ...(turningOn ? { sendSince: new Date() } : {}),
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      };
      await tx
        .insert(alertSettings)
        .values({ tenantId: ctx.tenantId, ...values })
        .onConflictDoUpdate({ target: alertSettings.tenantId, set: values });
      await this.audit.write(tx, actorOf(ctx), {
        action: 'alerts.configured',
        targetType: 'tenant',
        targetId: ctx.tenantId,
        details: {
          emailEnabled: b.emailEnabled,
          smtpHost: b.smtpHost ?? null,
          recipients: b.recipients.length,
          webhookEnabled: b.webhookEnabled,
          webhookChanged: !!b.webhookUrl,
          passwordChanged: !!b.smtpPassword,
          categories: b.categories,
          minSeverity: b.minSeverity,
          digest: b.digestEnabled ? `${b.digestHour}:00 ${b.digestTimezone}` : null,
        },
      });
      return this.view(await this.settingsOf(tx));
    });
  }

  // ───────────────────────────── conditions ─────────────────────────────

  private async mark(tx: Tx, tenantId: string, key: string) {
    const r = await tx
      .insert(alertMarks)
      .values({ tenantId, key })
      .onConflictDoNothing()
      .returning({ key: alertMarks.key });
    return r.length > 0;
  }

  /** Raises "cell full" and "IR drop" notifications, each once. Runs whether or not anything is sent out. */
  async evaluate(tx: Tx, tenantId: string, s: Settings | null, now: Date) {
    const live = await tx
      .select()
      .from(projects)
      .where(inArray(projects.lifecycle, ['live', 'paused']));
    if (!live.length) return 0;
    let raised = 0;
    const ids = live.map((p) => p.id);
    const code = new Map(live.map((p) => [p.id, p.projectCode]));

    const cells = await tx
      .select()
      .from(quotaCells)
      .where(and(inArray(quotaCells.projectId, ids), eq(quotaCells.removed, false)));
    for (const c of cells) {
      const full = !c.isOpen || (c.sourceTarget > 0 && c.sourceCompletes >= c.sourceTarget);
      if (!full || !(await this.mark(tx, tenantId, `quota_full:${c.id}`))) continue;
      await tx.insert(notifications).values({
        tenantId,
        userId: null,
        kind: 'quota.cell_full',
        severity: 'warning',
        title: `${code.get(c.projectId)}: ${c.countryCode} ${c.name} is ${c.isOpen ? 'full' : 'closed'}`,
        body: `${c.sourceCompletes} of ${c.sourceTarget} completes at SampTrek. Stop inviting for this cell and move effort to open cells.`,
        link: `/quotas?project=${c.projectId}`,
      });
      raised++;
    }

    const since = new Date(now.getTime() - 86_400_000);
    const outcomes = await tx
      .select({
        projectId: invitations.projectId,
        complete: sql<number>`count(*) filter (where ${invitations.outcome} = 'complete')::int`,
        terminate: sql<number>`count(*) filter (where ${invitations.outcome} = 'terminate')::int`,
      })
      .from(invitations)
      .where(
        and(inArray(invitations.projectId, ids), isNotNull(invitations.outcomeAt), gte(invitations.outcomeAt, since)),
      )
      .groupBy(invitations.projectId);
    const points = s?.irDropPoints ?? 15;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: s?.digestTimezone ?? 'UTC' }).format(now);
    for (const o of outcomes) {
      if (o.complete + o.terminate < IR_MIN_SAMPLE) continue;
      const ms = await tx
        .select({ ir: projectMarkets.irPercent, target: projectMarkets.targetCompletes })
        .from(projectMarkets)
        .where(and(eq(projectMarkets.projectId, o.projectId), isNotNull(projectMarkets.irPercent)));
      const weight = ms.reduce((n, m) => n + Math.max(m.target, 1), 0);
      if (!weight) continue;
      const expected = ms.reduce((n, m) => n + (m.ir ?? 0) * Math.max(m.target, 1), 0) / weight;
      const seen = incidence(o.complete, o.terminate) ?? 0;
      if (expected - seen < points || !(await this.mark(tx, tenantId, `ir_drop:${o.projectId}:${day}`))) continue;
      await tx.insert(notifications).values({
        tenantId,
        userId: null,
        kind: 'ir.drop',
        severity: 'danger',
        title: `${code.get(o.projectId)}: IR ${seen}% against ${Math.round(expected)}% expected`,
        body: `${o.complete} completes and ${o.terminate} terminates in the last 24 hours. Check targeting and the screener with the client before sending more.`,
        link: `/ir?project=${o.projectId}`,
      });
      raised++;
    }
    return raised;
  }

  // ───────────────────────────── sending ─────────────────────────────

  private channels(s: Settings) {
    const out: ('email' | 'webhook')[] = [];
    if (s.emailEnabled && s.smtpHost && s.fromAddress && (s.recipients as string[]).length) out.push('email');
    if (s.webhookEnabled && s.webhookUrlSealed) out.push('webhook');
    return out;
  }

  private async send(tenantId: string, s: Settings, channel: 'email' | 'webhook', mail: Mail) {
    if (channel === 'email')
      return this.transport.email(
        {
          host: s.smtpHost!,
          port: s.smtpPort,
          secure: s.smtpSecure,
          user: s.smtpUser,
          password: s.smtpPasswordSealed ? this.sealer.open(s.smtpPasswordSealed, smtpContext(tenantId)) : null,
          from: s.fromAddress!,
          to: s.recipients as string[],
        },
        mail,
      );
    return this.transport.webhook(
      this.sealer.open(s.webhookUrlSealed!, webhookContext(tenantId)),
      `*${mail.subject}*\n${mail.text}`,
    );
  }

  private alertMail(n: Note): Mail {
    const link = n.link ? `${this.baseUrl}${n.link}` : this.baseUrl;
    return {
      subject: `[Supply360] ${n.title}`,
      text: `${n.body}\n\nOpen: ${link}`,
      html: `<p style="font:15px/1.5 system-ui,sans-serif"><strong>${esc(n.title)}</strong><br>${esc(n.body)}</p><p><a href="${esc(link)}">Open in Supply360</a></p>`,
    };
  }

  /** Sends what is due: new notifications in the chosen groups, then the digest once a day. Never throws. */
  async deliver(tenantId: string, now: Date) {
    const plan = await withTenant(this.db, tenantId, async (tx) => {
      const s = await this.settingsOf(tx);
      if (!s) return null;
      const ch = this.channels(s);
      if (!ch.length) return null;
      const cats = new Set(s.categories as string[]);
      const min = SEVERITY_ORDER[s.minSeverity] ?? 1;
      const notes = await tx
        .select()
        .from(notifications)
        .where(and(isNull(notifications.userId), gte(notifications.createdAt, s.sendSince)))
        .orderBy(notifications.createdAt)
        .limit(200);
      const due = notes.filter((n) => cats.has(categoryOf(n.kind)) && (SEVERITY_ORDER[n.severity] ?? 0) >= min);
      const done = due.length
        ? await tx
            .select()
            .from(alertDeliveries)
            .where(
              inArray(
                alertDeliveries.notificationId,
                due.map((n) => n.id),
              ),
            )
        : [];
      const work: { n: Note; channel: 'email' | 'webhook'; prev: (typeof done)[number] | undefined }[] = [];
      for (const n of due)
        for (const c of ch) {
          const prev = done.find((d) => d.notificationId === n.id && d.channel === c);
          // Failed sends are retried up to three times, five minutes apart.
          if (!prev || (prev.status === 'failed' && prev.attempts < 3 && now.getTime() - prev.at.getTime() > 300_000))
            work.push({ n, channel: c, prev });
        }
      return { s, work: work.slice(0, 25) };
    });
    if (!plan) return { sent: 0, failed: 0 };
    let sent = 0;
    let failed = 0;
    for (const w of plan.work) {
      const mail = this.alertMail(w.n);
      let error: string | null = null;
      try {
        await this.send(tenantId, plan.s, w.channel, mail);
        sent++;
      } catch (e) {
        error = (e as Error).message.slice(0, 300);
        failed++;
      }
      await withTenant(this.db, tenantId, async (tx) => {
        const values = { status: error ? 'failed' : 'sent', error, at: new Date() };
        if (w.prev)
          await tx
            .update(alertDeliveries)
            .set({ ...values, attempts: w.prev.attempts + 1 })
            .where(eq(alertDeliveries.id, w.prev.id));
        else
          await tx.insert(alertDeliveries).values({
            tenantId,
            notificationId: w.n.id,
            channel: w.channel,
            kind: 'alert',
            subject: mail.subject,
            ...values,
          });
      });
    }
    await this.maybeDigest(tenantId, plan.s, now);
    return { sent, failed };
  }

  /** One message summarising every live project, at the chosen local hour. */
  async digest(tenantId: string, now: Date): Promise<Mail> {
    return withTenant(this.db, tenantId, async (tx) => {
      const ps = await tx
        .select()
        .from(projects)
        .where(inArray(projects.lifecycle, ['live', 'paused', 'source_hold']))
        .orderBy(projects.projectCode);
      const since = new Date(now.getTime() - 86_400_000);
      const rows: string[] = [];
      const html: string[] = [];
      for (const p of ps) {
        const ms = await tx.select().from(projectMarkets).where(eq(projectMarkets.projectId, p.id));
        const target = ms.reduce((n, m) => n + (m.vendorTarget ?? 0), 0);
        const done = ms.reduce((n, m) => n + (m.vendorCompletes ?? 0), 0);
        const [o] = await tx
          .select({
            sent: sql<number>`count(*) filter (where ${invitations.sentAt} >= ${since})::int`,
            complete: sql<number>`count(*) filter (where ${invitations.outcome} = 'complete' and ${invitations.outcomeAt} >= ${since})::int`,
            terminate: sql<number>`count(*) filter (where ${invitations.outcome} = 'terminate' and ${invitations.outcomeAt} >= ${since})::int`,
          })
          .from(invitations)
          .where(eq(invitations.projectId, p.id));
        const [risk] = await tx
          .select({ risk: deliveryPredictions.risk })
          .from(deliveryPredictions)
          .where(eq(deliveryPredictions.projectId, p.id))
          .orderBy(desc(deliveryPredictions.createdAt))
          .limit(1);
        const ir = incidence(o?.complete ?? 0, o?.terminate ?? 0);
        const line = `${p.projectCode} · ${p.name}: ${done}/${target} completes, ${o?.sent ?? 0} invited and ${o?.complete ?? 0} completes in 24 h, IR ${ir ?? '—'}%, ${risk ? risk.risk.replaceAll('_', ' ') : 'no forecast yet'}, ${p.lifecycle}`;
        rows.push(`• ${line}`);
        html.push(`<li>${esc(line)}</li>`);
      }
      const open = await tx
        .select({ title: notifications.title })
        .from(notifications)
        .where(
          and(
            isNull(notifications.userId),
            gte(notifications.createdAt, since),
            inArray(notifications.severity, ['warning', 'danger', 'critical']),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(10);
      const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(now);
      const text =
        (rows.length ? `Live projects:\n${rows.join('\n')}` : 'No live projects today.') +
        (open.length
          ? `\n\nNeeds attention (last 24 h):\n${open.map((n) => `• ${n.title}`).join('\n')}`
          : '\n\nNothing needs attention.') +
        `\n\nOpen Supply360: ${this.baseUrl}`;
      return {
        subject: `[Supply360] Daily digest, ${day}: ${ps.length} live project${ps.length === 1 ? '' : 's'}, ${open.length} alert${open.length === 1 ? '' : 's'}`,
        text,
        html:
          `<div style="font:15px/1.5 system-ui,sans-serif"><h2 style="margin:0 0 8px">Supply360 daily digest</h2>` +
          (html.length ? `<ul>${html.join('')}</ul>` : '<p>No live projects today.</p>') +
          (open.length
            ? `<h3>Needs attention</h3><ul>${open.map((n) => `<li>${esc(n.title)}</li>`).join('')}</ul>`
            : '<p>Nothing needs attention.</p>') +
          `<p><a href="${esc(this.baseUrl)}">Open Supply360</a></p></div>`,
      };
    });
  }

  private async maybeDigest(tenantId: string, s: Settings, now: Date) {
    if (!s.digestEnabled) return;
    const { hour } = localParts(s.digestTimezone, now);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: s.digestTimezone }).format(now);
    if (hour < s.digestHour || s.lastDigestOn === today) return;
    // Claim the day first, so two runners never send two digests.
    const claimed = await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx
        .update(alertSettings)
        .set({ lastDigestOn: today })
        .where(and(eq(alertSettings.tenantId, tenantId), sql`${alertSettings.lastDigestOn} is distinct from ${today}`))
        .returning({ t: alertSettings.tenantId });
      return r.length > 0;
    });
    if (!claimed) return;
    const mail = await this.digest(tenantId, now);
    for (const c of this.channels(s)) await this.record(tenantId, s, c, 'digest', mail);
  }

  private async record(tenantId: string, s: Settings, channel: 'email' | 'webhook', kind: string, mail: Mail) {
    let error: string | null = null;
    try {
      await this.send(tenantId, s, channel, mail);
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .insert(alertDeliveries)
        .values({ tenantId, channel, kind, status: error ? 'failed' : 'sent', error, subject: mail.subject }),
    );
    return error;
  }

  /** Sends a test message (or today's digest) now through one channel, so a person sees the setup works. */
  async test(ctx: RequestContext, what: 'email' | 'webhook' | 'digest') {
    const s = await withTenant(this.db, ctx.tenantId, (tx) => this.settingsOf(tx));
    if (!s) throw problem.badRequest('not_configured', 'Save the alert settings first');
    const ch = what === 'digest' ? this.channels(s) : this.channels(s).filter((c) => c === what);
    if (!ch.length)
      throw problem.badRequest(
        'channel_off',
        what === 'digest'
          ? 'Turn on email or the chat webhook first'
          : `Turn on and save ${what === 'email' ? 'email' : 'the chat webhook'} first`,
      );
    const mail =
      what === 'digest'
        ? await this.digest(ctx.tenantId, new Date())
        : {
            subject: '[Supply360] Test alert',
            text: `${ctx.name} sent this test from Supply360 Alerts. Real alerts look like this, with a link to the project.`,
            html: `<p style="font:15px/1.5 system-ui,sans-serif">${esc(ctx.name)} sent this test from Supply360 Alerts. Real alerts look like this, with a link to the project.</p>`,
          };
    const results = [];
    for (const c of ch)
      results.push({
        channel: c,
        error: await this.record(ctx.tenantId, s, c, what === 'digest' ? 'digest' : 'test', mail),
      });
    return { ok: results.every((r) => !r.error), results };
  }

  /** Scheduler step. */
  async tick(tenantId: string, now = new Date()) {
    const raised = await withTenant(this.db, tenantId, async (tx) =>
      this.evaluate(tx, tenantId, await this.settingsOf(tx), now),
    );
    try {
      const r = await this.deliver(tenantId, now);
      return { raised, ...r };
    } catch (e) {
      this.log.error(`deliver: ${(e as Error).message}`);
      return { raised, sent: 0, failed: 0 };
    }
  }
}
