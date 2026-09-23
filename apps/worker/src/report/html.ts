import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptRecord } from "@verdict/engine";
import type { CriterionVerdict, Result, Verdict } from "@verdict/schema";

/**
 * A single self-contained HTML file per run: every criterion, every attempt, every step, and
 * the decision-step screenshot embedded as a data URI. No external assets, so it opens from a
 * CI artifact zip, an email attachment or a local folder exactly the same.
 */

const LABEL: Record<Result, string> = { pass: "pass", fail: "fail", error: "error", inconclusive: "inconclusive" };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function screenshotFor(artifactsPath: string, criterionId: string, attempt: number): Promise<string | null> {
  const prefix = `${criterionId}-attempt${attempt}-step`;
  const file = (await readdir(artifactsPath)).find((f) => f.startsWith(prefix) && f.endsWith(".png"));
  if (!file) return null;
  const data = await readFile(join(artifactsPath, file));
  return `data:image/png;base64,${data.toString("base64")}`;
}

function describe(step: AttemptRecord["steps"][number]): string {
  const a = step.action;
  if (!a) return "(invalid action from the planner)";
  switch (a.type) {
    case "navigate":
      return `navigate to ${a.url}`;
    case "click":
      return `click ${step.target ?? a.ref}`;
    case "type":
      return `type "${a.text}" into ${step.target ?? a.ref}${a.submit ? " and press Enter" : ""}`;
    case "select":
      return `select "${a.option}" in ${step.target ?? a.ref}`;
    case "wait_for":
      return a.text !== undefined ? `wait for "${a.text}"` : `wait for URL containing "${a.url_contains}"`;
    case "assert":
      return `${a.final ? "final check" : "check"}: ${a.assertion.kind.replace(/_/g, " ")}${"text" in a.assertion ? ` "${a.assertion.text}"` : ""}${"value" in a.assertion ? ` "${a.assertion.value}"` : ""}${step.target ? ` on ${step.target}` : ""}`;
    case "conclude":
      return "conclude";
  }
}

async function criterionSection(c: CriterionVerdict, attempts: AttemptRecord[], artifactsPath: string): Promise<string> {
  const attemptBlocks: string[] = [];
  for (const a of attempts) {
    const shot = await screenshotFor(artifactsPath, c.id, a.attempt);
    const rows = a.steps
      .map(
        (s) => `<tr class="${s.ok ? "" : "bad"}"><td class="n">${s.step}</td><td>${esc(describe(s))}${s.thought ? `<div class="why">${esc(s.thought)}</div>` : ""}</td><td>${esc(s.outcome)}</td></tr>`,
      )
      .join("\n");
    attemptBlocks.push(`
      <details ${attempts.length === 1 || a.result !== "pass" ? "open" : ""}>
        <summary>Attempt ${a.attempt}: <span class="r ${a.result}">${LABEL[a.result]}</span> <span class="muted">decided by ${esc(a.decided_by.replace(/_/g, " "))} · ${a.steps.length} steps</span></summary>
        <div class="attempt">
          <table class="steps"><thead><tr><th>#</th><th>Action</th><th>Outcome</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="muted">No steps recorded.</td></tr>'}</tbody></table>
          ${shot ? `<figure><img src="${shot}" alt="Page at the decision step"><figcaption>Page at the decision step</figcaption></figure>` : ""}
        </div>
      </details>`);
  }
  const evidence = [
    ...c.evidence.failed_requests.map((r) => `${r.method} ${r.url} → ${r.status ?? r.failure}`),
    ...c.evidence.console_errors,
  ];
  return `
  <section class="criterion">
    <h2><span class="r ${c.result}">${LABEL[c.result]}</span> ${esc(c.id)}</h2>
    <dl>
      <dt>Expected</dt><dd>${esc(c.expected)}</dd>
      <dt>Observed</dt><dd>${esc(c.observed)}</dd>
      ${c.failing_step ? `<dt>Failing step</dt><dd>${c.failing_step}</dd>` : ""}
      ${c.repair_hint ? `<dt>Repair hint</dt><dd class="hint">${esc(c.repair_hint)}</dd>` : ""}
      ${evidence.length ? `<dt>Signals</dt><dd><ul>${evidence.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul></dd>` : ""}
    </dl>
    ${attemptBlocks.join("\n")}
  </section>`;
}

export async function renderReport(verdict: Verdict, attempts: Record<string, AttemptRecord[]>, artifactsPath: string, title = "Verdict report"): Promise<string> {
  const sections: string[] = [];
  for (const c of verdict.criteria) sections.push(await criterionSection(c, attempts[c.id] ?? [], artifactsPath));
  const s = verdict.summary;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(verdict.run_id)}</title>
<style>
  :root { --ink:#1f2328; --muted:#656d76; --line:#d0d7de; --bg:#ffffff; --soft:#f6f8fa;
          --pass:#1a7f37; --fail:#cf222e; --error:#9a6700; --inconclusive:#6e7781; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 0 0 12px; display:flex; gap:10px; align-items:center; }
  .muted { color: var(--muted); font-size: 13px; }
  .meta { color: var(--muted); margin-bottom: 24px; }
  .summary { display:flex; gap: 8px; flex-wrap: wrap; margin: 16px 0 28px; }
  .summary span { border:1px solid var(--line); border-radius: 6px; padding: 4px 10px; font-size: 14px; }
  .r { display:inline-block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: 999px; color:#fff; }
  .r.pass { background: var(--pass); } .r.fail { background: var(--fail); } .r.error { background: var(--error); } .r.inconclusive { background: var(--inconclusive); }
  .criterion { border:1px solid var(--line); border-radius: 8px; padding: 18px 20px; margin-bottom: 20px; }
  dl { display:grid; grid-template-columns: 120px 1fr; gap: 6px 14px; margin: 0 0 14px; }
  dt { color: var(--muted); } dd { margin: 0; }
  dd.hint { background: #fff8c5; border-left: 3px solid #d4a72c; padding: 6px 10px; border-radius: 4px; }
  dd ul { margin: 0; padding-left: 18px; }
  code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
  details { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 10px; }
  summary { cursor: pointer; font-weight: 600; }
  .attempt { margin-top: 10px; }
  table.steps { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .steps th, .steps td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .steps th { background: var(--soft); font-weight: 600; }
  .steps td.n { color: var(--muted); width: 32px; }
  .steps tr.bad td { background: #fff5f5; }
  .why { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
  figure { margin: 14px 0 0; } figure img { width: 100%; border: 1px solid var(--line); border-radius: 6px; }
  figcaption { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  @media (max-width: 640px) { dl { grid-template-columns: 1fr; } }
</style></head>
<body><main>
  <h1>${esc(title)} <span class="r ${verdict.status}">${LABEL[verdict.status]}</span></h1>
  <div class="meta">Run <code>${esc(verdict.run_id)}</code>${verdict.commit ? ` · commit <code>${esc(verdict.commit.slice(0, 7))}</code>` : ""} · ${(verdict.duration_ms / 1000).toFixed(1)} s · ${verdict.cost.llm_tokens.toLocaleString("en-US")} tokens · $${verdict.cost.usd.toFixed(4)}</div>
  <div class="summary"><span>${s.passed} passed</span><span>${s.failed} failed</span><span>${s.error} error</span><span>${s.inconclusive} inconclusive</span></div>
  ${sections.join("\n")}
  <p class="muted">Results: <b>pass</b> the app does what the criterion says · <b>fail</b> the app is wrong (confirmed by a second attempt) · <b>error</b> Verdict or its environment broke, not the app · <b>inconclusive</b> no reliable decision.</p>
</main></body></html>
`;
}

export async function writeReport(verdict: Verdict, attempts: Record<string, AttemptRecord[]>, artifactsPath: string): Promise<string> {
  const path = join(artifactsPath, "report.html");
  await writeFile(path, await renderReport(verdict, attempts, artifactsPath));
  return path;
}
