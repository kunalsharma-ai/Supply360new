import nodemailer from 'nodemailer';
import { assertPublicHttps, EgressRefused, isPublicAddress } from '../common/egress.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
  to: string[];
}

/** How alerts leave Supply360. Tests swap in a fake that records what would be sent. */
export interface AlertTransport {
  email(cfg: SmtpConfig, mail: Mail): Promise<void>;
  webhook(url: string, text: string): Promise<void>;
}

export class AlertSendError extends Error {}

const clean = (e: unknown, secrets: (string | null)[]) => {
  let s = e instanceof Error ? e.message : String(e);
  for (const x of secrets) if (x) s = s.split(x).join('[secret]');
  return s.replace(/\s+/g, ' ').slice(0, 300);
};

async function publicHost(host: string) {
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addrs.length) throw new AlertSendError(`The mail server ${host} could not be found`);
  if (addrs.some((a) => !isPublicAddress(a.address)))
    throw new AlertSendError('The mail server must be on the public internet, not a local or private address');
}

/** SMTP through nodemailer (TLS required) and chat webhooks through fetch, both to public hosts only. */
export const liveTransport: AlertTransport = {
  async email(cfg, mail) {
    await publicHost(cfg.host);
    const t = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: !cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? '' } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    try {
      await t.sendMail({ from: cfg.from, to: cfg.to, subject: mail.subject, text: mail.text, html: mail.html });
    } catch (e) {
      throw new AlertSendError(clean(e, [cfg.password, cfg.user]));
    } finally {
      t.close();
    }
  },
  async webhook(url, text) {
    try {
      await assertPublicHttps(url);
    } catch (e) {
      if (e instanceof EgressRefused)
        throw new AlertSendError(`Webhook address refused: ${e.reason.replaceAll('_', ' ')}`);
      throw e;
    }
    let res: Response;
    try {
      // Slack, Google Chat and Teams workflow webhooks all accept a JSON body with a text field.
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new AlertSendError(clean(e, [url]));
    }
    if (!res.ok) throw new AlertSendError(`The webhook answered ${res.status}`);
  },
};
