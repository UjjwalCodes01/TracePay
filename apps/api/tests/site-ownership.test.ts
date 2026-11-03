import { describe, expect, it } from 'vitest';
import { discoverRsl, licenseLines, siteOrigin, SiteError, type FetchText } from '../src/modules/licenses/ownership';

const TODAY = '2026-11-03';
const RSL = `<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license><permits type="usage">ai-input</permits><permits type="user">commercial</permits><payment type="use"><amount currency="USD">0.02</amount></payment></license></content></rsl>`;
/** A pretend web: url → [status, body] (or a redirect target). */
const web = (pages: Record<string, [number, string] | { redirect: string }>): FetchText => async (url) => {
  let at = url;
  for (let i = 0; i < 4; i++) {
    const p = pages[at];
    if (!p) return { status: 404, body: '', url: at, error: null };
    if ('redirect' in p) {
      at = p.redirect;
      continue;
    }
    return { status: p[0], body: p[1], url: at, error: null };
  }
  return { status: null, body: '', url: at, error: 'Too many redirects.' };
};

describe('a contributor’s website', () => {
  it('takes a site as typed, always over HTTPS, and refuses private or local hosts', () => {
    expect(siteOrigin('Example.com')).toEqual({ origin: 'https://example.com', host: 'example.com' });
    expect(siteOrigin('http://www.example.com/blog/post')).toEqual({ origin: 'https://www.example.com', host: 'www.example.com' });
    for (const bad of ['localhost', 'http://127.0.0.1', '10.0.0.8', 'intranet', 'https://example.com:8443', 'ftp://example.com', ''])
      expect(() => siteOrigin(bad), bad).toThrow(SiteError);
  });

  it('reads License: lines from robots.txt, in any group, skipping values that aren’t URLs', () => {
    const robots = 'User-agent: *\nDisallow: /private\nLicense: https://example.com/license.xml # ours\n\nUser-agent: GPTBot\nLicense: ilc_id=ILC-1\nlicense:https://example.com/gpt.xml\n';
    expect(licenseLines(robots)).toEqual(['https://example.com/license.xml', 'https://example.com/gpt.xml']);
  });

  it('finds a site’s RSL license through robots.txt and reads it exactly', async () => {
    const r = await discoverRsl('example.com', TODAY, web({ 'https://example.com/robots.txt': [200, 'License: https://example.com/license.xml'], 'https://example.com/license.xml': [200, RSL] }));
    expect(r).toMatchObject({ source: 'rsl', discovery: { site: 'example.com', foundVia: 'robots.txt', licenseUrl: 'https://example.com/license.xml', hostedOnSite: true } });
    expect(r.terms.aiAnswers).toEqual({ allowed: true, centsPerCitation: 2 });
  });

  it('falls back to /license.xml, notes a license hosted elsewhere, and explains when there is none', async () => {
    const fallback = await discoverRsl('example.com', TODAY, web({ 'https://example.com/license.xml': [200, RSL] }));
    expect(fallback.discovery.foundVia).toBe('license.xml');
    const elsewhere = await discoverRsl('example.com', TODAY, web({ 'https://example.com/robots.txt': [200, 'License: https://collective.example.org/license.xml'], 'https://collective.example.org/license.xml': [200, RSL] }));
    expect(elsewhere.discovery.hostedOnSite).toBe(false);
    expect(elsewhere.warnings[0]).toMatch(/hosted on collective\.example\.org/);
    await expect(discoverRsl('example.com', TODAY, web({ 'https://example.com/robots.txt': [200, 'User-agent: *'] }))).rejects.toThrow(/doesn’t publish an RSL license/);
    await expect(discoverRsl('example.com', TODAY, web({ 'https://example.com/robots.txt': [200, 'License: https://example.com/l.xml'], 'https://example.com/l.xml': [200, '<html>not rsl</html>'] }))).rejects.toThrow(/isn’t a readable RSL license/);
  });
});
