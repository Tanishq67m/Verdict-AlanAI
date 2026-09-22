# Verdict: Milestone Notes

## Milestone 1: one criterion, run locally

### What was built

| Package | What it does |
|---|---|
| `packages/schema` | zod schemas for the task spec v1 and verdict v1 (exported types), YAML loader with `${VAR}` from env, PRD hard limits enforced in the schema |
| `packages/llm` | Provider-agnostic `LlmClient`; Gemini implementation (`@google/genai`), per-call token log, price table, fake client for tests |
| `packages/engine` | Observe → act → judge loop: aria-snapshot observer, closed action set (navigate, click, type, select, wait_for, assert + `conclude`), network/console signal collection, hybrid judge, step/timeout limits, screenshot + step trace evidence, secret redaction, egress allowlist, prompt-injection fencing |
| `apps/worker` | `pnpm verdict run --spec <file> --url <url>` CLI: verdict JSON on stdout, JSON logs on stderr, exit code per result |
| `.verdict.example.yml` | The `book-ticket` criterion against "Verdict Demo Night" |

Design decisions and deviations from the PRD are in `docs/PLAN.md` (C-1 … C-10).

### How to run it (macOS)

```bash
cd ~/AlanAI/verdict

# once
# pnpm 12 ships as a native binary that Corepack (v0.34) can't launch, so install it with npm.
corepack disable pnpm      # removes Corepack's pnpm shim if it was enabled
npm i -g pnpm@12.5.1
pnpm install
pnpm setup:browsers        # downloads Chromium for Playwright

# tests
pnpm test                  # unit tests: no browser, no network, no key
pnpm test:e2e              # real Chromium against a local fixture app, scripted LLM
pnpm typecheck

# a real run: needs .env (see .env.example) and EventPulse running locally
pnpm verdict run --spec .verdict.example.yml --url http://localhost:3000 > verdict.json
```

**Before each real run:**
- The test account must have **no active booking** for Verdict Demo Night. EventPulse allows one booking per user per ticket type, so a second run gets a 409. Cancel it from My Tickets first.
- Run EventPulse's web app as a **production build** (`npm run build --workspace=apps/web && npm run start --workspace=apps/web`). In `next dev`, React development warnings are written with `console.error`. Verdict treats app `console.error` as a failure, and Vercel previews are production builds anyway.

Exit codes: `0` pass · `1` fail · `2` error · `3` inconclusive · `64` usage/config.
Artifacts: `artifacts/<run_id>/` → `verdict.json`, `<criterion>-steps.json`, `<criterion>-step<N>.png`.

### What was verified by actually running it

**1. Clean clone → install → unit tests → typecheck** (fresh `git clone` of this repo, Linux arm64, Node 22):

```
Done in 1.8s using pnpm v12.5.1
 Test Files  8 passed (8)
      Tests  85 passed (85)
$ tsc -p tsconfig.json          (no errors)
```

Includes the required judging-order test: *a console error forces `fail` and the (fake) LLM is never called* (`packages/engine/test/judge.test.ts`).

**2. End-to-end engine tests against a fixture app in real Chromium** (`pnpm test:e2e`, scripted LLM, 3 consecutive runs, all green):

```
 ✓ passes on a working app via a DOM assertion; the LLM judge is never asked
 ✓ B1-style: a JS error on click fails via the console signal, before any assertion or LLM judgment
 ✓ a 500 from the booking API fails via the network signal
 ✓ a missing confirmation fails via the final DOM assertion
 ✓ asks the LLM judge only when the planner concludes without any deterministic check
 ✓ logs in with placeholders: real credentials reach the browser but never the LLM, logs or artifacts
 ✓ blocks navigation to other hosts (egress allowlist) and reports it to the planner
 ✓ returns inconclusive when the step budget runs out
 ✓ maps invalid LLM output to error (Verdict's fault), never fail
      Tests  9 passed (9)
```

These tests found two real bugs before any real run (both fixed):
- After a navigation, Playwright's refs gain a frame prefix (`f1e3`); the action schema only accepted `e3`.
- `waitForLoadState("networkidle")` returns immediately once a page has ever been idle, so the engine moved on before the booking request's 500 or the async JS error arrived. Replaced with an in-flight request tracker.

**3. The full CLI against the fixture app, with the LLM provider unreachable** (with Google's API unreachable from the test environment, which also shows the `error` ≠ `fail` path working):

```
$ pnpm verdict run --spec .verdict.example.yml     # exit=2
{
  "run_id": "run_d05afcc6",
  "status": "error",
  "commit": null,
  "summary": { "passed": 0, "failed": 0, "error": 1, "inconclusive": 0 },
  "criteria": [
    {
      "id": "book-ticket",
      "result": "error",
      "expected": "Verdict completes the check",
      "observed": "Gemini request failed (HTTP 403): {\"error\":{\"message\":\"Host not in allowlist: generativelanguage.googleapis.com. ...\"}}",
      "failing_step": null,
      "evidence": { "screenshot_url": null, "trace_url": null, "console_errors": [], "failed_requests": [] },
      "repair_hint": "This is a Verdict or infrastructure error, not an app failure. Do not change app code for it; fix the setup or re-run."
    }
  ],
  "cost": { "llm_tokens": 0, "usd": 0 },
  "duration_ms": 1037
}
```

Every stderr log line carried `run_id`; a grep of stdout, stderr and the artifacts found 0 occurrences of the test email or password.

**4. Real run against EventPulse with Gemini: PENDING.** Paste the verdict JSON and the stderr log here:

```
(pending)
```

### Open questions for Milestone 2

1. **Declared API hosts.** The egress allowlist and signal scope match on the `base_url` hostname, which covers `localhost:3000` + `localhost:5001`. A Vercel preview calling an API on another host needs an `api_hosts` field in the spec, which the PRD mentions but its schema doesn't have. Add `api_hosts: [...]` to spec v1?
2. **Verdict `version` field.** The PRD's verdict JSON has no `version`, but it's called "v1". Add `"version": 1` so consumers can detect changes?
3. **B6 (login redirect loop) currently ends as `inconclusive`.** Should the benchmark count "inconclusive with a repeating URL in the trace" as caught, or should M2 add loop detection that turns it into `fail`?
4. **Playwright trace files.** They capture typed passwords (action params and DOM snapshots). Plan: record traces in M2 and rewrite the zip to redact secrets before upload, refusing to publish if any remain.
5. **Test data reset.** The one-booking-per-user rule means `book-ticket` can only pass once per account. M2 needs a reset step (cancel the test user's bookings via EventPulse's API) before each run, or a fresh test user per run.
6. **Default model and thinking level.** `gemini-3.5-flash-lite` is the default on cost grounds. The first real runs should decide whether it plans reliably or whether `gemini-3.7-flash` (or `GEMINI_THINKING_LEVEL=low`) is worth the cost.
7. **The PRD's example verdict is abbreviated.** Its summary says 3 criteria but the array shows 1. Our schema requires the full list; confirm that's the intended contract.
