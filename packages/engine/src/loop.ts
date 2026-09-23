import type { LlmClient, UsageMeter } from "@verdict/llm";
import { LlmError } from "@verdict/llm";
import type { CriterionSpec, TaskSpec } from "@verdict/schema";
import type { Page } from "playwright";
import { executeAction } from "./actions/execute.ts";
import { describeAction, LlmJudgment, PlannerOutput, judgmentJsonSchema, plannerJsonSchema, type Action } from "./actions/schema.ts";
import { judge, type AssertionRecord, type Decision, type StopReason } from "./judge/judge.ts";
import type { Logger } from "./logger.ts";
import { describeRef } from "./observe/aria.ts";
import type { Observation, Observer } from "./observe/types.ts";
import { buildJudgePrompt, buildPlannerPrompt, JUDGE_SYSTEM, PLANNER_SYSTEM } from "./prompts.ts";
import type { Redactor, Secret } from "./security/redact.ts";
import type { PageActivity } from "./signals/activity.ts";
import type { SignalCollector } from "./signals/collector.ts";

export interface StepRecord {
  step: number;
  /** Planner's stated reason (redacted). Empty for the engine's own opening navigation. */
  thought: string;
  action: Action | null;
  /** e.g. `button "Confirm Booking"` for ref-based actions. */
  target: string | null;
  ok: boolean;
  outcome: string;
  url: string;
  elapsed_ms: number;
}

export interface CriterionRunInput {
  page: Page;
  spec: TaskSpec;
  criterion: CriterionSpec;
  llm: LlmClient;
  meter: UsageMeter;
  observer: Observer;
  collector: SignalCollector;
  activity: PageActivity;
  redactor: Redactor;
  secrets: readonly Secret[];
  allowedHosts: ReadonlySet<string>;
  /** Epoch ms after which no new work starts (the run timeout). */
  deadline: number;
  logger: Logger;
}

export interface CriterionRunOutput {
  decision: Decision;
  stop: StopReason;
  steps: StepRecord[];
}

/** Verdict's own fault (bad LLM output, provider down). Mapped to result `error`, never `fail`. */
export class EngineError extends Error {
  override readonly name = "EngineError";
}

const MAX_INVALID_PLANS = 3;
const MAX_ACTION_MS = 15_000;
const PLAN_MAX_OUTPUT_TOKENS = 1_024;

function historyLine(r: StepRecord): string {
  const what = r.action ? describeAction(r.action) : "invalid action";
  const target = r.target ? ` [${r.target}]` : "";
  // The planner is stateless between calls; its own earlier reasoning ("the page says 40 left")
  // is how it remembers values it read. Truncated to keep prompts small.
  const why = r.thought ? ` (reason: ${r.thought.slice(0, 200)})` : "";
  return `${r.step}. ${what}${target}${why} → ${r.ok ? "ok" : "ERROR"}: ${r.outcome}`;
}

function parseJson(text: string): unknown {
  // Models occasionally wrap JSON in a markdown fence even when asked not to.
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(unfenced);
}

/**
 * One criterion's bounded observe → act → judge loop (PRD → "The loop, per criterion").
 * Stops on: a hard signal (network/console), a failed final assertion, `conclude`,
 * max_steps_per_criterion, or the run deadline, whichever comes first.
 */
export async function runCriterion(input: CriterionRunInput): Promise<CriterionRunOutput> {
  const { page, spec, criterion, llm, meter, observer, collector, activity, redactor, logger } = input;
  const settle = (): Promise<void> => activity.settle(page);
  const maxSteps = spec.limits.max_steps_per_criterion;
  const started = Date.now();
  const steps: StepRecord[] = [];
  const assertions: AssertionRecord[] = [];
  const placeholders = input.secrets.map((s) => `{{${s.name}}}`);
  let conclusion: string | null = null;
  let stop: StopReason = "step_budget";
  let invalidStreak = 0;

  const remaining = (): number => input.deadline - Date.now();
  const actionTimeout = (): number => Math.max(1_000, Math.min(MAX_ACTION_MS, remaining()));
  const observe = async (): Promise<Observation> => {
    const o = await observer.observe(page);
    return { ...o, url: redactor.redact(o.url), title: redactor.redact(o.title), content: redactor.redact(o.content) };
  };
  const record = (r: Omit<StepRecord, "elapsed_ms" | "url">): StepRecord => {
    const full: StepRecord = { ...r, thought: redactor.redact(r.thought), outcome: redactor.redact(r.outcome), url: redactor.redact(page.url()), elapsed_ms: Date.now() - started };
    steps.push(full);
    logger.info("step", { step: full.step, action: full.action ? describeAction(full.action) : null, target: full.target, ok: full.ok, outcome: full.outcome, url: full.url });
    return full;
  };

  // Step 1 is the engine's own navigation to base_url (no LLM call). It counts toward the
  // budget so a page that errors on load is caught at step 1 like any other step.
  collector.setStep(1);
  const opening = await executeAction(
    { type: "navigate", url: spec.base_url },
    { page, baseUrl: spec.base_url, allowedHosts: input.allowedHosts, secrets: input.secrets, timeoutMs: actionTimeout(), settle },
  );
  const openingRecord = record({
    step: 1,
    thought: "",
    action: { type: "navigate", url: spec.base_url },
    target: null,
    ok: opening.kind !== "error",
    outcome: opening.kind === "ok" ? opening.note : opening.kind === "error" ? opening.message : "",
  });
  if (!openingRecord.ok && !collector.hasHardSignal()) {
    // The app didn't load at all and gave no 5xx: most likely not running or wrong URL.
    throw new EngineError(`Could not open ${spec.base_url}: ${openingRecord.outcome}`);
  }

  if (collector.hasHardSignal()) {
    stop = "hard_signal";
  } else {
    for (let step = 2; step <= maxSteps; step++) {
      if (remaining() <= 0) {
        stop = "timeout";
        break;
      }
      collector.setStep(step);
      const observation = await observe();

      let plan: PlannerOutput | null = null;
      let invalidReason = "";
      try {
        const response = await llm.complete({
          purpose: "plan",
          system: PLANNER_SYSTEM,
          user: buildPlannerPrompt({ criterion, baseUrl: spec.base_url, placeholders, step, maxSteps, history: steps.map(historyLine), observation }),
          jsonSchema: plannerJsonSchema,
          maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS,
          signal: AbortSignal.timeout(Math.max(1, remaining())),
        });
        meter.record(response.usage);
        const parsed = PlannerOutput.safeParse(parseJson(response.text));
        if (parsed.success) plan = parsed.data;
        else invalidReason = `invalid action: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`;
      } catch (err) {
        if (err instanceof SyntaxError) {
          invalidReason = "reply was not valid JSON";
        } else if (err instanceof LlmError && remaining() <= 0) {
          stop = "timeout";
          break;
        } else if (err instanceof LlmError) {
          throw new EngineError(err.message, { cause: err });
        } else {
          throw err;
        }
      }

      if (!plan) {
        invalidStreak++;
        record({ step, thought: "", action: null, target: null, ok: false, outcome: `${invalidReason}. Reply with one action matching the schema.` });
        if (invalidStreak >= MAX_INVALID_PLANS) throw new EngineError(`LLM returned ${MAX_INVALID_PLANS} invalid actions in a row`);
        continue;
      }
      invalidStreak = 0;

      const { action } = plan;
      const ref = refOf(action);
      const target = ref ? describeRef(observation.content, ref) : null;
      const actionCtx = () => ({ page, baseUrl: spec.base_url, allowedHosts: input.allowedHosts, secrets: input.secrets, timeoutMs: actionTimeout(), settle });
      let outcome = await executeAction(action, actionCtx());
      // PRD flake handling, step level: a transient failure (element detached, navigation race)
      // is retried once after a short wait before the planner hears about it.
      if (outcome.kind === "error" && outcome.transient && remaining() > 1_000) {
        logger.info("step_retry", { step, reason: redactor.redact(outcome.message) });
        await page.waitForTimeout(500);
        outcome = await executeAction(action, actionCtx());
        if (outcome.kind === "ok") outcome = { ...outcome, note: `${outcome.note} (after 1 retry)` };
      }

      if (outcome.kind === "assertion") {
        assertions.push({ step, final: action.type === "assert" && action.final, passed: outcome.passed, expected: labelRef(outcome.expected, ref, target), observed: labelRef(outcome.observed, ref, target) });
        record({ step, thought: plan.thought, action, target, ok: true, outcome: `${outcome.passed ? "PASSED" : "FAILED"}: ${outcome.observed}` });
      } else if (outcome.kind === "conclude") {
        conclusion = outcome.summary;
        record({ step, thought: plan.thought, action, target, ok: true, outcome: "concluded" });
      } else if (outcome.kind === "error") {
        record({ step, thought: plan.thought, action, target, ok: false, outcome: outcome.message });
      } else {
        record({ step, thought: plan.thought, action, target, ok: true, outcome: outcome.note });
      }

      // Order matters: hard signals first, then the DOM, then the planner's own "done".
      if (collector.hasHardSignal()) {
        stop = "hard_signal";
        break;
      }
      const last = assertions.at(-1);
      if (outcome.kind === "assertion" && last?.final && !last.passed) {
        stop = "final_assertion_failed";
        break;
      }
      if (outcome.kind === "conclude") {
        stop = "concluded";
        break;
      }
    }
  }

  const byStep = new Map(steps.map((s) => [s.step, s]));
  const decision = await judge({
    criterion,
    signals: collector.snapshot(),
    assertions,
    stop,
    stepsTaken: steps.length,
    lastUrl: redactor.redact(page.url()),
    describeStep: (n) => {
      const s = byStep.get(n);
      if (!s?.action) return null;
      return labelRef(describeAction(s.action), refOf(s.action), s.target);
    },
    askLlm: async () => {
      const observation = await observe();
      let response;
      try {
        response = await llm.complete({
          purpose: "judge",
          system: JUDGE_SYSTEM,
          user: buildJudgePrompt({ criterion, history: steps.map(historyLine), conclusion, observation }),
          jsonSchema: judgmentJsonSchema,
          maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS,
          signal: AbortSignal.timeout(Math.max(5_000, remaining())),
        });
      } catch (err) {
        if (err instanceof LlmError) throw new EngineError(err.message, { cause: err });
        throw err;
      }
      meter.record(response.usage);
      let parsed;
      try {
        parsed = LlmJudgment.safeParse(parseJson(response.text));
      } catch {
        throw new EngineError("LLM judge reply was not valid JSON");
      }
      if (!parsed.success) throw new EngineError(`LLM judge reply did not match the schema: ${parsed.error.issues[0]?.message ?? ""}`);
      return { ...parsed.data, expected: redactor.redact(parsed.data.expected), observed: redactor.redact(parsed.data.observed), reason: redactor.redact(parsed.data.reason) };
    },
  });

  logger.info("criterion_decided", { result: decision.result, decided_by: decision.decidedBy, stop, steps: steps.length });
  return { decision, stop, steps };
}

function refOf(action: Action): string | null {
  if ("ref" in action) return action.ref;
  if (action.type === "assert" && "ref" in action.assertion) return action.assertion.ref;
  return null;
}

/**
 * Human-facing text (verdict, PR comment, repair hint) names elements by what a reviewer sees
 * ('button "Confirm Booking"'), not by snapshot refs like f1e241 that mean nothing outside the run.
 * The planner's own history keeps the refs, because it needs them to act.
 */
export function labelRef(text: string, ref: string | null, target: string | null): string {
  if (!ref || !target) return text;
  return text.replace(new RegExp(`\\b${ref}\\b`, "g"), target);
}
