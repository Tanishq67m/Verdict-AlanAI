import type { Page } from "playwright";
import { isAppUrl } from "../security/egress.ts";
import type { Redactor } from "../security/redact.ts";

export interface ConsoleSignal {
  step: number;
  text: string;
}

export interface RequestSignal {
  step: number;
  method: string;
  url: string;
  status: number | null;
  failure: string | null;
}

export interface RedirectLoopSignal {
  step: number;
  /** Paths visited during the looping step, in order (capped). */
  paths: string[];
}

export interface Signals {
  consoleErrors: ConsoleSignal[];
  failedRequests: RequestSignal[];
  redirectLoops: RedirectLoopSignal[];
}

/** A path revisited this many times within ONE action, alternating with another path, is a loop. */
const LOOP_REVISITS = 3;

/**
 * Listens to the page for the two "decide alone" signals from the PRD: network failures and
 * console errors. Scope (PLAN.md C-6):
 *  - network: responses >= 500 and requests that got no response, to app hosts only.
 *    4xx are normal app behavior (e.g. a wrong password → 401) and never decide.
 *  - console: uncaught exceptions (`pageerror`) always; `console.error` only from app scripts.
 *    "Failed to load resource" messages are skipped: the network rule above is the authority.
 * Third-party noise (analytics, maps, fonts) is counted but never decides.
 */
export class SignalCollector {
  private step = 0;
  private readonly consoleErrors: ConsoleSignal[] = [];
  private readonly failedRequests: RequestSignal[] = [];
  private readonly redirectLoops: RedirectLoopSignal[] = [];
  private readonly navigations: Array<{ step: number; path: string }> = [];
  private readonly rateLimited: Array<{ step: number; url: string }> = [];
  private ignored = 0;

  constructor(
    private readonly allowedHosts: ReadonlySet<string>,
    private readonly redactor: Redactor,
  ) {}

  attach(page: Page): void {
    page.on("pageerror", (err) => {
      this.consoleErrors.push({ step: this.step, text: this.clean(`Uncaught ${err.name}: ${err.message}`) });
    });
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      const source = msg.location().url;
      if (text.startsWith("Failed to load resource") || !source || !isAppUrl(source, this.allowedHosts)) {
        this.ignored++;
        return;
      }
      this.consoleErrors.push({ step: this.step, text: this.clean(text) });
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      let path: string;
      try {
        const u = new URL(frame.url());
        if (u.protocol !== "http:" && u.protocol !== "https:") return;
        path = u.pathname;
      } catch {
        return;
      }
      this.navigations.push({ step: this.step, path });
      this.detectLoop();
    });
    page.on("response", (res) => {
      // 429 = the app throttled US. That's the test environment, not an app bug (see run.ts).
      if (res.status() === 429 && isAppUrl(res.url(), this.allowedHosts)) {
        this.rateLimited.push({ step: this.step, url: this.clean(res.url()) });
        return;
      }
      if (res.status() < 500) return;
      if (!isAppUrl(res.url(), this.allowedHosts)) {
        this.ignored++;
        return;
      }
      this.failedRequests.push({
        step: this.step,
        method: res.request().method(),
        url: this.clean(res.url()),
        status: res.status(),
        failure: null,
      });
    });
    page.on("requestfailed", (req) => {
      const failure = req.failure()?.errorText ?? "unknown";
      // ERR_ABORTED = the browser cancelled it (navigation away, superseded fetch): not an app failure.
      if (failure.includes("ERR_ABORTED") || !isAppUrl(req.url(), this.allowedHosts)) {
        this.ignored++;
        return;
      }
      this.failedRequests.push({ step: this.step, method: req.method(), url: this.clean(req.url()), status: null, failure });
    });
  }

  /** Signals that arrive from now on are attributed to this step. */
  setStep(step: number): void {
    this.step = step;
  }

  hasHardSignal(): boolean {
    return this.consoleErrors.length > 0 || this.failedRequests.length > 0 || this.redirectLoops.length > 0;
  }

  snapshot(): Signals {
    return { consoleErrors: [...this.consoleErrors], failedRequests: [...this.failedRequests], redirectLoops: [...this.redirectLoops] };
  }

  /** HTTP 429s from the app during this attempt (the app rate-limited the test run). */
  get rateLimitedRequests(): ReadonlyArray<{ step: number; url: string }> {
    return this.rateLimited;
  }

  /**
   * One user action should never visit the same page 3+ times while bouncing between pages.
   * If it does, the app is redirecting in a loop (e.g. login → events → login …). Requiring
   * a second distinct path avoids flagging same-page query/hash updates.
   */
  private detectLoop(): void {
    if (this.redirectLoops.some((l) => l.step === this.step)) return;
    const paths = this.navigations.filter((n) => n.step === this.step).map((n) => n.path);
    const counts = new Map<string, number>();
    for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
    if (counts.size >= 2 && [...counts.values()].some((c) => c >= LOOP_REVISITS)) {
      this.redirectLoops.push({ step: this.step, paths: paths.slice(-8) });
    }
  }

  get ignoredCount(): number {
    return this.ignored;
  }

  private clean(s: string): string {
    return this.redactor.redact(s).slice(0, 500);
  }
}
