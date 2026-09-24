# Seeded-bug benchmark

Six realistic bugs, each a small patch on [EventPulse](https://github.com/Tanishq67m/Event-Manager), and the tooling that turns benchmark runs into the numbers in the main README.

| Bug | What breaks | Checked by | Expected signal |
|---|---|---|---|
| B1 | An analytics call on the Book button throws (`window.dataLayer` is undefined) | `book-ticket` | console |
| B2 | Free bookings skip the seat-count update | `seat-count` | DOM |
| B3 | Off-by-one: a sold-out ticket still shows as bookable, and the API accepts it | `sold-out` | DOM |
| B4 | The order total ignores the quantity | `price-matches` | DOM |
| B5 | My Tickets API crashes on bookings without a payment (500) | `ticket-qr` | network |
| B6 | Login sends users to the dashboard, the dashboard sends attendees back to login | `book-ticket` | redirect loop |

## How it runs

EventPulse's [`verdict-bench.yml`](https://github.com/Tanishq67m/Event-Manager/blob/main/.github/workflows/verdict-bench.yml) workflow, started by hand:

- **clean:** EventPulse `main`, the full task (every criterion), 5 runs. Measures false fails, stability, latency and cost of a real run.
- **B1–B6:** `main` with one patch from `bugs/` applied, only the criterion that should catch it, 3 runs each. Measures the catch rate.

Each case builds the app from scratch inside a fresh runner (Postgres, API, web, seeded test data). Cases run one at a time because they share one Gemini key.

A final job runs `pnpm bench:summarize <dir>` over the raw verdicts and publishes `summary.md` + `summary.json`. Those files, with the raw verdicts and logs, are committed to `results/`. The README quotes only them.

## Scoring (from the PRD)

- **Caught:** the bug's criterion is `fail` in at least 2 of its 3 runs. `inconclusive` or `error` don't count as caught.
- **False fail:** any `fail` on the clean build.
- **Stability:** a group (one clean criterion across its runs, or one bug's criterion across its runs) is stable when every run gave the same result.
- **A run with no verdict** counts as `error`, never as pass or fail.

## Known bias

The same person wrote the bugs and the criteria. This measures whether Verdict **reliably detects a broken behaviour that a criterion covers**, not whether it finds bugs nobody wrote a check for.
