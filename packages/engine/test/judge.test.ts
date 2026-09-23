import { describe, expect, it, vi } from "vitest";
import { FakeLlmClient } from "@verdict/llm/testing";
import { judge, type JudgeInput, type LlmJudgment } from "../src/index.ts";

const criterion = { id: "book-ticket", check: 'A logged-in user can book one ticket for "Verdict Demo Night" and sees a confirmation.' };

const llmPass: LlmJudgment = { result: "pass", expected: "Confirmation shown", observed: "Confirmation shown", reason: "The page says Booking Confirmed" };

/** Judge input with every signal silent; each test turns one on. */
function input(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    criterion,
    signals: { consoleErrors: [], failedRequests: [], redirectLoops: [] },
    assertions: [],
    stop: "concluded",
    stepsTaken: 6,
    lastUrl: "http://localhost:3000/events/verdict-demo-night",
    describeStep: (n) => (n === 5 ? 'click e12 on button "Confirm Booking"' : null),
    askLlm: vi.fn(async () => llmPass),
    ...overrides,
  };
}

const consoleError = { step: 5, text: "Uncaught TypeError: Cannot read properties of undefined (reading 'id')" };
const serverError = { step: 5, method: "POST", url: "http://localhost:5001/api/bookings", status: 500, failure: null };
const failedFinal = { step: 6, final: true, passed: false, expected: '"Booking Confirmed" is visible', observed: '"Booking Confirmed" is not visible' };
const passedFinal = { step: 6, final: true, passed: true, expected: '"Booking Confirmed" is visible', observed: '"Booking Confirmed" is visible' };

describe("hybrid judging order", () => {
  it("a console error forces fail and the LLM is never called", async () => {
    // A real (fake) LLM client with NO judge replies scripted: any call would throw.
    const llm = new FakeLlmClient({});
    const askLlm = vi.fn(async (): Promise<LlmJudgment> => JSON.parse((await llm.complete({ purpose: "judge", system: "", user: "" })).text));

    const d = await judge(input({ signals: { consoleErrors: [consoleError], failedRequests: [], redirectLoops: [] }, askLlm }));

    expect(d).toMatchObject({ result: "fail", decidedBy: "console", failingStep: 5 });
    expect(d.observed).toContain("TypeError");
    expect(d.observed).toContain('click e12 on button "Confirm Booking"');
    expect(askLlm).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
  });

  it("a console error overrides a passing DOM assertion (signals outrank the DOM)", async () => {
    const d = await judge(input({ signals: { consoleErrors: [consoleError], failedRequests: [], redirectLoops: [] }, assertions: [passedFinal] }));
    expect(d).toMatchObject({ result: "fail", decidedBy: "console" });
  });

  it("a 5xx from the app forces fail before console and DOM, without the LLM", async () => {
    const askLlm = vi.fn(async () => llmPass);
    const d = await judge(
      input({ signals: { consoleErrors: [consoleError], failedRequests: [serverError], redirectLoops: [] }, assertions: [passedFinal], askLlm }),
    );
    expect(d).toMatchObject({ result: "fail", decidedBy: "network", failingStep: 5 });
    expect(d.observed).toContain("POST http://localhost:5001/api/bookings → HTTP 500");
    expect(d.repairHint).toContain("/api/bookings");
    expect(askLlm).not.toHaveBeenCalled();
  });

  it("a request with no response is a network failure too", async () => {
    const refused = { ...serverError, status: null, failure: "net::ERR_CONNECTION_REFUSED" };
    const d = await judge(input({ signals: { consoleErrors: [], failedRequests: [refused], redirectLoops: [] } }));
    expect(d).toMatchObject({ result: "fail", decidedBy: "network" });
    expect(d.observed).toContain("net::ERR_CONNECTION_REFUSED");
  });

  it("a redirect loop forces fail (B6) before DOM checks and without the LLM", async () => {
    const askLlm = vi.fn(async () => llmPass);
    const loop = { step: 4, paths: ["/auth/login", "/events", "/auth/login", "/events", "/auth/login"] };
    const d = await judge(input({ signals: { consoleErrors: [], failedRequests: [], redirectLoops: [loop] }, assertions: [passedFinal], askLlm }));
    expect(d).toMatchObject({ result: "fail", decidedBy: "redirect_loop", failingStep: 4 });
    expect(d.observed).toContain("/auth/login ↔ /events");
    expect(askLlm).not.toHaveBeenCalled();
  });

  it("a failed final DOM assertion forces fail without the LLM", async () => {
    const askLlm = vi.fn(async () => llmPass);
    const d = await judge(input({ assertions: [passedFinal, failedFinal], stop: "final_assertion_failed", askLlm }));
    expect(d).toMatchObject({ result: "fail", decidedBy: "dom", failingStep: 6, observed: '"Booking Confirmed" is not visible' });
    expect(askLlm).not.toHaveBeenCalled();
  });

  it("passing final DOM assertions decide pass without the LLM", async () => {
    const askLlm = vi.fn(async () => llmPass);
    const d = await judge(input({ assertions: [passedFinal], askLlm }));
    expect(d).toMatchObject({ result: "pass", decidedBy: "dom", failingStep: null, repairHint: null });
    expect(askLlm).not.toHaveBeenCalled();
  });

  it("intermediate (non-final) assertions never decide", async () => {
    const askLlm = vi.fn(async () => llmPass);
    const d = await judge(input({ assertions: [{ ...failedFinal, final: false }], askLlm }));
    expect(d.decidedBy).toBe("llm");
    expect(askLlm).toHaveBeenCalledOnce();
  });

  it.each(["step_budget", "timeout"] as const)("%s with no decision is inconclusive, not fail, and skips the LLM", async (stop) => {
    const askLlm = vi.fn(async () => llmPass);
    const d = await judge(input({ stop, askLlm }));
    expect(d).toMatchObject({ result: "inconclusive", decidedBy: stop });
    expect(askLlm).not.toHaveBeenCalled();
  });

  it("the LLM judges only when every deterministic signal is silent", async () => {
    const askLlm = vi.fn(async (): Promise<LlmJudgment> => ({ result: "fail", expected: "Confirmation", observed: "Spinner forever", reason: "Booking never completes" }));
    const d = await judge(input({ askLlm }));
    expect(askLlm).toHaveBeenCalledOnce();
    expect(d).toMatchObject({ result: "fail", decidedBy: "llm", failingStep: 6, repairHint: "Booking never completes" });
  });
});
