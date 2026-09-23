import { aggregateStatus, summarize, VerdictV1Schema, type CriterionVerdict, type Verdict } from "@verdict/schema";

/** What the previous PR comment remembered about the last run. */
export interface PreviousRun {
  commit: string | null;
  verdict: Verdict;
}

/**
 * "Re-run failed criteria only": if the last run on this PR had non-passing criteria and knew
 * about every criterion in the current spec, re-run just those. Returns null for "run all".
 * Passing criteria are carried over, not re-checked; that trade-off is why it's opt-in.
 */
export function criteriaToRerun(previous: PreviousRun | null, specIds: readonly string[]): string[] | null {
  if (!previous) return null;
  const byId = new Map(previous.verdict.criteria.map((c) => [c.id, c]));
  if (!specIds.every((id) => byId.has(id))) return null; // spec changed: re-check everything
  const failing = specIds.filter((id) => byId.get(id)?.result !== "pass");
  return failing.length > 0 && failing.length < specIds.length ? failing : null;
}

/** Puts carried-over passes back into the verdict, clearly labelled, and recomputes the roll-up. */
export function mergeWithPrevious(current: Verdict, previous: PreviousRun, specIds: readonly string[]): { verdict: Verdict; carried: string[] } {
  const fresh = new Map(current.criteria.map((c) => [c.id, c]));
  const old = new Map(previous.verdict.criteria.map((c) => [c.id, c]));
  const carried: string[] = [];
  const criteria: CriterionVerdict[] = [];
  const from = previous.commit ? previous.commit.slice(0, 7) : "the previous run";
  for (const id of specIds) {
    const c = fresh.get(id);
    if (c) {
      criteria.push(c);
      continue;
    }
    const prev = old.get(id);
    if (!prev) continue;
    carried.push(id);
    criteria.push({ ...prev, observed: `[carried over from ${from}, not re-checked on this commit] ${prev.observed}` });
  }
  const results = criteria.map((c) => c.result);
  const verdict = VerdictV1Schema.parse({ ...current, criteria, summary: summarize(results), status: aggregateStatus(results) });
  return { verdict, carried };
}
