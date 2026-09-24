/**
 * Seeded-bug benchmark summary. Reads raw runs laid out as
 *   <resultsDir>/<case>/run<N>.json   verdict JSON (Verdict's stdout)
 *   <resultsDir>/<case>/run<N>.log    JSON-lines log (Verdict's stderr), for "decided by"
 * where <case> is "clean" or a bug id from bench/bugs.json, and computes the numbers the
 * README quotes. Nothing is estimated: a run without a verdict counts as `error`.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { VerdictV1Schema, type Result, type Verdict } from "../../packages/schema/src/index.ts";

export interface BugSpec {
  id: string;
  title: string;
  criterion: string;
  expected_signal: string;
}

export interface RunRecord {
  caseId: string;
  run: number;
  verdict: Verdict | null;
  /** criterion id → how attempt 1 was decided (network, console, redirect_loop, dom, llm, ...) */
  decidedBy: Record<string, string>;
  problem: string | null;
}

export interface BugResult extends BugSpec {
  results: Result[];
  detected: number;
  caught: boolean;
  decided_by: string[];
}

export interface BenchSummary {
  catch_rate: { caught: number; total: number; pct: number };
  bugs: BugResult[];
  clean: {
    runs: number;
    run_statuses: Result[];
    results: Record<Result, number>;
    runs_with_false_fail: number;
    false_fail_rate_runs_pct: number;
    false_fail_rate_results_pct: number;
    latency_ms: { p50: number | null; p95: number | null };
    mean_cost_usd: number | null;
  };
  stability: { groups: number; identical: number; pct: number };
  bug_runs_latency_ms: { p50: number | null; p95: number | null };
  problems: string[];
}

const RESULTS: Result[] = ["pass", "fail", "error", "inconclusive"];

export async function loadRuns(dir: string): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  for (const caseId of (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const files = await readdir(join(dir, caseId));
    const runs = [...new Set(files.map((f) => /^run(\d+)\.(json|log)$/.exec(f)?.[1]).filter((n): n is string => n !== undefined))]
      .map(Number)
      .sort((a, b) => a - b);
    for (const run of runs) {
      const base = join(dir, caseId, `run${run}`);
      const raw = await readFile(`${base}.json`, "utf8").catch(() => "");
      const log = await readFile(`${base}.log`, "utf8").catch(() => "");
      out.push({ caseId, run, ...parseVerdict(raw), decidedBy: decidedByFromLog(log) });
    }
  }
  return out;
}

export function parseVerdict(raw: string): { verdict: Verdict | null; problem: string | null } {
  if (!raw.trim()) return { verdict: null, problem: "no verdict produced" };
  try {
    const parsed = VerdictV1Schema.safeParse(JSON.parse(raw));
    return parsed.success ? { verdict: parsed.data, problem: null } : { verdict: null, problem: "verdict did not match schema v1" };
  } catch {
    return { verdict: null, problem: "verdict was not JSON" };
  }
}

export function decidedByFromLog(log: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of log.split("\n")) {
    if (!line.includes('"criterion_decided"')) continue;
    try {
      const e = JSON.parse(line) as { event?: string; criterion_id?: string; attempt?: number; decided_by?: string };
      if (e.event === "criterion_decided" && e.criterion_id && e.decided_by && (e.attempt ?? 1) === 1) out[e.criterion_id] = e.decided_by;
    } catch {
      // not a JSON line (e.g. a stack trace); ignore
    }
  }
  return out;
}

/** Result of one criterion in one run; a missing verdict or criterion counts as `error`. */
export function resultOf(r: RunRecord, criterion: string): Result {
  return r.verdict?.criteria.find((c) => c.id === criterion)?.result ?? "error";
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((1000 * n) / d) / 10);
const allSame = (xs: Result[]) => xs.length > 0 && xs.every((x) => x === xs[0]);

export function summarizeBench(runs: RunRecord[], bugs: BugSpec[]): BenchSummary {
  const problems = runs.filter((r) => r.problem).map((r) => `${r.caseId} run ${r.run}: ${r.problem}`);

  const bugResults: BugResult[] = bugs.map((b) => {
    const mine = runs.filter((r) => r.caseId === b.id);
    const results = mine.map((r) => resultOf(r, b.criterion));
    const detected = results.filter((x) => x === "fail").length;
    return {
      ...b,
      results,
      detected,
      // PRD: a bug counts as caught when it is detected in at least 2 of its 3 runs.
      caught: mine.length > 0 && detected >= Math.min(2, mine.length),
      decided_by: mine.map((r) => r.decidedBy[b.criterion] ?? "-"),
    };
  });
  const caught = bugResults.filter((b) => b.caught).length;

  const clean = runs.filter((r) => r.caseId === "clean");
  const criteria = [...new Set(clean.flatMap((r) => r.verdict?.criteria.map((c) => c.id) ?? []))].sort();
  const cleanResults = Object.fromEntries(RESULTS.map((x) => [x, 0])) as Record<Result, number>;
  for (const r of clean) for (const c of criteria) cleanResults[resultOf(r, c)] += 1;
  const totalCleanResults = criteria.length * clean.length;
  const runsWithFalseFail = clean.filter((r) => criteria.some((c) => resultOf(r, c) === "fail")).length;

  // Stability: the same build, re-run, gives the same result. Groups are each clean criterion
  // across the clean runs, and each bug's target criterion across that bug's runs.
  const groups: Result[][] = [...criteria.map((c) => clean.map((r) => resultOf(r, c))), ...bugResults.map((b) => b.results)].filter((g) => g.length > 1);
  const identical = groups.filter(allSame).length;

  const cleanDurations = clean.flatMap((r) => (r.verdict ? [r.verdict.duration_ms] : []));
  const costs = clean.flatMap((r) => (r.verdict ? [r.verdict.cost.usd] : []));
  const bugDurations = runs.filter((r) => r.caseId !== "clean").flatMap((r) => (r.verdict ? [r.verdict.duration_ms] : []));

  return {
    catch_rate: { caught, total: bugs.length, pct: pct(caught, bugs.length) },
    bugs: bugResults,
    clean: {
      runs: clean.length,
      run_statuses: clean.map((r) => r.verdict?.status ?? "error"),
      results: cleanResults,
      runs_with_false_fail: runsWithFalseFail,
      false_fail_rate_runs_pct: pct(runsWithFalseFail, clean.length),
      false_fail_rate_results_pct: pct(cleanResults.fail, totalCleanResults),
      latency_ms: { p50: percentile(cleanDurations, 50), p95: percentile(cleanDurations, 95) },
      mean_cost_usd: costs.length ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 10_000) / 10_000 : null,
    },
    stability: { groups: groups.length, identical, pct: pct(identical, groups.length) },
    bug_runs_latency_ms: { p50: percentile(bugDurations, 50), p95: percentile(bugDurations, 95) },
    problems,
  };
}

const ICON: Record<Result, string> = { pass: "✅", fail: "❌", error: "⚠️", inconclusive: "❔" };
const secs = (ms: number | null) => (ms === null ? "n/a" : `${Math.round(ms / 1000)} s`);

export function renderMarkdown(s: BenchSummary): string {
  const c = s.clean;
  const lines = [
    "## Verdict seeded-bug benchmark",
    "",
    "| Metric | Result | Target |",
    "|---|---|---|",
    `| Catch rate | **${s.catch_rate.caught}/${s.catch_rate.total} bugs (${s.catch_rate.pct}%)** | ≥ 80% |`,
    `| False-fail rate, clean build | **${c.runs_with_false_fail}/${c.runs} runs (${c.false_fail_rate_runs_pct}%)**; ${c.results.fail}/${c.results.pass + c.results.fail + c.results.error + c.results.inconclusive} results | ≤ 10% |`,
    `| Stability (same build, same result) | **${s.stability.identical}/${s.stability.groups} (${s.stability.pct}%)** | ≥ 90% |`,
    `| Latency, full clean run | p50 ${secs(c.latency_ms.p50)} · p95 ${secs(c.latency_ms.p95)} | p95 ≤ 180 s |`,
    `| Cost per clean run | ${c.mean_cost_usd === null ? "n/a" : `$${c.mean_cost_usd}`} | ≤ $0.05 |`,
    "",
    "| Bug | What breaks | Checked by | Runs | Caught | Decided by |",
    "|---|---|---|---|---|---|",
    ...s.bugs.map((b) => `| ${b.id} | ${b.title} | \`${b.criterion}\` | ${b.results.map((r) => ICON[r]).join(" ")} | ${b.caught ? "yes" : "**no**"} (${b.detected}/${b.results.length}) | ${b.decided_by.join(", ")} |`),
    "",
    `Clean build: ${c.runs} runs, criterion results ${RESULTS.map((r) => `${c.results[r]} ${r}`).join(", ")}; run statuses ${c.run_statuses.map((r) => ICON[r]).join(" ")}.`,
    `Bug runs (target criterion only): p50 ${secs(s.bug_runs_latency_ms.p50)} · p95 ${secs(s.bug_runs_latency_ms.p95)}.`,
  ];
  if (s.problems.length) lines.push("", "Runs without a verdict (counted as `error`):", ...s.problems.map((p) => `- ${p}`));
  return `${lines.join("\n")}\n`;
}
