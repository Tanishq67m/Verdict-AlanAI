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

**4. Real run against local EventPulse with Gemini** (MacBook Air, 22 Sept 2026; EventPulse web as a production build, API in dev mode; `gemini-3.5-flash-lite`, default thinking):

```
$ pnpm verdict run --spec .verdict.example.yml --url http://localhost:3000 > verdict.json
step 1   navigate http://localhost:3000                          → loaded (HTTP 200)
step 2   click e11            [link "Sign in"]                   → /auth/login
step 3   type "{{auth.email}}" into e328 [textbox "you@example.com"]
step 4   type "{{auth.password}}" into e331 + Enter              → /events
step 5   click e512           [link]                              → /events/verdict-demo-night-351e471b
step 6   click e638           [button "General Admission Standard pass Free Availability 40 left"]
step 7   click e649           [button "Confirm Booking"]
step 8   wait_for text "Booking Confirmed"                        → appeared
step 9   assert (final) text visible "Booking Confirmed!"         → PASSED
step 10  conclude
criterion_decided  result=pass  decided_by=dom  stop=concluded  steps=10
run_finished       status=pass  duration_ms=29128  llm_calls=9  llm_tokens=21192  usd=0.007625
```
(Condensed from the JSON log lines; the full log is one JSON object per line on stderr.)

```json
{
  "run_id": "run_eff89efc",
  "status": "pass",
  "commit": null,
  "summary": { "passed": 1, "failed": 0, "error": 0, "inconclusive": 0 },
  "criteria": [
    {
      "id": "book-ticket",
      "result": "pass",
      "expected": "\"Booking Confirmed!\" is visible",
      "observed": "\"Booking Confirmed!\" is visible",
      "failing_step": null,
      "evidence": {
        "screenshot_url": "file:///Users/tanishqmohod/AlanAI/verdict/artifacts/run_eff89efc/book-ticket-step10.png",
        "trace_url": null,
        "console_errors": [],
        "failed_requests": []
      },
      "repair_hint": null
    }
  ],
  "cost": { "llm_tokens": 21192, "usd": 0.007625 },
  "duration_ms": 29128
}
```

Checked after the run:
- `verdict.json` validates against `VerdictV1Schema` (checked separately, not just by the run itself).
- The decision-step screenshot shows the "Booking Confirmed!" panel on Verdict Demo Night.
- 0 occurrences of the test account's email or password in `verdict.json`, `book-ticket-steps.json` or the artifacts' `verdict.json`. The log shows only `{{auth.email}}` / `{{auth.password}}`.
- The pass was **decided by the DOM assertion** (`decided_by=dom`); the LLM judge was not called.
- Cost at Gemini's paid list price: **$0.0076** for one criterion (actual spend $0, free tier). Linear extrapolation to 5 criteria ≈ $0.038, under the $0.05 target but not by much. Measure it in M2, don't assume it.
- Latency: 29 s for one criterion, ~1.3–2.6 s per LLM call.

What this run does **not** prove yet: that Verdict catches bugs on EventPulse (that's the M4 benchmark) or that the result is stable across reruns (M2/M4).

Observations from the trace, for M2:
- Step 5 clicked a `link` with **no accessible name** (the event card). That's an accessibility gap in EventPulse's event card; Verdict still found it from context, but role+name targeting would be ambiguous there.
- Steps 8 and 9 overlap (a `wait_for` then an assert on the same text): one wasted LLM call. The planner prompt can say "assert directly; assertions already wait up to 3 s".
- `ignored_signals: 12`: out-of-scope signals (third-party or 4xx) were seen but didn't decide. M2 should log what they were at debug level, so a real bug can't hide there.
- The run created a real booking; the booking must be cancelled before the next run (open question 5).

### Open questions for Milestone 2

1. **Declared API hosts.** The egress allowlist and signal scope match on the `base_url` hostname, which covers `localhost:3000` + `localhost:5001`. A Vercel preview calling an API on another host needs an `api_hosts` field in the spec, which the PRD mentions but its schema doesn't have. Add `api_hosts: [...]` to spec v1?
2. **Verdict `version` field.** The PRD's verdict JSON has no `version`, but it's called "v1". Add `"version": 1` so consumers can detect changes?
3. **B6 (login redirect loop) currently ends as `inconclusive`.** Should the benchmark count "inconclusive with a repeating URL in the trace" as caught, or should M2 add loop detection that turns it into `fail`?
4. **Playwright trace files.** They capture typed passwords (action params and DOM snapshots). Plan: record traces in M2 and rewrite the zip to redact secrets before upload, refusing to publish if any remain.
5. **Test data reset.** The one-booking-per-user rule means `book-ticket` can only pass once per account. M2 needs a reset step (cancel the test user's bookings via EventPulse's API) before each run, or a fresh test user per run.
6. **Default model and thinking level.** `gemini-3.5-flash-lite` is the default on cost grounds. The first real runs should decide whether it plans reliably or whether `gemini-3.7-flash` (or `GEMINI_THINKING_LEVEL=low`) is worth the cost.
7. **The PRD's example verdict is abbreviated.** Its summary says 3 criteria but the array shows 1. Our schema requires the full list; confirm that's the intended contract.

---

## Milestone 2: full task, trustworthy results, HTTP API

### What was built

| Area | What changed |
|---|---|
| Spec | `.verdict.example.yml` now has three criteria: `book-ticket`, `seat-count`, `sold-out` |
| Flake handling | A transient step error retries once (500 ms). A failed criterion re-runs once in a fresh browser: fail + fail → `fail` ("confirmed by a second attempt"); fail + anything else → `inconclusive` with both observations |
| Test-data reset | `VERDICT_RESET=eventpulse`: before every attempt, logs in to EventPulse's API as the test user (once per run) and cancels their active bookings. Configured on the worker, never in the spec |
| Redirect loops | Main-frame navigations are counted per action; the same page 3+ times while bouncing between pages → hard `fail` naming the pages (catches B6) |
| Rate limits | A 429 from the app during an attempt turns a non-pass into `error` (EventPulse allows 100 requests / 15 min per IP, 20 for auth) |
| Planner | Rules from the first real run: no `wait_for` before an assertion on the same thing; read → act → re-read → assert for value changes; assert disabled controls directly |
| HTTP API | `pnpm api`: `POST /v1/runs` (Idempotency-Key: replay on same body, 409 on a different body), `GET /v1/runs/{id}`, `GET /healthz`, bearer API key. Runs execute one at a time; stored as JSON files; credentials never written to disk |
| Artifacts | Per attempt: `<criterion>-attempt<N>-steps.json`, `<criterion>-attempt<N>-step<K>.png` |

Deliberately not built: Postgres, BullMQ, object storage, docker-compose. One browser per worker is the real throughput limit; the store and queue are small interfaces that can be swapped later.

### What was verified by actually running it

**Unit tests + typecheck** (Linux arm64, Node 22):
```
 Test Files  11 passed (11)
      Tests  105 passed (105)
$ tsc -p tsconfig.json          (no errors)
```
New: judging order with a redirect loop, EventPulse reset against a fake API (only active bookings cancelled, one login per run, 429 explained), API idempotency (replay, 409, one execution), auth, validation, credentials never on disk.

**End-to-end in real Chromium** against the fixture app with a scripted LLM, 13/13 passing on 3 consecutive runs:
```
 ✓ passes on a working app via a DOM assertion; the LLM judge is never asked
 ✓ B1-style: a JS error on click fails via the console signal (confirmed by a second attempt)
 ✓ a 500 from the booking API fails via the network signal
 ✓ a missing confirmation fails via the final DOM assertion
 ✓ asks the LLM judge only when the planner concludes without any deterministic check
 ✓ logs in with placeholders: real credentials reach the browser but never the LLM, logs or artifacts
 ✓ blocks navigation to other hosts (egress allowlist) and reports it to the planner
 ✓ returns inconclusive when the step budget runs out
 ✓ maps invalid LLM output to error (Verdict's fault), never fail
 ✓ B6-style: a redirect loop after an action fails with the loop named
 ✓ flaky: a failure that doesn't repeat on a fresh-browser rerun is inconclusive, never a silent pick
 ✓ a 429 from the app turns a non-pass into error (test environment, not an app bug)
 ✓ a failing test-data reset is an error, and the browser flow never starts
```

**The real API process** (`pnpm api`, then curl):
```
GET  /healthz                         → {"ok":true,"queued":0}
POST /v1/runs (Idempotency-Key K)     → 202 {"run_id":"run_cd2a1910","status":"queued",…}
POST /v1/runs (same K, same body)     → 200 (replayed, same run_id)
GET  /v1/runs/run_cd2a1910            → status "done", verdict status "error"
                                        (no Chromium on the test machine: correctly reported as a
                                        Verdict/environment error, not an app failure)
grep for the test password in runs/ and the API log → 0 matches
```

### Real runs against local EventPulse, round 1 (23 Sept 2026)

Three consecutive runs of the three-criterion task, `gemini-3.5-flash-lite`, `VERDICT_RESET=eventpulse`:

| Run | book-ticket | seat-count | sold-out | Run status | Duration | LLM calls | Cost (list price) |
|---|---|---|---|---|---|---|---|
| run_86e58446 | pass | **error** | pass | error | 96.3 s | 24 | $0.0227 |
| run_845d1fb6 | pass | pass | pass | pass | 99.8 s | 28 | $0.0256 |
| run_cc0f1e8f | **inconclusive** | **inconclusive** | pass | inconclusive | 233.3 s | 49 | $0.0461 |

**0 false fails in 9 criterion results.** Every non-pass was correctly *not* blamed on the app:

- **Run 1, seat-count → `error`:** Gemini's free tier returned HTTP 429 ("15 requests per minute per model"). Correctly reported as a Verdict/environment error, not a fail.
- **Run 3, book-ticket → `inconclusive`:** on attempt 1 the planner clicked Confirm Booking, saw "Processing Securely…", waited for the *menu link* "My Tickets" (always present), then navigated away to /my-tickets and asserted the event title under the Upcoming tab, where it doesn't appear because the event's start date has passed. Its final assertion failed → `fail` → the fresh-browser rerun passed → `inconclusive`. The flake rule stopped an agent mistake from becoming a false fail.
- **Run 3, seat-count → `inconclusive`:** attempt 1 read "40 left" on the event page, then asserted "39/40" against the events list, which shows "1/40 registered" (registrations, not remaining seats). Wrong expected format → `fail` → rerun passed → `inconclusive`.
- The reset worked every time (`cancelled_bookings` 0 or 1), so reruns never collided on the one-booking rule.

**Fixes made from these runs:**
1. **Client-side Gemini rate limit** (`GEMINI_RPM`, default 14/min, shared per model across runs): waits instead of hitting the 15/min free-tier quota. SDK retry delay raised to 30 s to cover the provider's "retry in ~26 s".
2. **Settling waits for the app's own requests, up to 10 s** (was any request, up to 3 s). EventPulse's booking request sends a confirmation email and can take several seconds; the planner saw "Processing…" mid-request. Third-party requests (maps, fonts) no longer count.
3. **Planner rules:** assert a confirmation where it appears before navigating; never navigate away from a "processing" state; don't wait for menu links or headings; for value changes, record the exact text and assert the same element in the same format.
4. **Planner memory:** each history line now carries the planner's earlier reasoning (truncated), so values it read ("40 left") survive across stateless calls.

### Real runs against local EventPulse, round 2 (23 Sept 2026)

| Run | book-ticket | seat-count | sold-out | Run status |
|---|---|---|---|---|
| 1 | **error** (EventPulse returned 429) | **error** (reset got 429) | **error** (reset got 429) | error |
| 2 | pass | pass | pass | pass |
| 3 | pass | **error** (Gemini HTTP 503, service unavailable) | pass | error |

**0 false fails, 0 inconclusives in 9 results.** No planner mistakes this round: every non-pass was the test environment, and each was reported as `error` with the cause:

- **Run 1:** rounds 1 and 2 together exceeded EventPulse's API rate limit (100 requests / 15 min per IP). Verdict recorded the underlying outcome and still refused to blame the app: *"The app rate-limited this test run (HTTP 429 on /api/events?limit=3 at step 6)… Underlying outcome: fail: Uncaught TypeError: Cannot read properties of undefined (reading 'filter')"*.
- **Run 3:** Gemini returned 503 (provider outage) after the SDK's retries.

**A real EventPulse bug surfaced along the way:** when the events API returns an error (here a 429), the events page crashes with `Uncaught TypeError: Cannot read properties of undefined (reading 'filter')` instead of showing an error state. The frontend assumes `data` is always present.

**Fixes made from this round:**
1. **Provider retry:** an attempt that dies on a transient LLM-provider error (429 or 5xx) is retried once after a 20 s pause. A non-transient provider error (e.g. 400 bad key) is not retried. This is separate from the flake rule: it's about Verdict's infrastructure, not the app.
2. **Test environment:** EventPulse's API rate limits are made configurable (`RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`, defaults unchanged) so a test environment can raise them. That's a change in the EventPulse repo, not in Verdict.

### Real runs against local EventPulse, round 3 (23 Sept 2026)

EventPulse's API rate limits raised for the test environment (`RATE_LIMIT_MAX=2000`, `AUTH_RATE_LIMIT_MAX=500`). Three consecutive runs, ~2 minutes apart:

| Run | book-ticket | seat-count | sold-out | Status | Duration | Cost (list price) |
|---|---|---|---|---|---|---|
| 1 | pass | pass | pass | pass | 109.1 s | $0.0243 |
| 2 | pass | pass | pass | pass | 106.3 s | $0.0265 |
| 3 | pass | pass | pass | pass | 99.0 s | $0.0238 |

**9/9 pass, identical run status on all three runs.** Every pass was decided by a DOM assertion (`"Booking Confirmed!"` visible; the events list reads `"1/40 registered"` after one booking; `"SOLD OUT"` / `"Sales Closed"` visible). Mean: 104.8 s and $0.0249 per three-criterion run (≈ 35 s and $0.008 per criterion).

### Milestone 2 summary across all rounds

| | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| Criterion results | 6 pass, 1 error, 2 inconclusive | 6 pass, 3 error | 9 pass |
| False fails | 0 | 0 | 0 |
| Cause of non-passes | Gemini 15/min quota; two planner mistakes (caught by the rerun rule) | EventPulse rate limit; Gemini 503 | – |

Across 27 criterion results, Verdict never reported `fail` on a working app. That's the property Milestone 2 was for. What these runs do **not** measure yet is catching real bugs; that's the Milestone 4 benchmark.

---

## Milestone 3: the pull-request loop

### What was built

| Where | What |
|---|---|
| `action/action.yml` | Composite GitHub Action: installs Verdict + Chromium, plans which criteria to run, runs Verdict, uploads the report, reports on the PR, fails the check per `fail-on` |
| `apps/worker/src/github/` | PR comment rendering, a single comment updated in place (found by a hidden marker, bot-authored only), hidden previous-run data for `only-failed`, job summary, exit code |
| `apps/worker/src/report/html.ts` | Self-contained `report.html` per run: every criterion, attempt and step, with the decision screenshot inlined. Written for CLI and API runs too |
| EventPulse `.github/workflows/verdict.yml` | Builds the PR's EventPulse (Postgres service, migrations, seed, API + web production build) inside the runner, then runs the Verdict action |
| EventPulse `apps/api/scripts/seed-verdict.mjs` | Idempotent test data: attendee, organizer, "Verdict Demo Night" (40 free seats), "Verdict Sold Out Night" (sold out); refuses to run without `VERDICT_SEED=1` |
| EventPulse `.verdict.yml` | The three criteria, owned by the app repo |

Design choices: the app runs inside CI for the PR's own commit instead of on a Vercel preview (previews share one production backend, so backend changes would never be tested); nothing to host; throwaway secrets generated per run; `NODE_ENV=production` only for the start step (setting it job-wide makes `npm ci` skip devDependencies and the build fails).

### What was verified

- **Unit tests:** 120 passing. New: PR comment content and escaping, hidden-data round trip, one comment created then updated in place, forged (non-bot) comments ignored, `fail-on` exit codes, "could not run" when no verdict exists, `only-failed` plan + carry-over, self-contained HTML report (screenshot inlined, text escaped, no external assets).
- **Workflow steps** run by hand in a Linux container with Postgres 16: `npm ci` succeeded. Prisma engine downloads are blocked in that sandbox, so migrations, the seed script and the builds are verified for the first time by the real GitHub run below.

### Real GitHub runs (23 Sept 2026)

EventPulse repo, GitHub-hosted `ubuntu-latest`, the full stack built from each commit inside the runner.

| Run | Commit | Check | Result | Verdict time | Cost |
|---|---|---|---|---|---|
| `main`, manual run | `21cf5da` | ✅ | 3/3 pass | 78 s | $0.021 |
| PR #1 "Remember ticket quantity for returning users" | planted bug | ❌ | `book-ticket` fail, `seat-count` fail, `sold-out` pass | ~3 min job | n/a |
| Same PR, fix pushed | fix commit | ✅ | 3/3 pass, same comment updated in place | 1 m 45 s step (2 m 59 s job) | n/a |

**The planted bug.** The PR remembers a user's usual ticket quantity in `localStorage`, but reads it with `JSON.parse(localStorage.getItem(...))` and then `previous.count`. For a first-time user that value is `null`, so clicking **Confirm Booking** throws. The code compiles, the Vercel preview deploys green, and nothing in unit tests touches it.

**What Verdict did.** In both booking criteria the agent signed in, opened the event, chose the free tier and clicked Confirm Booking (step 8). The page threw `Uncaught TypeError: Cannot read properties of null (reading 'count')`, and the console signal decided `fail` on its own: no LLM judgment involved. A second attempt in a fresh browser failed the same way, so both were reported as confirmed fails with a repair hint pointing at the Confirm Booking handler. `sold-out` never books, so it correctly passed. After the one-line fix (`?? '{"count":0}'`) the same PR comment flipped to all green.

**What only the real CI run found** (all fixed):
1. EventPulse's Prisma migrations are behind `schema.prisma` (a column added without a migration). The workflow now uses `prisma db push` for its throwaway database.
2. The CLI's `--env-file` flag was intercepted by Node through `tsx` and killed the run in 0 s. Renamed to `--dotenv`. The action now also shows the stderr tail when no verdict is produced, which is how this was diagnosed.
3. Internal snapshot refs (`f1e241`) leaked into human text. Verdicts and PR comments now name the element (`click button "Confirm Booking"`); the planner's own history keeps refs.

