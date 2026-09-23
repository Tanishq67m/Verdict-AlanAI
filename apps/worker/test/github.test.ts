import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CriterionVerdict, Verdict } from "@verdict/schema";
import { COMMENT_MARKER, parsePrevious, renderComment } from "../src/github/comment.ts";
import { criteriaToRerun, mergeWithPrevious } from "../src/github/merge.ts";
import { plan, report } from "../src/github/main.ts";

const ev = { screenshot_url: null, trace_url: null, console_errors: [], failed_requests: [] };
const crit = (id: string, result: CriterionVerdict["result"], extra: Partial<CriterionVerdict> = {}): CriterionVerdict => ({
  id, result, expected: `${id} expected`, observed: `${id} observed`, failing_step: result === "pass" ? null : 7, evidence: ev,
  repair_hint: result === "pass" ? null : `fix ${id} | in the handler`, ...extra,
});
function verdict(criteria: CriterionVerdict[], status?: Verdict["status"]): Verdict {
  const count = (r: string) => criteria.filter((c) => c.result === r).length;
  return {
    run_id: "run_abc123", status: status ?? (count("fail") ? "fail" : count("error") ? "error" : count("inconclusive") ? "inconclusive" : "pass"),
    commit: "a1b2c3d4e5", summary: { passed: count("pass"), failed: count("fail"), error: count("error"), inconclusive: count("inconclusive") },
    criteria, cost: { llm_tokens: 100, usd: 0.0251 }, duration_ms: 104_800,
  };
}
const failing = verdict([crit("book-ticket", "fail"), crit("seat-count", "pass"), crit("sold-out", "pass")]);
const ids = ["book-ticket", "seat-count", "sold-out"];

describe("PR comment", () => {
  it("summarises results, escapes table cells and lists repair hints", () => {
    const body = renderComment({ verdict: failing, commit: "a1b2c3d4e5", reportUrl: "https://r", runUrl: "https://ci" });
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("### Verdict: ❌ 1 of 3 checks failed");
    expect(body).toContain("commit `a1b2c3d` · 105 s · $0.025 · [full report](https://r) · [CI run](https://ci)");
    expect(body).toContain("| `book-ticket` | ❌ fail | book-ticket observed |");
    expect(body).toContain("fix book-ticket \\| in the handler");
  });

  it("round-trips the previous run through the hidden data block", () => {
    const prev = parsePrevious(renderComment({ verdict: failing, commit: "a1b2c3d" }));
    expect(prev?.commit).toBe("a1b2c3d");
    expect(prev?.verdict.criteria.map((c) => c.result)).toEqual(["fail", "pass", "pass"]);
    expect(parsePrevious("no data here")).toBeNull();
    expect(parsePrevious("<!-- verdict:data not-base64-json -->")).toBeNull();
  });

  it("says error is not an app failure", () => {
    expect(renderComment({ verdict: verdict([crit("a", "error")]), commit: null })).toContain("not an app failure");
  });
});

describe("re-run failed criteria only", () => {
  it("picks the previous non-passing criteria", () => {
    expect(criteriaToRerun({ commit: "x", verdict: failing }, ids)).toEqual(["book-ticket"]);
  });
  it("runs everything when there is no previous run, everything passed, everything failed, or the spec changed", () => {
    expect(criteriaToRerun(null, ids)).toBeNull();
    expect(criteriaToRerun({ commit: "x", verdict: verdict(ids.map((i) => crit(i, "pass"))) }, ids)).toBeNull();
    expect(criteriaToRerun({ commit: "x", verdict: verdict(ids.map((i) => crit(i, "fail"))) }, ids)).toBeNull();
    expect(criteriaToRerun({ commit: "x", verdict: failing }, [...ids, "price-matches"])).toBeNull();
  });
  it("carries passes over, labelled, and recomputes the status", () => {
    const fresh = verdict([crit("book-ticket", "pass")]);
    const { verdict: merged, carried } = mergeWithPrevious(fresh, { commit: "a1b2c3d4", verdict: failing }, ids);
    expect(merged.criteria.map((c) => [c.id, c.result])).toEqual([["book-ticket", "pass"], ["seat-count", "pass"], ["sold-out", "pass"]]);
    expect(merged.status).toBe("pass");
    expect(merged.summary.passed).toBe(3);
    expect(carried).toEqual(["seat-count", "sold-out"]);
    expect(merged.criteria[1]!.observed).toMatch(/^\[carried over from a1b2c3d, not re-checked on this commit\]/);
  });
});

/** Fake GitHub: stores comments in memory, answers like the REST API. */
function fakeGitHub(initial: Array<{ id: number; body: string; user: { type: string } }> = []) {
  const comments = [...initial];
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.replace("https://api.github.test", "")}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (method === "GET") return json(comments);
    const body = JSON.parse(String(init?.body)) as { body: string };
    if (method === "POST") {
      comments.push({ id: comments.length + 1, body: body.body, user: { type: "Bot" } });
      return json({}, 201);
    }
    const id = Number(u.split("/").pop());
    const c = comments.find((x) => x.id === id);
    if (c) c.body = body.body;
    return json({});
  }) as typeof fetch;
  return { comments, calls, fetchImpl };
}

async function actionEnv(extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "verdict-gh-"));
  const eventPath = join(dir, "event.json");
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
  const specPath = join(dir, ".verdict.yml");
  await writeFile(specPath, `version: 1\ntask: t\nbase_url: http://localhost:3000\ncriteria:\n${ids.map((i) => `  - id: ${i}\n    check: The ${i} criterion holds on the page.`).join("\n")}\n`);
  const env: Record<string, string> = {
    GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "https://api.github.test", GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: join(dir, "out"), GITHUB_STEP_SUMMARY: join(dir, "summary"), INPUT_SPEC: specPath, VERDICT_COMMIT: "fffffff1",
    ...extra,
  };
  await writeFile(env["GITHUB_OUTPUT"]!, "");
  return { dir, env };
}

describe("action steps", () => {
  it("report: creates one comment, then updates the same comment on the next run; exit code follows fail-on", async () => {
    const gh = fakeGitHub();
    const { dir, env } = await actionEnv();
    const vPath = join(dir, "verdict.json");
    await writeFile(vPath, JSON.stringify(failing));
    expect(await report(env, vPath, () => {}, { fetchImpl: gh.fetchImpl })).toBe(1);
    await writeFile(vPath, JSON.stringify(verdict(ids.map((i) => crit(i, "pass")))));
    expect(await report(env, vPath, () => {}, { fetchImpl: gh.fetchImpl })).toBe(0);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain("✅ All 3 checks passed");
    expect(await readFile(env["GITHUB_OUTPUT"]!, "utf8")).toContain("status=pass");
  });

  it("report: inconclusive only blocks the PR when fail-on includes it", async () => {
    const gh = fakeGitHub();
    const { dir, env } = await actionEnv();
    const vPath = join(dir, "verdict.json");
    await writeFile(vPath, JSON.stringify(verdict([crit("book-ticket", "inconclusive")])));
    expect(await report(env, vPath, () => {}, { fetchImpl: gh.fetchImpl })).toBe(0);
    expect(await report({ ...env, INPUT_FAIL_ON: "fail,inconclusive" }, vPath, () => {}, { fetchImpl: gh.fetchImpl })).toBe(1);
  });

  it("report: a missing verdict is reported as 'could not run', never as an app failure", async () => {
    const gh = fakeGitHub();
    const { dir, env } = await actionEnv();
    expect(await report(env, join(dir, "missing.json"), () => {}, { fetchImpl: gh.fetchImpl })).toBe(1);
    expect(gh.comments[0]!.body).toContain("could not run");
  });

  it("plan + report with only-failed: re-checks the failure and carries the passes", async () => {
    const gh = fakeGitHub([{ id: 1, body: renderComment({ verdict: failing, commit: "a1b2c3d4" }), user: { type: "Bot" } }]);
    const { dir, env } = await actionEnv({ INPUT_ONLY_FAILED: "true" });
    expect(await plan(env, () => {}, { fetchImpl: gh.fetchImpl })).toEqual(["book-ticket"]);
    expect(await readFile(env["GITHUB_OUTPUT"]!, "utf8")).toContain("criteria=--criterion book-ticket");

    const vPath = join(dir, "verdict.json");
    await writeFile(vPath, JSON.stringify(verdict([crit("book-ticket", "pass")])));
    expect(await report({ ...env, VERDICT_SPEC_IDS: ids.join(",") }, vPath, () => {}, { fetchImpl: gh.fetchImpl })).toBe(0);
    expect(gh.comments[0]!.body).toContain("✅ All 3 checks passed");
    expect(gh.comments[0]!.body).toContain("_(carried over)_");
  });

  it("ignores look-alike comments that weren't written by a bot", async () => {
    const forged = renderComment({ verdict: failing, commit: "a1b2c3d4" });
    const gh = fakeGitHub([{ id: 1, body: forged, user: { type: "User" } }]);
    const { env } = await actionEnv({ INPUT_ONLY_FAILED: "true" });
    expect(await plan(env, () => {}, { fetchImpl: gh.fetchImpl })).toEqual([]); // no trusted previous run → check everything
  });
});

describe("could-not-run diagnostics", () => {
  it("includes the CLI's reason (non-JSON stderr lines) in the comment", async () => {
    const gh = fakeGitHub();
    const { dir, env } = await actionEnv();
    const logPath = join(dir, "verdict.log");
    await writeFile(logPath, `$ tsx apps/worker/src/cli.ts run\n{"level":"info","event":"x"}\nGEMINI_API_KEY is not set. Add it to .env (see .env.example).\n`);
    expect(await report({ ...env, VERDICT_LOG: logPath }, join(dir, "missing.json"), () => {}, { fetchImpl: gh.fetchImpl })).toBe(1);
    expect(gh.comments[0]!.body).toContain("GEMINI_API_KEY is not set");
    expect(gh.comments[0]!.body).not.toContain('"level"');
  });
});
