import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeLlmClient, type FakeReply } from "@verdict/llm/testing";
import type { LlmRequest } from "@verdict/llm";
import { VerdictV1Schema, type TaskSpec } from "@verdict/schema";
import { Redactor, runVerification, secretsFromSpec, silentLogger, type RunOptions } from "../src/index.ts";
import { FIXTURE_USER, startFixtureApp, type FixtureBug } from "./fixtures/app.ts";

const launch = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] } : {};
let app: Awaited<ReturnType<typeof startFixtureApp>> | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** Finds the ref of an element in the snapshot the planner was shown, like a real model would. */
function ref(req: LlmRequest, role: string, name: string): string {
  const m = req.user.match(new RegExp(`- ${role} "${name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`));
  if (!m?.[1]) throw new Error(`fixture: no ${role} "${name}" in snapshot:\n${req.user}`);
  return m[1];
}
const plan = (thought: string, action: Record<string, unknown>) => JSON.stringify({ thought, action });
const clickBook: FakeReply = (r) => plan("Book the ticket", { type: "click", ref: ref(r, "button", "Confirm Booking") });
const assertConfirmed = plan("Check the confirmation", { type: "assert", final: true, assertion: { kind: "text_visible", text: "Booking Confirmed!" } });
const conclude = plan("Done", { type: "conclude", summary: "Confirmation checked" });

function spec(url: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    version: 1,
    task: "fixture",
    base_url: `${url}/events/demo`,
    criteria: [{ id: "book-ticket", check: 'A user can book one ticket for "Verdict Demo Night" and sees a confirmation.' }],
    limits: { max_steps_per_criterion: 15, timeout_seconds: 120 },
    ...extra,
  };
}

async function run(
  bug: FixtureBug,
  script: ConstructorParameters<typeof FakeLlmClient>[0],
  extra: Partial<TaskSpec> = {},
  opts: Pick<RunOptions, "beforeAttempt" | "rerunFailures"> = {},
) {
  app = await startFixtureApp(bug);
  const s = spec(app.url, extra);
  const llm = new FakeLlmClient(script);
  const out = await runVerification({
    spec: s,
    llm,
    price: { input: 0.3, output: 2.5 },
    redactor: new Redactor(secretsFromSpec(s)),
    logger: silentLogger,
    artifactsDir: await mkdtemp(join(tmpdir(), "verdict-e2e-")),
    launch,
    ...opts,
  });
  expect(VerdictV1Schema.safeParse(out.verdict).success).toBe(true);
  const c = out.verdict.criteria[0]!;
  return { ...out, llm, c };
}

describe("engine end to end (real Chromium, scripted LLM)", () => {
  it("passes on a working app via a DOM assertion; the LLM judge is never asked", async () => {
    const { c, llm, verdict } = await run("none", { plan: [clickBook, assertConfirmed, conclude] });
    expect(c.result).toBe("pass");
    expect(c.failing_step).toBeNull();
    expect(c.evidence.screenshot_url).toMatch(/^file:\/\/.+book-ticket-attempt1-step\d+\.png$/);
    expect(llm.callsFor("judge")).toHaveLength(0);
    expect(app!.bookings()).toBe(1);
    expect(verdict.cost.llm_tokens).toBe(330); // 3 planner calls x 110 fake tokens
  });

  it("B1-style: a JS error on click fails via the console signal, before any assertion or LLM judgment", async () => {
    const { c, llm } = await run("js-error", { plan: [clickBook, clickBook] });
    expect(c.result).toBe("fail");
    expect(c.failing_step).toBe(2);
    expect(c.evidence.console_errors[0]).toMatch(/\[step 2\] Uncaught TypeError/);
    expect(c.observed).toContain('button "Confirm Booking"');
    expect(c.observed).toContain("confirmed by a second attempt");
    expect(llm.callsFor("plan")).toHaveLength(2); // one planner call per attempt, then the signal decides
    expect(llm.callsFor("judge")).toHaveLength(0);
  });

  it("a 500 from the booking API fails via the network signal", async () => {
    const { c } = await run("api-500", { plan: [clickBook, clickBook] });
    expect(c.result).toBe("fail");
    expect(c.evidence.failed_requests).toEqual([{ method: "POST", url: expect.stringMatching(/\/api\/bookings$/), status: 500, failure: null }]);
    expect(c.repair_hint).toContain("/api/bookings returned 500");
  });

  it("a missing confirmation fails via the final DOM assertion", async () => {
    const { c, llm } = await run("no-confirmation", { plan: [clickBook, assertConfirmed, clickBook, assertConfirmed] });
    expect(c.result).toBe("fail");
    expect(c.failing_step).toBe(3);
    expect(c.observed).toContain('"Booking Confirmed!" is not visible');
    expect(llm.callsFor("judge")).toHaveLength(0);
  });

  it("asks the LLM judge only when the planner concludes without any deterministic check", async () => {
    const judgment = JSON.stringify({ result: "pass", expected: "A confirmation", observed: "Booking Confirmed! is shown", reason: "Visible confirmation" });
    const { c, llm } = await run("none", { plan: [clickBook, conclude], judge: [judgment] });
    expect(c.result).toBe("pass");
    expect(llm.callsFor("judge")).toHaveLength(1);
    expect(llm.callsFor("judge")[0]!.user).toContain("Booking Confirmed!");
  });

  it("logs in with placeholders: real credentials reach the browser but never the LLM, logs or artifacts", async () => {
    const auth = { email: FIXTURE_USER.email, password: FIXTURE_USER.password };
    const loginPlan: FakeReply[] = [
      plan("Go to sign in", { type: "navigate", url: "/login" }),
      (r) => plan("Email", { type: "type", ref: ref(r, "textbox", "Email"), text: "{{auth.email}}" }),
      (r) => plan("Password", { type: "type", ref: ref(r, "textbox", "Password"), text: "{{auth.password}}" }),
      (r) => plan("Submit", { type: "click", ref: ref(r, "button", "Sign in") }),
      plan("Logged in?", { type: "assert", final: false, assertion: { kind: "url_contains", value: "user=1" } }),
      clickBook,
      assertConfirmed,
      conclude,
    ];
    const { c, llm, artifactsPath, attempts } = await run("none", { plan: loginPlan }, { auth });
    expect(c.result).toBe("pass");

    const everythingSentToLlm = llm.calls.map((x) => x.system + x.user).join("\n");
    expect(everythingSentToLlm).not.toContain(FIXTURE_USER.password);
    // The page greets the user by email; the LLM sees the placeholder instead.
    expect(everythingSentToLlm).not.toContain(FIXTURE_USER.email);
    expect(everythingSentToLlm).toContain("Welcome back, {{auth.email}}");

    const files = await readdir(artifactsPath);
    for (const f of files.filter((n) => n.endsWith(".json"))) {
      const text = await readFile(join(artifactsPath, f), "utf8");
      expect(text).not.toContain(FIXTURE_USER.password);
      expect(text).not.toContain(FIXTURE_USER.email);
    }
    expect(attempts["book-ticket"]![0]!.steps.find((s) => s.action?.type === "type" && s.action.text === "{{auth.password}}")).toBeTruthy();
  });

  it("blocks navigation to other hosts (egress allowlist) and reports it to the planner", async () => {
    const judgment = JSON.stringify({ result: "inconclusive", expected: "x", observed: "y", reason: "z" });
    const { attempts, llm } = await run("none", {
      plan: [plan("Leave", { type: "navigate", url: "http://169.254.169.254/latest/meta-data" }), conclude],
      judge: [judgment],
    });
    const blocked = attempts["book-ticket"]![0]!.steps[1]!;
    expect(blocked.ok).toBe(false);
    expect(blocked.outcome).toMatch(/Blocked: 169\.254\.169\.254 is not an allowed host/);
    expect(llm.callsFor("plan")[1]!.user).toContain("Blocked");
  });

  it("returns inconclusive when the step budget runs out", async () => {
    const wander: FakeReply = plan("Look around", { type: "wait_for", text: "40 seats left" });
    const { c, llm } = await run("none", { plan: [wander, wander] }, { limits: { max_steps_per_criterion: 3, timeout_seconds: 120 } });
    expect(c.result).toBe("inconclusive");
    expect(c.observed).toMatch(/No decision within the 3-step budget/);
    expect(llm.callsFor("judge")).toHaveLength(0);
  });

  it("maps invalid LLM output to error (Verdict's fault), never fail", async () => {
    const { c } = await run("none", { plan: ["not json", '{"thought":"x","action":{"type":"hack"}}', "{}"] });
    expect(c.result).toBe("error");
    expect(c.observed).toMatch(/3 invalid actions in a row/);
    expect(c.repair_hint).toMatch(/not an app failure/);
  });

  it("B6-style: a redirect loop after an action fails with the loop named", async () => {
    const { c, llm } = await run("redirect-loop", { plan: [clickBook, clickBook] });
    expect(c.result).toBe("fail");
    expect(c.observed).toMatch(/Redirect loop between .*\/login.*\/events\/demo|Redirect loop between .*\/events\/demo.*\/login/);
    expect(c.repair_hint).toMatch(/route guards/);
    expect(llm.callsFor("judge")).toHaveLength(0);
  });

  it("flaky: a failure that doesn't repeat on a fresh-browser rerun is inconclusive, never a silent pick", async () => {
    const resets: number[] = [];
    const { c, attempts } = await run(
      "flaky",
      { plan: [clickBook, clickBook, assertConfirmed, conclude] },
      {},
      { beforeAttempt: async ({ attempt }) => void resets.push(attempt) },
    );
    expect(c.result).toBe("inconclusive");
    expect(c.observed).toMatch(/Attempt 1 failed: .*HTTP 500.*Attempt 2 \(fresh browser\) was pass/);
    expect(c.repair_hint).toMatch(/^Flaky behavior/);
    expect(attempts["book-ticket"]!.map((a) => [a.result, a.decided_by])).toEqual([["fail", "network"], ["pass", "dom"]]);
    expect(resets).toEqual([1, 2]); // test data is reset before every attempt
  });

  it("a 429 from the app turns a non-pass into error (test environment, not an app bug)", async () => {
    const { c, attempts } = await run("rate-limited", { plan: [clickBook, assertConfirmed] });
    expect(c.result).toBe("error");
    expect(c.observed).toMatch(/rate-limited this test run \(HTTP 429/);
    expect(attempts["book-ticket"]).toHaveLength(1); // errors are not re-run as if they were app failures
  });

  it("a failing test-data reset is an error, and the browser flow never starts", async () => {
    const { c, llm } = await run("none", { plan: [] }, {}, { beforeAttempt: async () => { throw new Error("API unreachable"); } });
    expect(c.result).toBe("error");
    expect(c.observed).toBe("Test-data reset failed: API unreachable");
    expect(llm.calls).toHaveLength(0);
  });
});

