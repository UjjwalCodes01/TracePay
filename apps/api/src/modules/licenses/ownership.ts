import { randomBytes } from 'node:crypto';
import type { Db, Tx } from '../../db';
import { appendAudit } from '../audit/audit-log';
import { checkWebhookUrl, safeGet } from '../platform/safe-http';
import type { ExtractionResult } from './extract';
import { readRsl, RslError } from './rsl';

/**
 * Two things a contributor can do with their own website:
 *
 *  - Import its terms: a site that publishes an RSL license says where in its robots.txt
 *    (`License: https://…/license.xml`). TracePay finds it the way an AI crawler would
 *    and reads it exactly (see rsl.ts).
 *  - Prove they control it: TracePay issues a token, the contributor publishes it at
 *    /.well-known/tracepay-verification.txt, and TracePay looks for it — the way search engines
 *    verify site owners. Publishers and receipts then show "owner verified: example.com".
 *
 * Every fetch is a public HTTPS GET with the webhook sender's SSRF protections: no private
 * addresses (checked at connection time), small size caps, short deadlines, few redirects.
 */

export class SiteError extends Error {}

/** Fetches a public page's text. Injected in tests. */
export type FetchText = (url: string) => Promise<{ status: number | null; body: string; url: string; error: string | null }>;

const PUBLIC_ONLY = { allowHttp: false, allowPrivate: false } as const;

export const fetchPublicText: FetchText = async (url) => {
  const r = await safeGet(url, { ...PUBLIC_ONLY, timeoutMs: 8_000, maxResponseBytes: 256 * 1024, maxRedirects: 3 });
  return { status: r.statusCode, body: r.body, url: r.url, error: r.error };
};

/** "example.com", "https://example.com/blog" → https://example.com (public HTTPS sites only). */
export function siteOrigin(input: string): { origin: string; host: string } {
  const raw = input.trim();
  if (!raw) throw new SiteError('Enter your website, for example example.com.');
  // A site is always checked over HTTPS, whatever was typed.
  const withScheme = /^https?:\/\//i.test(raw) ? raw.replace(/^http:/i, 'https:') : /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const checked = checkWebhookUrl(withScheme, PUBLIC_ONLY);
  if (!checked.ok) throw new SiteError(checked.reason.replace('The URL', 'The website'));
  if (checked.url.port) throw new SiteError('Use the website’s normal address, without a port.');
  const host = checked.url.hostname.toLowerCase().replace(/\.$/, '');
  return { origin: `https://${host}`, host };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** An HTML page rather than a text or XML file. */
const looksLikeHtml = (body: string) => /^\s*(<!doctype html|<html[\s>])/i.test(body);

/** Same site: the host itself, or it with/without "www." (sites redirect between the two). */
const sameSite = (a: string, b: string) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

// ---------------------------------------------------------------- RSL discovery

export interface Discovery {
  site: string;
  /** Where the license was found: robots.txt's License line, or the conventional /license.xml. */
  foundVia: 'robots.txt' | 'license.xml';
  licenseUrl: string;
  /** False when the site points at a license hosted elsewhere (a collective's, for example). */
  hostedOnSite: boolean;
}

/** The License: URLs in a robots.txt (any group), in order, absolute HTTP(S) only. */
export function licenseLines(robots: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const m = /^\s*license\s*:\s*(\S+)/i.exec(line.replace(/#.*$/, ''));
    if (!m) continue;
    try {
      const url = new URL(m[1]!);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !out.includes(url.toString())) out.push(url.toString());
    } catch {
      // Not a URL (some sites add other License: values): skip it.
    }
  }
  return out;
}

export async function discoverRsl(input: string, today: string, fetchText: FetchText = fetchPublicText): Promise<ExtractionResult & { discovery: Discovery }> {
  const { origin, host } = siteOrigin(input);
  const robots = await fetchText(`${origin}/robots.txt`);
  // A site that moved redirects everything, robots.txt included, to its new home: that page isn't
  // this site's robots.txt, and the license isn't here either.
  const movedTo = hostOf(robots.url);
  if (robots.status === 200 && movedTo && !sameSite(movedTo, host)) {
    throw new SiteError(`${host} now redirects to ${movedTo}. Try ${movedTo} instead.`);
  }
  const candidates = robots.status === 200 && !looksLikeHtml(robots.body) ? licenseLines(robots.body) : [];
  const foundVia: Discovery['foundVia'] = candidates.length ? 'robots.txt' : 'license.xml';
  // RSL's own setup guide also puts the file at the site root.
  const licenseUrl = (candidates[0] ?? `${origin}/license.xml`).replace(/^http:/, 'https:');
  const doc = await fetchText(licenseUrl);
  if (doc.error || doc.status !== 200) {
    if (!candidates.length) throw new SiteError(`${host} doesn’t publish an RSL license: its robots.txt has no “License:” line and there’s no /license.xml.`);
    throw new SiteError(`${host}’s robots.txt points to ${licenseUrl}, but it couldn’t be read (${doc.error ?? `HTTP ${doc.status}`}).`);
  }
  // A web page where the license should be (a soft 404, a site's home page): say so plainly.
  if (looksLikeHtml(doc.body)) {
    const landed = hostOf(doc.url);
    const where = landed && landed !== hostOf(licenseUrl) ? ` (it redirects to ${landed})` : '';
    throw new SiteError(
      candidates.length
        ? `${host}’s robots.txt points to ${licenseUrl}, but that returned a web page, not an RSL license${where}.`
        : `${host} doesn’t publish an RSL license: its robots.txt has no “License:” line, and /license.xml is a web page${where}.`,
    );
  }
  try {
    const result = readRsl(doc.body, today);
    const licenseHost = new URL(doc.url).hostname;
    if (!sameSite(licenseHost, host)) result.warnings.unshift(`${host} points to a license hosted on ${licenseHost}, not on the site itself.`);
    return { ...result, discovery: { site: host, foundVia, licenseUrl: doc.url, hostedOnSite: sameSite(licenseHost, host) } };
  } catch (err) {
    if (err instanceof RslError) throw new SiteError(`${licenseUrl} isn’t a readable RSL license: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------- proving control of the site

export const VERIFICATION_PATH = '/.well-known/tracepay-verification.txt';

export interface OwnershipView {
  domain: string;
  /** What to publish, and where. */
  token: string;
  verificationUrl: string;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastResult: string | null;
}

const view = (o: { domain: string; token: string; verifiedAt: Date | null; lastCheckedAt: Date | null; lastResult: string | null }): OwnershipView => ({
  domain: o.domain,
  token: o.token,
  verificationUrl: `https://${o.domain}${VERIFICATION_PATH}`,
  verifiedAt: o.verifiedAt,
  lastCheckedAt: o.lastCheckedAt,
  lastResult: o.lastResult,
});

async function ownedAsset(db: Db, assetId: string, contributorId: string) {
  const asset = await db.asset.findFirst({ where: { id: assetId, ownerId: contributorId }, select: { id: true } });
  if (!asset) throw new SiteError('Source not found.');
  return asset;
}

/** Starts (or restarts, for another site) a claim: a fresh token to publish on the site. */
export async function claimSite(db: Db, input: { assetId: string; contributorId: string; site: string }): Promise<OwnershipView> {
  await ownedAsset(db, input.assetId, input.contributorId);
  const { host } = siteOrigin(input.site);
  const existing = await db.sourceOwnership.findUnique({ where: { assetId: input.assetId } });
  // The same site keeps its token (and its proof); a different site starts over.
  if (existing && existing.domain === host) return view(existing);
  const token = `tracepay-verification=${randomBytes(18).toString('base64url')}`;
  const data = { domain: host, token, verifiedAt: null, lastCheckedAt: null, lastResult: null };
  const saved = await db.sourceOwnership.upsert({ where: { assetId: input.assetId }, create: { assetId: input.assetId, ...data }, update: data });
  return view(saved);
}

/** Looks for the token on the site. Verified once found; a later failed check doesn't undo it. */
export async function checkSite(db: Db, input: { assetId: string; contributorId: string }, fetchText: FetchText = fetchPublicText): Promise<OwnershipView> {
  await ownedAsset(db, input.assetId, input.contributorId);
  const claim = await db.sourceOwnership.findUnique({ where: { assetId: input.assetId } });
  if (!claim) throw new SiteError('Add your website first.');
  const url = `https://${claim.domain}${VERIFICATION_PATH}`;
  const r = await fetchText(url);
  const landedOnSite = (() => {
    try {
      return sameSite(new URL(r.url).hostname, claim.domain);
    } catch {
      return false;
    }
  })();
  const found = !r.error && r.status === 200 && landedOnSite && r.body.split(/\r?\n/).some((line) => line.trim() === claim.token);
  const lastResult = found
    ? `Found the token at ${url}.`
    : r.error
      ? `Couldn’t read ${url}: ${r.error}`
      : !landedOnSite
        ? `${url} redirected to another site, so it doesn’t prove control of ${claim.domain}.`
        : r.status !== 200
          ? `${url} answered HTTP ${r.status}. Publish the file there, then check again.`
          : `${url} doesn’t contain the token on a line of its own yet.`;
  return db.$transaction(async (tx) => {
    const firstProof = found && !claim.verifiedAt;
    const saved = await tx.sourceOwnership.update({
      where: { id: claim.id },
      data: { lastCheckedAt: new Date(), lastResult, ...(firstProof ? { verifiedAt: new Date() } : {}) },
    });
    if (firstProof) {
      await appendAudit(tx, { entityType: 'asset', entityId: input.assetId, eventType: 'source.owner_verified', payload: { domain: claim.domain, url }, tenantId: input.contributorId });
    }
    return view(saved);
  });
}

/** Verified sites by asset, for publishers' screens and receipts. */
export async function verifiedOwners(db: Db | Tx, assetIds: string[]): Promise<Map<string, string>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db.sourceOwnership.findMany({ where: { assetId: { in: assetIds }, verifiedAt: { not: null } }, select: { assetId: true, domain: true } });
  return new Map(rows.map((r) => [r.assetId, r.domain]));
}
