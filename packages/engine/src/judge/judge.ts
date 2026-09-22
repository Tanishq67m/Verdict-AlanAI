import type { CriterionSpec, Result } from "@verdict/schema";
import type { LlmJudgment } from "../actions/schema.ts";
import type { Signals } from "../signals/collector.ts";

export interface AssertionRecord {
  step: number;
  final: boolean;
  passed: boolean;
  expected: string;
  observed: string;
}

/** Why the observe–act loop stopped. */
export type StopReason = "concluded" | "final_assertion_failed" | "hard_signal" | "step_budget" | "timeout";

/** Which signal decided the result, in the PRD's order of trust. */
export type DecidedBy = "network" | "console" | "dom" | "step_budget" | "timeout" | "llm";

export interface Decision {
  result: Result;
  decidedBy: DecidedBy;
  expected: string;
  observed: string;
  failingStep: number | null;
  repairHint: string | null;
}

export interface JudgeInput {
  criterion: CriterionSpec;
  signals: Signals;
  assertions: readonly AssertionRecord[];
  stop: StopReason;
  stepsTaken: number;
  lastUrl: string;
  /** Describes the action taken at a step, for repair hints ("after click e12 (button "Book")"). */
  describeStep: (step: number) => string | null;
  /** Only invoked when every deterministic signal is silent. */
  askLlm: () => Promise<LlmJudgment>;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? "?…" : "");
  } catch {
    return url;
  }
}

function after(step: number, describe: JudgeInput["describeStep"]): string {
  const d = describe(step);
  return d ? `at step ${step} (${d})` : `at step ${step}`;
}

/**
 * Hybrid judging (PRD → "Hybrid judging, in order of trust"), highest trust first:
 *   1. network  – a 5xx / failed request to the app            → fail
 *   2. console  – an uncaught exception / app console.error    → fail
 *   3. DOM      – final assertions: any failed → fail, all passed → pass
 *   4. budget   – no decision within the step budget / timeout → inconclusive
 *   5. LLM      – only when all of the above are silent
 * The order is the whole point: a hard fact is never overruled by, or even shown to, the LLM.
 */
export async function judge(input: JudgeInput): Promise<Decision> {
  const { signals, describeStep } = input;

  const request = signals.failedRequests[0];
  if (request) {
    const what = request.status !== null ? `HTTP ${request.status}` : request.failure ?? "no response";
    return {
      result: "fail",
      decidedBy: "network",
      expected: "No failed requests to the app while exercising the criterion",
      observed: `${request.method} ${request.url} → ${what} ${after(request.step, describeStep)}`,
      failingStep: Math.max(1, request.step),
      repairHint:
        request.status !== null
          ? `${request.method} ${pathOf(request.url)} returned ${request.status}. Look at the server handler for ${pathOf(request.url)} and its logs for this request.`
          : `${request.method} ${pathOf(request.url)} got no response (${request.failure}). Check that the API is running and reachable from the frontend (URL config, CORS).`,
    };
  }

  const consoleError = signals.consoleErrors[0];
  if (consoleError) {
    return {
      result: "fail",
      decidedBy: "console",
      expected: "No uncaught errors or console errors from the app",
      observed: `${consoleError.text} ${after(consoleError.step, describeStep)}`,
      failingStep: Math.max(1, consoleError.step),
      repairHint: `The page logged "${consoleError.text.slice(0, 160)}" ${after(consoleError.step, describeStep)}. Find the component or handler behind that action and the code path that throws.`,
    };
  }

  const finals = input.assertions.filter((a) => a.final);
  const failed = finals.find((a) => !a.passed);
  if (failed) {
    return {
      result: "fail",
      decidedBy: "dom",
      expected: failed.expected,
      observed: failed.observed,
      failingStep: failed.step,
      repairHint: `Expected ${failed.expected}, but ${failed.observed} (step ${failed.step}). Check the UI state and the data that should produce it after the preceding actions.`,
    };
  }
  if (finals.length > 0) {
    return {
      result: "pass",
      decidedBy: "dom",
      expected: finals.map((a) => a.expected).join("; "),
      observed: finals.map((a) => a.observed).join("; "),
      failingStep: null,
      repairHint: null,
    };
  }

  if (input.stop === "step_budget" || input.stop === "timeout") {
    const why = input.stop === "timeout" ? "the run timeout" : `the ${input.stepsTaken}-step budget`;
    return {
      result: "inconclusive",
      decidedBy: input.stop,
      expected: input.criterion.check,
      observed: `No decision within ${why}; last URL ${input.lastUrl}`,
      failingStep: input.stepsTaken > 0 ? input.stepsTaken : null,
      repairHint: `Verdict could not reach the criterion's end state within ${why}. If the app is looping (e.g. a redirect loop on login) or a required control never appears, that is likely the bug; otherwise make the criterion more specific.`,
    };
  }

  const j = await input.askLlm();
  return {
    result: j.result,
    decidedBy: "llm",
    expected: j.expected,
    observed: j.observed,
    failingStep: j.result === "pass" ? null : input.stepsTaken,
    repairHint: j.result === "pass" ? null : j.reason,
  };
}
