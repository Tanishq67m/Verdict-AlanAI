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
| C-10 | Benchmark bugs in the backend need their own backend (per-branch backend + CORS fix, or a fully local stack per bug branch). Decided in Milestone 3. | §5: previews share one backend. |

---

## 7. Roadmap

### Milestone 1 — one criterion, locally ✅
Workspace scaffold; zod schemas for task spec and verdict; Gemini client; observe → act → judge loop with hybrid judging, limits and evidence; `pnpm verdict run` CLI; unit and end-to-end tests; a real run against local EventPulse (see `NOTES.md`).

### Milestone 2 — full engine and API
Multiple criteria; flake handling (retry a transient step once, re-run a failed criterion in a fresh context, disagreement → `inconclusive`); repair hints from the strongest signal; Fastify API (`POST /v1/runs` with `Idempotency-Key`, `GET /v1/runs/{id}`, `/healthz`); BullMQ on Redis; Postgres via Prisma; artifact upload and redacted Playwright traces; `docker-compose.yml` for the whole stack.

### Milestone 3 — GitHub loop and deploy
GitHub Action on `deployment_status: success` (reads `.verdict.yml`, sets a check, updates one PR comment in place); `POST /v1/runs/{id}/rerun` for failed criteria only; API and worker deployed to Render or Fly.io; decision on C-10.

### Milestone 4 — prove it
Seed bugs B1–B6 as patches; `bench/run.ts` runs each bug 3× and clean main 5×; raw logs and a summary (catch rate, false-fail rate, stability, p50/p95 latency, cost) in `bench/results/`; README with architecture, benchmark table (only measured numbers) and a 3-command quickstart.

---

## 8. Target repository layout

```text
verdict/
├── apps/
│   ├── api/                 Fastify: runs, idempotency, auth, rate limits
│   └── worker/              CLI + BullMQ consumer: runs the browser loop
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
├── prisma/schema.prisma
├── docker-compose.yml
├── .verdict.example.yml
├── docs/                    PRD.md, PLAN.md
├── NOTES.md                 per-milestone notes with real output
└── README.md                architecture, benchmark table, quickstart
```
