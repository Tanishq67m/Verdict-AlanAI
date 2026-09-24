import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateStatus, summarize, type Result } from "../../packages/schema/src/index.ts";
import { decidedByFromLog, loadRuns, percentile, renderMarkdown, summarizeBench, type BugSpec } from "../src/summarize.ts";

const bugs: BugSpec[] = [
  { id: "B1", title: "Book button throws", criterion: "book-ticket", expected_signal: "console" },
  { id: "B2", title: "Seat count stuck", criterion: "seat-count", expected_signal: "dom" },
];

function verdict(results: Record<string, Result>, durationMs = 100_000, usd = 0.03): string {
  const criteria = Object.entries(results).map(([id, result]) => ({
    id,
    result,
    expected: "x",
    observed: "y",
    failing_step: result === "fail" ? 3 : null,
    evidence: { screenshot_url: null, trace_url: null, console_errors: [], failed_requests: [] },
    repair_hint: null,
  }));
  const list = criteria.map((c) => c.result);
  return JSON.stringify({ run_id: "run_abc123", status: aggregateStatus(list), commit: null, summary: summarize(list), criteria, cost: { llm_tokens: 1, usd }, duration_ms: durationMs });
}

const decided = (id: string, by: string, attempt = 1) => JSON.stringify({ event: "criterion_decided", criterion_id: id, attempt, decided_by: by });

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

describe("benchmark summary", () => {
  it("counts a bug as caught when it fails in at least 2 of 3 runs", async () => {
    const dir = await fixture({
      "B1/run1.json": verdict({ "book-ticket": "fail" }),
      "B1/run1.log": `${decided("book-ticket", "console")}\n${decided("book-ticket", "console", 2)}\n`,
      "B1/run2.json": verdict({ "book-ticket": "fail" }),
      "B1/run3.json": verdict({ "book-ticket": "inconclusive" }),
      "B2/run1.json": verdict({ "seat-count": "fail" }),
      "B2/run2.json": verdict({ "seat-count": "pass" }),
      "B2/run3.json": verdict({ "seat-count": "pass" }),
    });
    const s = summarizeBench(await loadRuns(dir), bugs);
    expect(s.bugs.map((b) => [b.id, b.detected, b.caught])).toEqual([
      ["B1", 2, true],
      ["B2", 1, false],
    ]);
    expect(s.catch_rate).toEqual({ caught: 1, total: 2, pct: 50 });
    expect(s.bugs[0]?.decided_by).toEqual(["console", "-", "-"]);
  });

  it("measures false fails, stability, latency and cost on the clean build", async () => {
    const dir = await fixture({
      "clean/run1.json": verdict({ a: "pass", b: "pass" }, 100_000, 0.02),
      "clean/run2.json": verdict({ a: "pass", b: "fail" }, 120_000, 0.04),
      "clean/run3.json": verdict({ a: "pass", b: "pass" }, 140_000, 0.03),
    });
    const s = summarizeBench(await loadRuns(dir), []);
    expect(s.clean.runs).toBe(3);
    expect(s.clean.runs_with_false_fail).toBe(1);
    expect(s.clean.false_fail_rate_runs_pct).toBe(33.3);
    expect(s.clean.false_fail_rate_results_pct).toBe(16.7);
    expect(s.stability).toEqual({ groups: 2, identical: 1, pct: 50 });
    expect(s.clean.latency_ms).toEqual({ p50: 120_000, p95: 140_000 });
    expect(s.clean.mean_cost_usd).toBe(0.03);
  });

  it("counts a run without a verdict as error, never as pass or fail", async () => {
    const dir = await fixture({ "B1/run1.log": "boom\n", "B1/run2.json": "not json" });
    const s = summarizeBench(await loadRuns(dir), bugs);
    expect(s.bugs[0]?.results).toEqual(["error", "error"]);
    expect(s.bugs[0]?.caught).toBe(false);
    expect(s.problems).toEqual(["B1 run 1: no verdict produced", "B1 run 2: verdict was not JSON"]);
  });

  it("uses nearest-rank percentiles and ignores non-JSON log lines", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    expect(decidedByFromLog(`garbage\n${decided("x", "dom")}\n`)).toEqual({ x: "dom" });
  });

  it("renders a table with every bug", async () => {
    const dir = await fixture({ "B1/run1.json": verdict({ "book-ticket": "fail" }), "clean/run1.json": verdict({ a: "pass" }) });
    const md = renderMarkdown(summarizeBench(await loadRuns(dir), bugs));
    expect(md).toContain("| B1 | Book button throws | `book-ticket` | ❌ |");
    expect(md).toContain("| B2 |");
    expect(md).toContain("Catch rate");
  });
});
