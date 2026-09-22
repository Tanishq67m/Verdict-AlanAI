import type { Page, Request } from "playwright";

/**
 * Tracks the page's in-flight requests so "wait for the app to settle" means what it says.
 * Playwright's waitForLoadState("networkidle") resolves immediately once the page has EVER
 * been idle, so after a click that fires a fetch it doesn't wait at all; the 500 or the
 * console error from that fetch would then land after we'd already moved on.
 */
export class PageActivity {
  private readonly inflight = new Set<Request>();

  attach(page: Page): void {
    page.on("request", (r) => this.inflight.add(r));
    const done = (r: Request): void => {
      this.inflight.delete(r);
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Resolves once no request has been in flight for `quietMs`, or after `maxMs`.
   * Waits `graceMs` first so handlers that start a fetch after a click get the chance to.
   */
  async settle(page: Page, { graceMs = 150, quietMs = 400, maxMs = 3_000 } = {}): Promise<void> {
    const deadline = Date.now() + maxMs;
    await page.waitForTimeout(graceMs).catch(() => undefined);
    let quietSince = this.inflight.size === 0 ? Date.now() : Number.POSITIVE_INFINITY;
    while (Date.now() < deadline) {
      if (this.inflight.size === 0) {
        if (quietSince === Number.POSITIVE_INFINITY) quietSince = Date.now();
        if (Date.now() - quietSince >= quietMs) return;
      } else {
        quietSince = Number.POSITIVE_INFINITY;
      }
      await page.waitForTimeout(50).catch(() => undefined);
    }
  }
}
