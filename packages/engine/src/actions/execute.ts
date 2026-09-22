import { errors, type Locator, type Page } from "playwright";
import { isAllowedUrl } from "../security/egress.ts";
import { resolvePlaceholders, PlaceholderError } from "../security/placeholders.ts";
import type { Secret } from "../security/redact.ts";
import { describeAssertion, type Action, type Assertion } from "./schema.ts";

export interface ActionContext {
  page: Page;
  baseUrl: string;
  allowedHosts: ReadonlySet<string>;
  secrets: readonly Secret[];
  /** Upper bound for this action, already capped by the run deadline. */
  timeoutMs: number;
  /** Waits until the app's requests triggered by the action have finished (see PageActivity). */
  settle: () => Promise<void>;
}

export type ActionOutcome =
  | { kind: "ok"; note: string }
  | { kind: "assertion"; passed: boolean; expected: string; observed: string }
  | { kind: "conclude"; summary: string }
  /** The action couldn't be carried out. Reported back to the planner; it is NOT an app failure by itself. */
  | { kind: "error"; message: string; transient: boolean };

/** Browser or context is gone: Verdict itself is broken, so this must surface as result `error`. */
export class BrowserGoneError extends Error {
  override readonly name = "BrowserGoneError";
}

const ASSERT_POLL_MS = 3_000;

/** Messages Playwright uses for races that usually succeed on retry (retry itself lands in M2). */
const TRANSIENT = /detached|not attached|Execution context was destroyed|frame was detached|navigation/i;
const GONE = /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i;

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return (msg.split("\n")[0] ?? msg).trim();
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function resolveRef(page: Page, ref: string): Promise<Locator | string> {
  const loc = page.locator(`aria-ref=${ref}`);
  if ((await loc.count()) === 0) return `No element with ref ${ref} on the current page. Use a ref from the latest snapshot.`;
  return loc;
}

async function evaluateAssertion(a: Assertion, ctx: ActionContext): Promise<ActionOutcome> {
  const { page } = ctx;
  const expected = describeAssertion(a);
  const poll = Math.min(ASSERT_POLL_MS, ctx.timeoutMs);
  switch (a.kind) {
    case "text_visible": {
      try {
        await page.getByText(a.text).first().waitFor({ state: "visible", timeout: poll });
        return { kind: "assertion", passed: true, expected: `"${a.text}" is visible`, observed: `"${a.text}" is visible` };
      } catch (err) {
        if (!(err instanceof errors.TimeoutError)) throw err;
        return { kind: "assertion", passed: false, expected: `"${a.text}" is visible`, observed: `"${a.text}" is not visible on ${page.url()}` };
      }
    }
    case "text_not_visible": {
      const deadline = Date.now() + poll;
      let count = await page.getByText(a.text).filter({ visible: true }).count();
      while (count > 0 && Date.now() < deadline) {
        await page.waitForTimeout(250);
        count = await page.getByText(a.text).filter({ visible: true }).count();
      }
      return {
        kind: "assertion",
        passed: count === 0,
        expected: `"${a.text}" is not visible`,
        observed: count === 0 ? `"${a.text}" is not visible` : `"${a.text}" is visible (${count} match${count > 1 ? "es" : ""})`,
      };
    }
    case "element_text": {
      const loc = await resolveRef(page, a.ref);
      if (typeof loc === "string") return { kind: "error", message: loc, transient: false };
      const actual = normalize(await loc.first().innerText({ timeout: poll }));
      const passed = a.equals !== undefined ? actual === normalize(a.equals) : actual.toLowerCase().includes(normalize(a.contains ?? "").toLowerCase());
      const want = a.equals !== undefined ? `text equals "${a.equals}"` : `text contains "${a.contains}"`;
      return { kind: "assertion", passed, expected: `${a.ref} ${want}`, observed: `${a.ref} text is "${actual.slice(0, 200)}"` };
    }
    case "element_enabled":
    case "element_disabled": {
      const loc = await resolveRef(page, a.ref);
      if (typeof loc === "string") return { kind: "error", message: loc, transient: false };
      const enabled = await loc.first().isEnabled({ timeout: poll });
      const wantEnabled = a.kind === "element_enabled";
      return {
        kind: "assertion",
        passed: enabled === wantEnabled,
        expected: `${a.ref} is ${wantEnabled ? "enabled" : "disabled"}`,
        observed: `${a.ref} is ${enabled ? "enabled" : "disabled"}`,
      };
    }
    case "url_contains": {
      const url = page.url();
      return { kind: "assertion", passed: url.includes(a.value), expected, observed: `url is ${url}` };
    }
  }
}

async function perform(action: Action, ctx: ActionContext): Promise<ActionOutcome> {
  const { page, timeoutMs } = ctx;
  switch (action.type) {
    case "navigate": {
      let target: URL;
      try {
        target = new URL(action.url, ctx.baseUrl);
      } catch {
        return { kind: "error", message: `Invalid URL "${action.url}"`, transient: false };
      }
      if (!isAllowedUrl(target.href, ctx.allowedHosts)) {
        return { kind: "error", message: `Blocked: ${target.hostname} is not an allowed host for this run`, transient: false };
      }
      const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await ctx.settle();
      return { kind: "ok", note: `loaded ${page.url()}${response ? ` (HTTP ${response.status()})` : ""}` };
    }
    case "click": {
      const loc = await resolveRef(page, action.ref);
      if (typeof loc === "string") return { kind: "error", message: loc, transient: false };
      await loc.click({ timeout: timeoutMs });
      await ctx.settle();
      return { kind: "ok", note: "clicked" };
    }
    case "type": {
      const loc = await resolveRef(page, action.ref);
      if (typeof loc === "string") return { kind: "error", message: loc, transient: false };
      let value: string;
      try {
        value = resolvePlaceholders(action.text, ctx.secrets);
      } catch (err) {
        if (err instanceof PlaceholderError) return { kind: "error", message: err.message, transient: false };
        throw err;
      }
      await loc.fill(value, { timeout: timeoutMs });
      if (action.submit) {
        await loc.press("Enter", { timeout: timeoutMs });
        await ctx.settle();
      }
      return { kind: "ok", note: action.submit ? "typed and submitted" : "typed" };
    }
    case "select": {
      const loc = await resolveRef(page, action.ref);
      if (typeof loc === "string") return { kind: "error", message: loc, transient: false };
      const selected = await loc.selectOption(action.option, { timeout: timeoutMs });
      if (selected.length === 0) return { kind: "error", message: `No option matching "${action.option}"`, transient: false };
      await ctx.settle();
      return { kind: "ok", note: `selected ${selected.join(", ")}` };
    }
    case "wait_for": {
      const t = Math.min(action.timeout_ms ?? 5_000, timeoutMs);
      try {
        if (action.text !== undefined) {
          await page.getByText(action.text).first().waitFor({ state: "visible", timeout: t });
          return { kind: "ok", note: `"${action.text}" appeared` };
        }
        const fragment = action.url_contains ?? "";
        await page.waitForURL((u) => u.href.includes(fragment), { timeout: t });
        return { kind: "ok", note: `url now ${page.url()}` };
      } catch (err) {
        if (err instanceof errors.TimeoutError) {
          return { kind: "error", message: `wait_for timed out after ${t} ms (url ${page.url()})`, transient: false };
        }
        throw err;
      }
    }
    case "assert":
      return evaluateAssertion(action.assertion, ctx);
    case "conclude":
      return { kind: "conclude", summary: action.summary };
  }
}

/**
 * Executes one action from the closed set. Playwright failures (timeouts, detached elements,
 * disabled buttons) become `error` outcomes the planner can react to; only a dead browser throws.
 */
export async function executeAction(action: Action, ctx: ActionContext): Promise<ActionOutcome> {
  let outcome: ActionOutcome;
  try {
    outcome = await perform(action, ctx);
  } catch (err) {
    const message = firstLine(err);
    if (GONE.test(message)) throw new BrowserGoneError(message, { cause: err });
    if (err instanceof errors.TimeoutError) return { kind: "error", message: `Timed out: ${message}`, transient: false };
    return { kind: "error", message, transient: TRANSIENT.test(message) };
  }

  // An action (a link, a form post, a redirect) may have taken the browser off the app.
  const url = ctx.page.url();
  if (url !== "about:blank" && !isAllowedUrl(url, ctx.allowedHosts)) {
    await ctx.page.goBack({ timeout: 5_000 }).catch(() => undefined);
    return { kind: "error", message: `Navigation left the allowed hosts (${new URL(url).hostname}); went back`, transient: false };
  }
  return outcome;
}
