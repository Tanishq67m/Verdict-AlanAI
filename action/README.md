# Verdict GitHub Action

Runs Verdict against an app that is already running in the job (e.g. started on `localhost`), then:

- fails the check when a criterion fails (configurable with `fail-on`),
- creates **one** PR comment and updates it in place on every push,
- uploads a self-contained HTML report (steps + screenshots) as the `verdict-report` artifact,
- writes the same summary to the job summary.

```yaml
permissions:
  contents: read
  pull-requests: write   # the PR comment
  issues: write

steps:
  # … start your app on localhost …
  - uses: Tanishq67m/Verdict-AlanAI/action@main
    env:
      VERDICT_TEST_EMAIL: ${{ env.VERDICT_TEST_EMAIL }}       # referenced by the spec as ${VERDICT_TEST_EMAIL}
      VERDICT_TEST_PASSWORD: ${{ env.VERDICT_TEST_PASSWORD }}
    with:
      url: http://localhost:3000
      gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
      reset: eventpulse
      reset-api-url: http://localhost:5001/api
```

| Input | Default | Meaning |
|---|---|---|
| `url` | (required) | Base URL of the running app |
| `spec` | `.verdict.yml` | Task spec path in the repo |
| `gemini-api-key` | (required) | Google AI Studio key |
| `model` | Verdict default | Gemini model id |
| `fail-on` | `fail` | Results that fail the check, e.g. `fail,inconclusive` |
| `only-failed` | `false` | Re-check only last run's non-passing criteria; carried-over passes are labelled |
| `reset` / `reset-api-url` | none | Test-data reset before every attempt (`eventpulse`) |

Output: `status` (`pass` / `fail` / `error` / `inconclusive`).
