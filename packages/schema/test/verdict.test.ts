import { describe, expect, it } from "vitest";
import { aggregateStatus, summarize, VerdictV1Schema, type CriterionVerdict, type Result } from "../src/index.ts";

const evidence = { screenshot_url: null, trace_url: null, console_errors: [], failed_requests: [] };
const passed = (id: string): CriterionVerdict => ({
  id,
  result: "pass",
  expected: "x",
  observed: "x",
  failing_step: null,
  evidence,
  repair_hint: null,
});

// The PRD's example verdict. The PRD lists only the failing criterion while its summary says
// 2 passed + 1 failed; we require the criteria array to be complete, so the two passes are added.
const PRD_VERDICT = {
  run_id: "run_8f2c",
  status: "fail",
  commit: "a1b2c3d",
  summary: { passed: 2, failed: 1, error: 0, inconclusive: 0 },
  criteria: [
    passed("book-ticket"),
    passed("sold-out"),
    {
      id: "seat-count",
      result: "fail",
      expected: "Remaining seats drop from 40 to 39",
      observed: "Remaining seats still show 40 after confirmation",
      failing_step: 6,
      evidence: {
        screenshot_url: "https://.../run_8f2c/seat-count-step6.png",
        trace_url: "https://.../run_8f2c/trace.zip",
        console_errors: [],
        failed_requests: [],
      },
      repair_hint: "Booking succeeded (201) but the event page shows a stale count.",
    },
  ],
  cost: { llm_tokens: 18430, usd: 0.031 },
  duration_ms: 97400,
};

describe("verdict v1", () => {
  it("accepts the PRD example (with its passing criteria included)", () => {
    expect(VerdictV1Schema.safeParse(PRD_VERDICT).success).toBe(true);
  });

  it("rejects a summary that disagrees with the criteria", () => {
    const bad = { ...PRD_VERDICT, summary: { passed: 3, failed: 0, error: 0, inconclusive: 0 } };
    const r = VerdictV1Schema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("summary.passed is 3 but criteria contain 2");
  });

  it("rejects a status that disagrees with the criteria", () => {
    expect(VerdictV1Schema.safeParse({ ...PRD_VERDICT, status: "pass" }).success).toBe(false);
  });

  it("rejects unknown result values and unknown keys", () => {
    const badResult = { ...PRD_VERDICT, criteria: [{ ...passed("a"), result: "passed" }] };
    expect(VerdictV1Schema.safeParse(badResult).success).toBe(false);
    expect(VerdictV1Schema.safeParse({ ...PRD_VERDICT, extra: true }).success).toBe(false);
  });

  it("accepts failed requests with and without an HTTP status", () => {
    const v = {
      ...PRD_VERDICT,
      criteria: PRD_VERDICT.criteria.map((c) =>
        c.id === "seat-count"
          ? {
              ...c,
              evidence: {
                ...c.evidence,
                failed_requests: [
                  { method: "POST", url: "https://api/x", status: 500, failure: null },
                  { method: "GET", url: "https://api/y", status: null, failure: "net::ERR_CONNECTION_REFUSED" },
                ],
              },
            }
          : c,
      ),
    };
    expect(VerdictV1Schema.safeParse(v).success).toBe(true);
  });
});

describe("aggregateStatus (PLAN.md C-7: fail > error > inconclusive > pass)", () => {
  it.each<[Result[], Result]>([
    [["pass", "pass"], "pass"],
    [["pass", "inconclusive"], "inconclusive"],
    [["inconclusive", "error"], "error"],
    [["error", "fail", "pass"], "fail"],
  ])("%j -> %s", (results, expected) => {
    expect(aggregateStatus(results)).toBe(expected);
  });

  it("summarize counts each result", () => {
    expect(summarize(["pass", "fail", "fail", "error", "inconclusive"])).toEqual({ passed: 1, failed: 2, error: 1, inconclusive: 1 });
  });
});
