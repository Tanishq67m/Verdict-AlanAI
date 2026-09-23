import { appendFile, readFile } from "node:fs/promises";
import { loadSpecFile } from "@verdict/schema";
import { VerdictV1Schema, type Result, type Verdict } from "@verdict/schema";
import { GitHubClient } from "./api.ts";
import { COMMENT_MARKER, parsePrevious, renderComment } from "./comment.ts";
import { criteriaToRerun, mergeWithPrevious, type PreviousRun } from "./merge.ts";

/**
 * Entry point for the GitHub Action (action/action.yml). Two steps around `verdict run`:
 *   plan   → decide which criteria to run (all, or only last run's failures)
 *   report → merge carried-over results, update the single PR comment, write the job
 *            summary, and exit non-zero when the result is in `fail-on`.
 */

type Env = Record<string, string | undefined>;

async function setOutput(env: Env, name: string, value: string): Promise<void> {
  if (env["GITHUB_OUTPUT"]) await appendFile(env["GITHUB_OUTPUT"], `${name}=${value}\n`);
}

async function pullRequestNumber(env: Env): Promise<number | null> {
  const path = env["GITHUB_EVENT_PATH"];
  if (!path) return null;
  try {
    const event = JSON.parse(await readFile(path, "utf8")) as { pull_request?: { number?: number }; number?: number };
    return event.pull_request?.number ?? null;
  } catch {
    return null;
  }
}

export interface Deps {
  fetchImpl?: typeof fetch;
}

function client(env: Env, deps: Deps = {}): GitHubClient | null {
  const token = env["INPUT_GITHUB_TOKEN"] || env["GITHUB_TOKEN"];
  const repo = env["GITHUB_REPOSITORY"];
  if (!token || !repo) return null;
  return new GitHubClient(token, repo, env["GITHUB_API_URL"] || "https://api.github.com", deps.fetchImpl ?? fetch);
}

async function previousRun(env: Env, gh: GitHubClient | null, pr: number | null): Promise<PreviousRun | null> {
  if (!gh || pr === null) return null;
  const existing = await gh.findComment(pr, COMMENT_MARKER);
  return existing ? parsePrevious(existing.body) : null;
}

export async function plan(env: Env, log: (s: string) => void, deps: Deps = {}): Promise<string[]> {
  const specPath = env["INPUT_SPEC"] || ".verdict.yml";
  const spec = await loadSpecFile(specPath, { env, baseUrl: env["INPUT_URL"] || "http://localhost" });
  const ids = spec.criteria.map((c) => c.id);
  let selected: string[] = [];
  if ((env["INPUT_ONLY_FAILED"] ?? "false") === "true") {
    const pr = await pullRequestNumber(env);
    const prev = await previousRun(env, client(env, deps), pr);
    const rerun = criteriaToRerun(prev, ids);
    if (rerun) {
      selected = rerun;
      log(`Re-checking only the criteria that didn't pass on ${prev?.commit?.slice(0, 7) ?? "the previous run"}: ${rerun.join(", ")}`);
    }
  }
  if (!selected.length) log(`Checking all criteria: ${ids.join(", ")}`);
  await setOutput(env, "criteria", selected.map((id) => `--criterion ${id}`).join(" "));
  return selected;
}

export async function report(env: Env, verdictPath: string, log: (s: string) => void, deps: Deps = {}): Promise<number> {
  const failOn = new Set((env["INPUT_FAIL_ON"] || "fail").split(",").map((s) => s.trim()) as Result[]);
  const commit = env["VERDICT_COMMIT"] || env["GITHUB_SHA"] || null;
  const runUrl = env["GITHUB_SERVER_URL"] && env["GITHUB_REPOSITORY"] && env["GITHUB_RUN_ID"] ? `${env["GITHUB_SERVER_URL"]}/${env["GITHUB_REPOSITORY"]}/actions/runs/${env["GITHUB_RUN_ID"]}` : null;
  const reportUrl = env["VERDICT_REPORT_URL"] || null;
  const gh = client(env, deps);
  const pr = await pullRequestNumber(env);

  let verdict: Verdict;
  try {
    verdict = VerdictV1Schema.parse(JSON.parse(await readFile(verdictPath, "utf8")));
  } catch {
    // Show the reason (config errors are one-line messages; the CLI already redacts secrets).
    let reason = "";
    if (env["VERDICT_LOG"]) {
      const lines = (await readFile(env["VERDICT_LOG"], "utf8").catch(() => "")).split("\n").filter((l) => l.trim() && !l.startsWith("$ "));
      const tail = lines.filter((l) => !l.startsWith("{")).slice(-5);
      if (tail.length) reason = `\n\n\`\`\`\n${tail.join("\n").slice(0, 1500)}\n\`\`\``;
    }
    log(`Verdict produced no verdict.${reason ? ` Reason:${reason}` : ""}`);
    const body = `${COMMENT_MARKER}\n### Verdict: ⚠️ could not run\nVerdict didn't produce a verdict (configuration or setup problem, not an app failure). See the ${runUrl ? `[CI run](${runUrl})` : "CI log"}.${reason}`;
    if (gh && pr !== null) await gh.upsertComment(pr, COMMENT_MARKER, body);
    if (env["GITHUB_STEP_SUMMARY"]) await appendFile(env["GITHUB_STEP_SUMMARY"], `${body}\n`);
    await setOutput(env, "status", "error");
    return 1;
  }

  let carried: string[] = [];
  if ((env["INPUT_ONLY_FAILED"] ?? "false") === "true") {
    const prev = await previousRun(env, gh, pr);
    const specIds = env["VERDICT_SPEC_IDS"]?.split(",").filter(Boolean) ?? [];
    if (prev && specIds.length > verdict.criteria.length) ({ verdict, carried } = mergeWithPrevious(verdict, prev, specIds));
  }

  const body = renderComment({ verdict, commit, reportUrl, runUrl, carried });
  if (gh && pr !== null) log(`PR comment ${await gh.upsertComment(pr, COMMENT_MARKER, body)}`);
  if (env["GITHUB_STEP_SUMMARY"]) await appendFile(env["GITHUB_STEP_SUMMARY"], `${body}\n`);
  await setOutput(env, "status", verdict.status);
  log(`Verdict: ${verdict.status} (${verdict.summary.passed} passed, ${verdict.summary.failed} failed, ${verdict.summary.error} error, ${verdict.summary.inconclusive} inconclusive)`);
  return failOn.has(verdict.status) ? 1 : 0;
}

export async function specIds(env: Env): Promise<string[]> {
  const spec = await loadSpecFile(env["INPUT_SPEC"] || ".verdict.yml", { env, baseUrl: env["INPUT_URL"] || "http://localhost" });
  return spec.criteria.map((c) => c.id);
}

const isMain = process.argv[1]?.endsWith("github/main.ts");
if (isMain) {
  const [cmd, arg] = process.argv.slice(2);
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const env = process.env as Env;
  const run = async (): Promise<number> => {
    if (cmd === "plan") {
      await plan(env, log);
      await setOutput(env, "spec_ids", (await specIds(env)).join(","));
      return 0;
    }
    if (cmd === "report" && arg) return report(env, arg, log);
    process.stderr.write("usage: main.ts plan | report <verdict.json>\n");
    return 64;
  };
  run().then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      process.stderr.write(`Verdict action step failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
