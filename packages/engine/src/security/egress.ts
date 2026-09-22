/**
 * Egress allowlist (PRD → Security). The worker may only drive the browser to the app's own
 * host(s), so a spec can't turn Verdict into a proxy into internal networks.
 * M1: hosts = hostname of base_url. Matching is by hostname, so a local frontend on :3000 and
 * API on :5001 are both "the app". Declared API hosts are an open question for M2.
 */
export function allowedHostsFor(baseUrl: string, extraHosts: readonly string[] = []): Set<string> {
  return new Set([new URL(baseUrl).hostname.toLowerCase(), ...extraHosts.map((h) => h.toLowerCase())]);
}

export function isAllowedUrl(url: string, allowedHosts: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return allowedHosts.has(parsed.hostname.toLowerCase());
}

/** True for URLs that belong to the app (used to scope console/network signals). */
export function isAppUrl(url: string, allowedHosts: ReadonlySet<string>): boolean {
  return isAllowedUrl(url, allowedHosts);
}
