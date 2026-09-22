/** A secret value and the placeholder name that stands for it (e.g. `auth.password`). */
export interface Secret {
  name: string;
  value: string;
}

const MIN_SECRET_LENGTH = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces secret values with their placeholder (`{{auth.email}}`) in any text leaving the
 * worker: logs, the LLM prompt (page text can echo the logged-in email), step traces.
 *
 * Each secret is matched raw, URL-encoded and JSON-escaped, case-insensitively, longest first
 * so a password that contains the email is still fully hidden. Bearer tokens and JWTs are
 * removed generically: they are session credentials even though they're not in the spec.
 */
export class Redactor {
  private readonly patterns: Array<{ re: RegExp; replacement: string }>;

  constructor(secrets: readonly Secret[]) {
    const variants: Array<{ needle: string; replacement: string }> = [];
    for (const { name, value } of secrets) {
      if (value.length < MIN_SECRET_LENGTH) continue;
      const replacement = `{{${name}}}`;
      for (const v of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])) {
        variants.push({ needle: v, replacement });
      }
    }
    variants.sort((a, b) => b.needle.length - a.needle.length);
    this.patterns = variants.map(({ needle, replacement }) => ({ re: new RegExp(escapeRegExp(needle), "gi"), replacement }));
  }

  redact(text: string): string {
    let out = text;
    for (const { re, replacement } of this.patterns) out = out.replace(re, replacement);
    out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
    out = out.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED_JWT]");
    return out;
  }
}
