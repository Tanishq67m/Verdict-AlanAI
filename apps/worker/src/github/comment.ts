import type { Result, Verdict } from "@verdict/schema";
import type { PreviousRun } from "./merge.ts";

export const COMMENT_MARKER = "<!-- verdict:comment -->";
const DATA_PREFIX = "<!-- verdict:data ";

const ICON: Record<Result, string> = { pass: "✅", fail: "❌", error: "⚠️", inconclusive: "❔" };

function cell(s: string, max = 220): string {
  const one = s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function headline(v: Verdict): string {
  const total = v.criteria.length;
  const s = v.summary;
  if (v.status === "pass") return `✅ All ${total} checks passed`;
  if (v.status === "fail") return `❌ ${s.failed} of ${total} check${total > 1 ? "s" : ""} failed`;
  if (v.status === "error") return `⚠️ Verdict couldn't finish ${s.error} of ${total} check${total > 1 ? "s" : ""} (not an app failure)`;
  return `❔ ${s.inconclusive} of ${total} check${total > 1 ? "s" : ""} inconclusive`;
}

export interface CommentInput {
  verdict: Verdict;
  commit: string | null;
  reportUrl?: string | null;
  runUrl?: string | null;
  carried?: readonly string[];
}

/** One PR comment, rewritten on every run. The hidden data block lets the next run re-check only failures. */
export function renderComment({ verdict, commit, reportUrl, runUrl, carried = [] }: CommentInput): string {
  const links = [reportUrl ? `[full report](${reportUrl})` : null, runUrl ? `[CI run](${runUrl})` : null].filter(Boolean).join(" · ");
  const meta = [commit ? `commit \`${commit.slice(0, 7)}\`` : null, `${(verdict.duration_ms / 1000).toFixed(0)} s`, `$${verdict.cost.usd.toFixed(3)}`, links || null]
    .filter(Boolean)
    .join(" · ");
  const rows = verdict.criteria.map((c) => {
    const note = carried.includes(c.id) ? " _(carried over)_" : "";
    return `| \`${c.id}\` | ${ICON[c.result]} ${c.result}${note} | ${cell(c.observed)} |`;
  });
  const hints = verdict.criteria.filter((c) => c.result !== "pass" && c.repair_hint);
  const hintBlock = hints.length
    ? `\n**What to fix**\n\n${hints
        .map((c) => `- **\`${c.id}\`**${c.failing_step ? ` (step ${c.failing_step})` : ""}: ${cell(c.repair_hint ?? "", 600)}\n  - expected: ${cell(c.expected, 300)}`)
        .join("\n")}\n`
    : "";
  const data = Buffer.from(JSON.stringify({ commit, verdict } satisfies PreviousRun)).toString("base64");
  return [
    COMMENT_MARKER,
    `### Verdict: ${headline(verdict)}`,
    meta,
    "",
    "| Check | Result | What Verdict saw |",
    "|---|---|---|",
    ...rows,
    hintBlock,
    `<sub>✅ pass · ❌ fail (confirmed by a second attempt) · ⚠️ error = Verdict or its environment broke, not the app · ❔ inconclusive = attempts disagreed</sub>`,
    `${DATA_PREFIX}${data} -->`,
  ].join("\n");
}

/** Reads the previous run back out of an earlier Verdict comment. Returns null if absent or unreadable. */
export function parsePrevious(body: string): PreviousRun | null {
  const start = body.indexOf(DATA_PREFIX);
  if (start < 0) return null;
  const end = body.indexOf(" -->", start);
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body.slice(start + DATA_PREFIX.length, end), "base64").toString("utf8")) as PreviousRun;
    return parsed && parsed.verdict && Array.isArray(parsed.verdict.criteria) ? parsed : null;
  } catch {
    return null;
  }
}
