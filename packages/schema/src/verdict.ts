import { z } from "zod";

/**
 * pass         – the app does what the criterion says.
 * fail         – the app is wrong (a hard signal, a DOM assertion or the LLM judge said so).
 * error        – Verdict or its infrastructure broke. NOT the app's fault; never "fix" code for this.
 * inconclusive – no decision within the step budget or timeout.
 */
export const RESULT_VALUES = ["pass", "fail", "error", "inconclusive"] as const;
export const ResultSchema = z.enum(RESULT_VALUES);
export type Result = z.output<typeof ResultSchema>;

export const FailedRequestSchema = z.strictObject({
  method: z.string(),
  url: z.string(),
  /** HTTP status, or null when the request never got a response (DNS, reset, CORS). */
  status: z.int().nullable(),
  /** Browser failure text for requests with no response, e.g. `net::ERR_CONNECTION_REFUSED`. */
  failure: z.string().nullable(),
});

export const EvidenceSchema = z.strictObject({
  /** file:// URL in M1 (local artifacts dir); signed https URL once artifacts are uploaded (M2). */
  screenshot_url: z.string().nullable(),
  trace_url: z.string().nullable(),
  console_errors: z.array(z.string()),
  failed_requests: z.array(FailedRequestSchema),
});

export const CriterionVerdictSchema = z.strictObject({
  id: z.string().min(1),
  result: ResultSchema,
  expected: z.string(),
  observed: z.string(),
  /** 1-based step at which the decision was made; null when nothing failed. */
  failing_step: z.int().min(1).nullable(),
  evidence: EvidenceSchema,
  repair_hint: z.string().nullable(),
});

export const SummarySchema = z.strictObject({
  passed: z.int().min(0),
  failed: z.int().min(0),
  error: z.int().min(0),
  inconclusive: z.int().min(0),
});

export const CostSchema = z.strictObject({
  llm_tokens: z.int().min(0),
  usd: z.number().min(0),
});

export const VerdictV1Schema = z
  .strictObject({
    run_id: z.string().regex(/^run_[a-z0-9]+$/),
    status: ResultSchema,
    commit: z.string().nullable(),
    summary: SummarySchema,
    criteria: z.array(CriterionVerdictSchema).min(1),
    cost: CostSchema,
    duration_ms: z.int().min(0),
  })
  .superRefine((v, ctx) => {
    // The summary and status are derived data; if they disagree with the criteria, a consumer
    // (PR comment, agent) would act on the wrong number. Reject instead of trusting either.
    const expectedSummary = summarize(v.criteria.map((c) => c.result));
    for (const key of Object.keys(expectedSummary) as Array<keyof Summary>) {
      if (v.summary[key] !== expectedSummary[key]) {
        ctx.addIssue({
          code: "custom",
          path: ["summary", key],
          message: `summary.${key} is ${v.summary[key]} but criteria contain ${expectedSummary[key]}`,
        });
      }
    }
    const expectedStatus = aggregateStatus(v.criteria.map((c) => c.result));
    if (v.status !== expectedStatus) {
      ctx.addIssue({ code: "custom", path: ["status"], message: `status is "${v.status}" but criteria aggregate to "${expectedStatus}"` });
    }
  });

export type FailedRequest = z.output<typeof FailedRequestSchema>;
export type Evidence = z.output<typeof EvidenceSchema>;
export type CriterionVerdict = z.output<typeof CriterionVerdictSchema>;
export type Summary = z.output<typeof SummarySchema>;
export type Verdict = z.output<typeof VerdictV1Schema>;

export function summarize(results: readonly Result[]): Summary {
  const s: Summary = { passed: 0, failed: 0, error: 0, inconclusive: 0 };
  for (const r of results) {
    if (r === "pass") s.passed++;
    else if (r === "fail") s.failed++;
    else if (r === "error") s.error++;
    else s.inconclusive++;
  }
  return s;
}

/**
 * Run-level status (PLAN.md C-7): fail > error > inconclusive > pass.
 * A real app failure is the most actionable signal for an agent, so it wins even if
 * another criterion errored.
 */
export function aggregateStatus(results: readonly Result[]): Result {
  if (results.includes("fail")) return "fail";
  if (results.includes("error")) return "error";
  if (results.includes("inconclusive")) return "inconclusive";
  return "pass";
}
