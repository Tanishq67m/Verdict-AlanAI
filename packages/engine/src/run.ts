import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { costUsd, UsageMeter, type LlmClient, type Price } from "@verdict/llm";
import {
  aggregateStatus,
  summarize,
  VerdictV1Schema,
  type CriterionSpec,
  type CriterionVerdict,
  type TaskSpec,
  type Verdict,
} from "@verdict/schema";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import type { Logger } from "./logger.ts";
import { runCriterion, type StepRecord } from "./loop.ts";
import { AriaSnapshotObserver } from "./observe/aria.ts";
import type { Observer } from "./observe/types.ts";
import { allowedHostsFor } from "./security/egress.ts";
import { secretsFromSpec } from "./security/placeholders.ts";
import type { Redactor } from "./security/redact.ts";
import { PageActivity } from "./signals/activity.ts";
import { SignalCollector } from "./signals/collector.ts";

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
  /** Fixed run id (tests); default random. */
  runId?: string;
}

export interface RunResult {
  verdict: Verdict;
  artifactsPath: string;
  steps: Record<string, StepRecord[]>;
}

/** Grace period after the run deadline before a hung browser operation is abandoned. */
const WATCHDOG_GRACE_MS = 15_000;

export function newRunId(): string {
  return `run_${randomBytes(4).toString("hex")}`;
}

function errorVerdict(id: string, message: string, evidence: CriterionVerdict["evidence"]): CriterionVerdict {
  return {
    id,
    result: "error",
    expected: "Verdict completes the check",
    observed: message,
    failing_step: null,
    evidence,
    repair_hint: "This is a Verdict or infrastructure error, not an app failure. Do not change app code for it; fix the setup or re-run.",
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
 * Runs the selected criteria, each in a fresh browser context (no shared cookies or storage),
 * and returns a schema-validated verdict. Every criterion ends in exactly one result; anything
 * that goes wrong inside Verdict becomes `error` for that criterion instead of crashing the run.
 */
export async function runVerification(options: RunOptions): Promise<RunResult> {
  const { spec, llm, redactor } = options;
  const runId = options.runId ?? newRunId();
  const logger = options.logger.child({ run_id: runId });
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
  const stepsByCriterion: Record<string, StepRecord[]> = {};
  const noEvidence = { screenshot_url: null, trace_url: null, console_errors: [], failed_requests: [] };

  logger.info("run_started", { task: spec.task, base_url: spec.base_url, criteria: selected.map((c) => c.id), llm: `${llm.provider}/${llm.model}`, observer: observer.name });

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, ...options.launch });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] ?? err.message : String(err);
    logger.error("browser_launch_failed", { message: msg });
    for (const c of selected) results.push(errorVerdict(c.id, `Could not launch Chromium (${msg}). Run: pnpm setup:browsers`, noEvidence));
  }

  if (browser) {
    try {
      for (const criterion of selected) {
        const clog = logger.child({ criterion_id: criterion.id });
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          serviceWorkers: "block",
          acceptDownloads: false,
        });
        const page = await context.newPage();
        const collector = new SignalCollector(allowedHosts, redactor);
        collector.attach(page);
        const activity = new PageActivity();
        activity.attach(page);

        let verdict: CriterionVerdict;
        let steps: StepRecord[] = [];
        try {
          if (Date.now() >= deadline) throw new Error("Run timeout reached before this criterion started");
          const out = await withWatchdog(
            runCriterion({ page, spec, criterion, llm, meter, observer, collector, activity, redactor, secrets, allowedHosts, deadline, logger: clog }),
            deadline,
            () => context.close().catch(() => undefined),
          );
          steps = out.steps;
          const signals = collector.snapshot();
          const decisionStep = out.decision.failingStep ?? steps.length;
          const shot = join(artifactsPath, `${criterion.id}-step${decisionStep}.png`);
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
            evidence: {
              screenshot_url: screenshotUrl,
              trace_url: null, // Playwright trace files land in M2 together with trace redaction.
              console_errors: signals.consoleErrors.map((c) => `[step ${c.step}] ${c.text}`),
              failed_requests: signals.failedRequests.map(({ method, url, status, failure }) => ({ method, url, status, failure })),
            },
            repair_hint: out.decision.repairHint ? redactor.redact(out.decision.repairHint) : null,
          };
          clog.info("criterion_done", { result: verdict.result, ignored_signals: collector.ignoredCount });
        } catch (err) {
          const msg = redactor.redact(err instanceof Error ? err.message : String(err));
          clog.error("criterion_error", { message: msg });
          const signals = collector.snapshot();
          verdict = errorVerdict(criterion.id, msg, {
            ...noEvidence,
            console_errors: signals.consoleErrors.map((c) => `[step ${c.step}] ${c.text}`),
            failed_requests: signals.failedRequests.map(({ method, url, status, failure }) => ({ method, url, status, failure })),
          });
        } finally {
          await context.close().catch(() => undefined);
        }
        results.push(verdict);
        stepsByCriterion[criterion.id] = steps;
        await writeFile(join(artifactsPath, `${criterion.id}-steps.json`), `${JSON.stringify(steps, null, 2)}\n`);
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
  return { verdict, artifactsPath, steps: stepsByCriterion };
}
