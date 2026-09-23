import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { costUsd, LlmError, UsageMeter, type LlmClient, type Price } from "@verdict/llm";
import {
  aggregateStatus,
  summarize,
  VerdictV1Schema,
  type CriterionSpec,
  type CriterionVerdict,
  type Result,
  type TaskSpec,
  type Verdict,
} from "@verdict/schema";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import type { DecidedBy } from "./judge/judge.ts";
import type { Logger } from "./logger.ts";
import { runCriterion, type StepRecord } from "./loop.ts";
import { AriaSnapshotObserver } from "./observe/aria.ts";
import type { Observer } from "./observe/types.ts";
import { allowedHostsFor } from "./security/egress.ts";
import { secretsFromSpec } from "./security/placeholders.ts";
import type { Redactor } from "./security/redact.ts";
import { PageActivity } from "./signals/activity.ts";
import { SignalCollector, type Signals } from "./signals/collector.ts";

/**
 * Runs before every attempt of every criterion, e.g. to reset test data (cancel the test
 * user's bookings). Configured by whoever operates the worker, never by the spec, so a
 * pull request can't make the worker execute anything.
 */
export type BeforeAttemptHook = (ctx: { criterionId: string; attempt: number; logger: Logger }) => Promise<void>;

export interface RunOptions {
  spec: TaskSpec;
  /** Subset of criterion ids to run; default: all in the spec. */
  criterionIds?: readonly string[];
  llm: LlmClient;
  price: Price;
  redactor: Redactor;
  logger: Logger;
  /** Screenshots, step traces and verdict.json go to <artifactsDir>/<run_id>/. */
  artifactsDir: string;
  commit?: string | null;
  observer?: Observer;
  launch?: LaunchOptions;
  beforeAttempt?: BeforeAttemptHook;
  /** Re-run a failed criterion once in a fresh browser before reporting it (PRD flake handling). Default true. */
  rerunFailures?: boolean;
  /** Pause before retrying an attempt that hit a transient LLM-provider error (default 20 s; tests use 0). */
  providerRetryPauseMs?: number;
  /** Run id; generate it with newRunId() before creating the logger so every log line carries it. */
  runId?: string;
}

export interface AttemptRecord {
  attempt: number;
  result: Result;
  decided_by: DecidedBy | "error";
  steps: StepRecord[];
  /** True when the attempt died on a transient LLM-provider error (429/5xx), so a retry may succeed. */
  transient_error?: boolean;
}

export interface RunResult {
  verdict: Verdict;
  artifactsPath: string;
  /** Per criterion, every attempt that ran (1, or 2 when a failure was re-checked). */
  attempts: Record<string, AttemptRecord[]>;
}

/** Grace period after the run deadline before a hung browser operation is abandoned. */
const WATCHDOG_GRACE_MS = 15_000;
/** Don't start a confirmation rerun with less than this left on the run clock. */
const MIN_RERUN_BUDGET_MS = 30_000;
/** Pause before retrying an attempt that died on a transient LLM-provider error. */
const PROVIDER_RETRY_PAUSE_MS = 20_000;

/** Provider hiccups (rate limit, overload, outage) that are worth one more try. */
function isTransientProviderError(err: unknown): boolean {
  let e: unknown = err;
  while (e instanceof Error) {
    if (e instanceof LlmError) return e.status === 429 || (e.status !== null && e.status >= 500);
    e = e.cause;
  }
  return false;
}

export function newRunId(): string {
  return `run_${randomBytes(4).toString("hex")}`;
}

const NOT_APP_FAILURE =
  "This is a Verdict or test-environment problem, not an app failure. Do not change app code for it; fix the setup or re-run.";

function errorVerdict(id: string, message: string, evidence: CriterionVerdict["evidence"]): CriterionVerdict {
  return { id, result: "error", expected: "Verdict completes the check", observed: message, failing_step: null, evidence, repair_hint: NOT_APP_FAILURE };
}

function evidenceFrom(signals: Signals, screenshotUrl: string | null): CriterionVerdict["evidence"] {
  return {
    screenshot_url: screenshotUrl,
    trace_url: null, // Playwright trace files need secret redaction of the zip first; not shipped yet.
    console_errors: signals.consoleErrors.map((c) => `[step ${c.step}] ${c.text}`),
    failed_requests: signals.failedRequests.map(({ method, url, status, failure }) => ({ method, url, status, failure })),
  };
}

async function withWatchdog<T>(work: Promise<T>, deadline: number, onTimeout: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout().finally(() => reject(new Error("Run exceeded its hard timeout; the browser context was killed")));
    }, Math.max(0, deadline - Date.now()) + WATCHDOG_GRACE_MS);
  });
  try {
    return await Promise.race([work, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The PRD's flake rule: a failure is only reported as `fail` if a second attempt in a fresh
 * browser fails too. If the two attempts disagree, report `inconclusive` rather than pick one.
 */
export function combineAttempts(first: CriterionVerdict, second: CriterionVerdict): CriterionVerdict {
  if (second.result === "fail") {
    return { ...first, observed: `${first.observed} (confirmed by a second attempt in a fresh browser)` };
  }
  return {
    ...first,
    result: "inconclusive",
    observed: `Attempt 1 failed: ${first.observed}. Attempt 2 (fresh browser) was ${second.result}: ${second.observed}. The attempts disagree, so neither is reported as the answer.`,
    repair_hint: `Flaky behavior: the same check failed once and did not fail on a clean retry. Look for race conditions or timing-dependent UI around step ${first.failing_step ?? "?"}. First failure: ${first.repair_hint ?? first.observed}`,
  };
}

/**
 * Runs the selected criteria, each attempt in a fresh browser context (no shared cookies or
 * storage), and returns a schema-validated verdict. Anything that goes wrong inside Verdict
 * becomes `error` for that criterion instead of crashing the run.
 */
export async function runVerification(options: RunOptions): Promise<RunResult> {
  const { spec, llm, redactor, logger } = options;
  const runId = options.runId ?? newRunId();
  const started = Date.now();
  const deadline = started + spec.limits.timeout_seconds * 1000;
  const artifactsPath = resolve(options.artifactsDir, runId);
  await mkdir(artifactsPath, { recursive: true });

  const selected: CriterionSpec[] = options.criterionIds?.length
    ? options.criterionIds.map((id) => {
        const c = spec.criteria.find((x) => x.id === id);
        if (!c) throw new Error(`Unknown criterion "${id}". Spec has: ${spec.criteria.map((x) => x.id).join(", ")}`);
        return c;
      })
    : spec.criteria;

  const observer = options.observer ?? new AriaSnapshotObserver();
  const secrets = secretsFromSpec(spec);
  const allowedHosts = allowedHostsFor(spec.base_url);
  const meter = new UsageMeter();
  const results: CriterionVerdict[] = [];
  const attemptsByCriterion: Record<string, AttemptRecord[]> = {};
  const noSignals: Signals = { consoleErrors: [], failedRequests: [], redirectLoops: [] };

  logger.info("run_started", { task: spec.task, base_url: spec.base_url, criteria: selected.map((c) => c.id), llm: `${llm.provider}/${llm.model}`, observer: observer.name });

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, ...options.launch });
  } catch (err) {
    const msg = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    logger.error("browser_launch_failed", { message: msg });
    for (const c of selected) results.push(errorVerdict(c.id, `Could not launch Chromium (${msg}). Run: pnpm setup:browsers`, evidenceFrom(noSignals, null)));
  }

  const runAttempt = async (b: Browser, criterion: CriterionSpec, attempt: number): Promise<{ verdict: CriterionVerdict; record: AttemptRecord }> => {
    const clog = logger.child({ criterion_id: criterion.id, attempt });
    const context = await b.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false });
    const page = await context.newPage();
    const collector = new SignalCollector(allowedHosts, redactor);
    collector.attach(page);
    const activity = new PageActivity(allowedHosts);
    activity.attach(page);

    let verdict: CriterionVerdict;
    let steps: StepRecord[] = [];
    let decidedBy: AttemptRecord["decided_by"] = "error";
    let transient = false;
    try {
      if (options.beforeAttempt) {
        try {
          await options.beforeAttempt({ criterionId: criterion.id, attempt, logger: clog });
        } catch (err) {
          throw new Error(`Test-data reset failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (Date.now() >= deadline) throw new Error("Run timeout reached before this criterion started");
      const out = await withWatchdog(
        runCriterion({ page, spec, criterion, llm, meter, observer, collector, activity, redactor, secrets, allowedHosts, deadline, logger: clog }),
        deadline,
        () => context.close().catch(() => undefined),
      );
      steps = out.steps;
      decidedBy = out.decision.decidedBy;
      const decisionStep = out.decision.failingStep ?? steps.length;
      const shot = join(artifactsPath, `${criterion.id}-attempt${attempt}-step${decisionStep}.png`);
      let screenshotUrl: string | null = null;
      try {
        await page.screenshot({ path: shot, fullPage: false, animations: "disabled", caret: "hide" });
        screenshotUrl = pathToFileURL(shot).href;
      } catch (err) {
        clog.warn("screenshot_failed", { message: err instanceof Error ? err.message : String(err) });
      }
      verdict = {
        id: criterion.id,
        result: out.decision.result,
        expected: redactor.redact(out.decision.expected),
        observed: redactor.redact(out.decision.observed),
        failing_step: out.decision.failingStep,
        evidence: evidenceFrom(collector.snapshot(), screenshotUrl),
        repair_hint: out.decision.repairHint ? redactor.redact(out.decision.repairHint) : null,
      };
      // If the app throttled us, a non-pass can't be trusted: it may be the 429, not a bug.
      const throttled = collector.rateLimitedRequests[0];
      if (throttled && verdict.result !== "pass") {
        clog.warn("rate_limited", { url: throttled.url, step: throttled.step, count: collector.rateLimitedRequests.length });
        verdict = {
          ...verdict,
          result: "error",
          observed: `The app rate-limited this test run (HTTP 429 on ${throttled.url} at step ${throttled.step}), so the result can't be trusted. Underlying outcome: ${verdict.result}: ${verdict.observed}`,
          repair_hint: `${NOT_APP_FAILURE} Wait for the app's rate-limit window to reset, or raise the limit in the test environment.`,
        };
        decidedBy = "error";
      }
      clog.info("attempt_done", { result: verdict.result, decided_by: decidedBy, ignored_signals: collector.ignoredCount });
    } catch (err) {
      const msg = redactor.redact(err instanceof Error ? err.message : String(err));
      transient = isTransientProviderError(err);
      clog.error("attempt_error", { message: msg, transient });
      verdict = errorVerdict(criterion.id, msg, evidenceFrom(collector.snapshot(), null));
    } finally {
      await context.close().catch(() => undefined);
    }
    await writeFile(join(artifactsPath, `${criterion.id}-attempt${attempt}-steps.json`), `${JSON.stringify(steps, null, 2)}\n`);
    return { verdict, record: { attempt, result: verdict.result, decided_by: decidedBy, steps, ...(transient ? { transient_error: true } : {}) } };
  };

  if (browser) {
    try {
      for (const criterion of selected) {
        let first = await runAttempt(browser, criterion, 1);
        const records = [first.record];
        // Infrastructure retry (not the flake rule): the LLM provider was rate-limited or down.
        // That says nothing about the app, so try the attempt once more after a pause.
        if (first.record.transient_error && deadline - Date.now() > MIN_RERUN_BUDGET_MS + PROVIDER_RETRY_PAUSE_MS) {
          logger.warn("provider_retry", { criterion_id: criterion.id, pause_ms: options.providerRetryPauseMs ?? PROVIDER_RETRY_PAUSE_MS });
          await new Promise((r) => setTimeout(r, options.providerRetryPauseMs ?? PROVIDER_RETRY_PAUSE_MS));
          first = await runAttempt(browser, criterion, records.length + 1);
          records.push(first.record);
        }
        let final = first.verdict;
        const canRerun = options.rerunFailures !== false && deadline - Date.now() > MIN_RERUN_BUDGET_MS;
        if (first.verdict.result === "fail" && canRerun) {
          logger.info("rerun_failed_criterion", { criterion_id: criterion.id });
          const second = await runAttempt(browser, criterion, records.length + 1);
          records.push(second.record);
          final = combineAttempts(first.verdict, second.verdict);
        } else if (first.verdict.result === "fail") {
          logger.warn("rerun_skipped", { criterion_id: criterion.id, reason: "not enough time left" });
        }
        logger.info("criterion_done", { criterion_id: criterion.id, result: final.result, attempts: records.length });
        results.push(final);
        attemptsByCriterion[criterion.id] = records;
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  const usage = meter.snapshot();
  const verdict = VerdictV1Schema.parse({
    run_id: runId,
    status: aggregateStatus(results.map((r) => r.result)),
    commit: options.commit ?? null,
    summary: summarize(results.map((r) => r.result)),
    criteria: results,
    cost: { llm_tokens: usage.totalTokens, usd: Number(costUsd(usage, options.price).toFixed(6)) },
    duration_ms: Date.now() - started,
  });
  await writeFile(join(artifactsPath, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  logger.info("run_finished", { status: verdict.status, duration_ms: verdict.duration_ms, llm_calls: meter.callCount, llm_tokens: usage.totalTokens, usd: verdict.cost.usd });
  return { verdict, artifactsPath, attempts: attemptsByCriterion };
}
