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

export interface Signals {
  consoleErrors: ConsoleSignal[];
  failedRequests: RequestSignal[];
}

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
    page.on("response", (res) => {
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
    return this.consoleErrors.length > 0 || this.failedRequests.length > 0;
  }

  snapshot(): Signals {
    return { consoleErrors: [...this.consoleErrors], failedRequests: [...this.failedRequests] };
  }

  get ignoredCount(): number {
    return this.ignored;
  }

  private clean(s: string): string {
    return this.redactor.redact(s).slice(0, 500);
  }
}
