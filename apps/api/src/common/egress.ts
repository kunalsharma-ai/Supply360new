import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Model connections are typed in by tenants, so their addresses are untrusted. Before a key is sent anywhere the
 * address must be https, carry no credentials, and resolve only to public addresses. This keeps a connection from
 * being pointed at the database, the metadata service or anything else inside the network.
 */

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

export class EgressRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function isPublicAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (!fam) return false;
  if (fam === 6) {
    // An IPv4-mapped address is judged as the IPv4 address it carries.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}

type Resolver = (host: string) => Promise<{ address: string }[]>;
const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/** The checks that need no network: https, no credentials, and not a private name or address. */
export function assertHttpsAddress(raw: string): { url: URL; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressRefused('address_invalid');
  }
  if (url.protocol !== 'https:') throw new EgressRefused('https_required');
  if (url.username || url.password) throw new EgressRefused('credentials_in_address');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    /\.(localhost|local|internal|lan|home\.arpa)$/.test(host) ||
    (!host.includes('.') && !isIP(host))
  )
    throw new EgressRefused('host_not_public');
  if (isIP(host) && !isPublicAddress(host)) throw new EgressRefused('host_not_public');
  return { url, host };
}

/** Throws EgressRefused unless the URL is https to a host that resolves only to public addresses. */
export async function assertPublicHttps(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  const { url, host } = assertHttpsAddress(raw);
  if (isIP(host)) return url;
  const addrs = await resolve(host).catch(() => {
    throw new EgressRefused('host_not_found');
  });
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) throw new EgressRefused('host_not_public');
  return url;
}
