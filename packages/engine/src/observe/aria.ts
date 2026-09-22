import type { Page } from "playwright";
import type { Observation, Observer } from "./types.ts";

export interface AriaObserverOptions {
  /** Upper bound on characters sent to the LLM per step (cost guard). */
  maxChars?: number;
  timeoutMs?: number;
}

/**
 * Uses Playwright's AI-mode ARIA snapshot (`page.ariaSnapshot({ mode: "ai" })`): the page's
 * accessibility tree as YAML, with a `[ref=eN]` on each element. `aria-ref=eN` locators resolve
 * those refs, and refs stay attached to the same DOM element across snapshots.
 */
export class AriaSnapshotObserver implements Observer {
  readonly name = "aria";
  private readonly maxChars: number;
  private readonly timeoutMs: number;

  constructor(options: AriaObserverOptions = {}) {
    this.maxChars = options.maxChars ?? 16_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async observe(page: Page): Promise<Observation> {
    const raw = await page.ariaSnapshot({ mode: "ai", timeout: this.timeoutMs });
    // `[cursor=pointer]` repeats on every link and carries no information the planner needs.
    const cleaned = raw.replace(/ \[cursor=pointer\]/g, "");
    const truncated = cleaned.length > this.maxChars;
    const content = truncated ? `${cleaned.slice(0, this.maxChars)}\n… [snapshot truncated]` : cleaned;
    return { url: page.url(), title: await page.title(), content, truncated };
  }
}

/** The snapshot line describing a ref, e.g. `button "Confirm Booking"`, for traces and hints. */
export function describeRef(content: string, ref: string): string | null {
  const marker = `[ref=${ref}]`;
  const line = content.split("\n").find((l) => l.includes(marker));
  if (!line) return null;
  return line
    .replace(marker, "")
    .replace(/^\s*-\s*/, "")
    .replace(/\s*\[[a-z]+(=[^\]]*)?\]/g, "")
    .replace(/:\s*$/, "")
    .trim();
}
