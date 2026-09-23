# Verdict — Design Notes & Plan

`docs/PRD.md` describes the product. This file records what reading the code of the app under test changed about that plan, and the order of work. **Where this file and the PRD disagree, this file wins.**

---

## 1. What Verdict is

Verdict is a QA agent for pull requests. A preview deploy of the app is opened in a real Chromium browser; Verdict reads plain-English acceptance criteria (*"a logged-in user can book one ticket for Verdict Demo Night and sees a confirmation"*), drives the UI one action at a time, and returns a verdict per criterion (`pass`, `fail`, `error`, `inconclusive`) with evidence and a repair hint a coding agent can act on.

**Core design idea:** hard facts decide first, the LLM decides last. A 5xx from the app or an uncaught JavaScript error is a `fail` without asking a model; a DOM assertion decides next; the LLM judges only when all of those are silent.

---

## 2. The app under test

**EventPulse** (`github.com/Tanishq67m/event-Manager`), an event ticketing platform, is the demo target. Its booking, seat-count and sold-out logic provide realistic, seedable bugs (B1–B6).

---

## 3. Page observation

Verdict observes pages with Playwright's AI-mode accessibility snapshot (`page.ariaSnapshot({ mode: "ai" })`): the page's accessibility tree as compact text, with a reference on every element that the executor can click (`aria-ref=e12`). It sits behind an `Observer` interface, so another observer can be added later without touching the loop.

---

## 4. LLM choice

The LLM client is provider-agnostic (one interface, swappable implementation), as the PRD requires.

| Option | Cost | Notes |
|---|---|---|
| **Google Gemini (default)** | Free tier via a Google AI Studio key | Good multi-step planning, fast. Free-tier requests may be used by Google to improve its products; only test-app pages are sent, never credentials (C-4). |
| Ollama (planned second provider) | Free, local | Weaker at long multi-step planning; needs a GPU host in production. |

**Cost metric:** actual spend is $0 on the free tier. Tokens are logged per call and cost is reported as *tokens × Gemini's published paid price*, so the PRD's "≤ $0.05 per run" target stays meaningful.

---

## 5. Findings from reading EventPulse

Read at commit `7f672d7`.

- Only the Next.js frontend is on Vercel; the frontend reaches the API through `NEXT_PUBLIC_API_URL`. Every preview talks to the same backend, so backend bugs (B2, B3, B5) won't appear in a frontend preview.
- The API's CORS allows a single origin (`cors({ origin: env.FRONTEND_URL })`), which blocks preview URLs.
- Free tickets (price 0) confirm immediately; paid tickets go to Razorpay. Test events are free.
- No seed script; test account and events are created by hand.
- One active booking per user per ticket type (`bookings.service.ts`): a second `book-ticket` run with the same account gets a 409.
- Auth tokens live in `localStorage`, so every fresh browser context logs in again.

---

## 6. Changes to the PRD

| # | Change | Why |
|---|---|---|
| C-1 | Default LLM is **Gemini** (free tier); Ollama is the planned second provider. | No paid LLM key; the client stays provider-agnostic. |
| C-2 | Pages are observed with **Playwright's accessibility snapshot** instead of a separate context-extraction library. | Built into Playwright, compact text, and every element has a reference the executor can click; no extra dependency. |
| C-3 | Spec secrets use `${VERDICT_TEST_EMAIL}` (environment), not `${{ secrets.X }}`. | GitHub only expands `${{ }}` inside workflow files, never inside `.verdict.yml`. The Action passes secrets as env vars. |
| C-4 | The LLM types **placeholders** (`{{auth.email}}`); the executor swaps in real values in the browser only. | Credentials never reach the LLM. |
| C-5 | A `conclude` **control signal** alongside the six browser actions. | The closed action set has no way to end the loop. |
| C-6 | Only **5xx / failed requests to the app's hosts** and **uncaught exceptions / app `console.error`** decide alone. 4xx and third-party noise are logged, never decisive. | Otherwise analytics or favicon errors cause false fails. |
| C-7 | Run status: any `fail` → `fail`, else any `error` → `error`, else any `inconclusive` → `inconclusive`, else `pass`. | The PRD doesn't define the roll-up. |
| C-8 | Milestone 1 evidence links are local `file://` paths; `commit` is optional. | No artifact store until Milestone 2. |
| C-9 | The LLM gets page **text** (structured snapshot), not screenshots; screenshots are evidence. | Cost and stability. |
| C-10 | Verification in CI runs against a full EventPulse stack started inside the CI runner for the PR's commit, not against a Vercel preview. | §5: previews share one backend, so backend bugs would never be tested. |

---

## 7. Roadmap

| # | What gets built | What it proves |
|---|---|---|
| **1** ✅ | One criterion on a real app from the CLI | End to end on a real flow (login, booking, confirmation), decided by hard evidence |
| **2** ✅ | A full task (3 criteria), flake handling, test-data reset, redirect-loop detection, a small HTTP API | Results are trustworthy: failures are confirmed, flakiness is reported as such, and Verdict's own problems are never blamed on the app |
| **3** | GitHub Action on EventPulse pull requests, one PR comment updated in place, a static HTML run report, re-run failed criteria only | The full loop on a real repo: PR goes red with a repair hint, fix goes green |
| **4** | Six seeded bugs (B1–B6), benchmark runner, results table, demo video | It catches real bugs, and how often: catch rate, false-fail rate, stability, latency, cost |

### Milestone 2 — details
- Three criteria in one run (`book-ticket`, `seat-count`, `sold-out`), each attempt in a fresh browser.
- Flake handling: a transient step error retries once; a failed criterion re-runs once in a fresh browser; fail + fail → `fail`, fail + anything else → `inconclusive` (both observations kept).
- Test-data reset before every attempt (`VERDICT_RESET=eventpulse`: cancels the test user's bookings via EventPulse's API). Configured on the worker, never in the spec.
- Redirect loops within one action are a hard `fail` signal (catches B6).
- A 429 from the app turns a non-pass into `error` (the test run was throttled; not an app bug).
- HTTP API: `POST /v1/runs` with `Idempotency-Key`, `GET /v1/runs/{id}`, `GET /healthz`. Runs execute one at a time; runs are stored as JSON files and credentials are never persisted.
- Deliberately not in Milestone 2: Postgres, BullMQ, object storage, docker-compose. The store and queue are small interfaces that can be swapped when there is more than one worker.

### Milestone 3 — details
The GitHub Action starts EventPulse (web + API + Postgres) inside the CI runner for the PR's commit and runs Verdict against it. Nothing needs to be hosted, and backend changes are tested too, which resolves C-10. The Action sets a check status, updates a single PR comment in place, and uploads a static HTML report (steps + screenshots) as a build artifact. Re-running only failed criteria uses the previous verdict.

### Milestone 4 — details
Bugs B1–B6 as patches on EventPulse; `bench/run.ts` runs each bug 3× and clean main 5×; raw logs and a summary table in `bench/results/`; README table uses only those numbers; a 2-minute demo video.

---

## 8. Target repository layout

```text
verdict/
├── apps/
│   ├── api/                 Fastify: runs, idempotency, API key
│   └── worker/              CLI + shared runner + test-data reset adapters
├── packages/
│   ├── schema/              zod: task spec + verdict (v1)
│   ├── engine/
│   │   ├── observe/         Observer interface + accessibility-snapshot observer
│   │   ├── actions/         navigate, click, type, select, wait_for, assert, conclude
│   │   ├── signals/         console, page errors, network, request activity
│   │   ├── judge/           network → console → DOM → LLM
│   │   └── loop, run        limits, evidence, verdict assembly
│   ├── llm/                 LlmClient + Gemini (+ Ollama)
│   └── github/              check status + single PR comment
├── action/                  GitHub Action
├── bench/                   bugs B1–B6, runner, results
├── .verdict.example.yml
├── docs/                    PRD.md, PLAN.md
├── NOTES.md                 per-milestone notes with real output
└── README.md                architecture, benchmark table, quickstart
```
