import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Verdict } from "@verdict/schema";
import { buildServer, type Executor } from "../src/server.ts";
import { FileRunStore } from "../src/store.ts";

const KEY = "test-api-key-0123456789";
const auth = { authorization: `Bearer ${KEY}` };
const spec = {
  version: 1,
  task: "ENG-204 Ticket booking",
  base_url: "http://localhost:3000",
  auth: { email: "tester@example.com", password: "s3cret-pw" },
  criteria: [
    { id: "book-ticket", check: "A logged-in user can book one ticket and sees a confirmation." },
    { id: "sold-out", check: "On a sold-out event the booking button is disabled." },
  ],
};

function verdictFor(runId: string): Verdict {
  return {
    run_id: runId,
    status: "pass",
    commit: null,
    summary: { passed: 1, failed: 0, error: 0, inconclusive: 0 },
    criteria: [{ id: "book-ticket", result: "pass", expected: "x", observed: "x", failing_step: null, evidence: { screenshot_url: null, trace_url: null, console_errors: [], failed_requests: [] }, repair_hint: null }],
    cost: { llm_tokens: 10, usd: 0 },
    duration_ms: 5,
  };
}

async function setup(executor?: Executor) {
  const store = new FileRunStore(await mkdtemp(join(tmpdir(), "verdict-api-")));
  await store.init();
  const exec = vi.fn(executor ?? (async (_s, o) => verdictFor(o.runId)));
  const { app, queue } = buildServer({ store, executor: exec, apiKey: KEY });
  const post = (payload: unknown, key = "repo:abc123:spec1", headers: Record<string, string> = auth) =>
    app.inject({ method: "POST", url: "/v1/runs", headers: { ...headers, "idempotency-key": key }, payload: payload as object });
  return { app, queue, store, exec, post };
}

describe("Verdict API", () => {
  it("accepts a run (202), executes it in the background, and serves the verdict", async () => {
    const { app, queue, post, exec } = await setup();
    const res = await post({ spec, criteria: ["book-ticket"], commit: "abc123" });
    expect(res.statusCode).toBe(202);
    const { run_id, status } = res.json();
    expect(status).toBe("queued");

    await queue.onIdle();
    const got = await app.inject({ method: "GET", url: `/v1/runs/${run_id}`, headers: auth });
    expect(got.json()).toMatchObject({ run_id, status: "done", verdict: { status: "pass" }, request: { criteria: ["book-ticket"], commit: "abc123" } });
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ task: "ENG-204 Ticket booking" }), { runId: run_id, criterionIds: ["book-ticket"], commit: "abc123" });
  });

  it("idempotency: the same key and body returns the existing run instead of starting a new one", async () => {
    const { post, queue, exec } = await setup();
    const first = await post({ spec });
    const again = await post({ spec });
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json().run_id).toBe(first.json().run_id);
    await queue.onIdle();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("idempotency: reusing a key with a different body is a 409", async () => {
    const { post } = await setup();
    await post({ spec });
    const clash = await post({ spec, criteria: ["sold-out"] });
    expect(clash.statusCode).toBe(409);
  });

  it("never stores credentials on disk", async () => {
    const { post, queue, store } = await setup();
    const { run_id } = (await post({ spec })).json();
    await queue.onIdle();
    const onDisk = JSON.stringify(await store.get(run_id)) + JSON.stringify(store.getIdempotency("repo:abc123:spec1"));
    expect(onDisk).not.toContain("s3cret-pw");
    expect(onDisk).not.toContain("tester@example.com");
  });

  it("marks a run failed (not done) when Verdict itself can't produce a verdict", async () => {
    const { app, post, queue } = await setup(async () => {
      throw new Error("GEMINI_API_KEY is not set");
    });
    const { run_id } = (await post({ spec })).json();
    await queue.onIdle();
    const got = (await app.inject({ method: "GET", url: `/v1/runs/${run_id}`, headers: auth })).json();
    expect(got).toMatchObject({ status: "failed", error: "GEMINI_API_KEY is not set", verdict: null });
  });

  it.each([
    ["no API key", { spec }, "k1", {}, 401],
    ["a wrong API key", { spec }, "k1", { authorization: "Bearer nope" }, 401],
    ["an invalid spec", { spec: { ...spec, version: 2 } }, "k1", auth, 400],
    ["an unknown criterion", { spec, criteria: ["nope"] }, "k1", auth, 400],
    ["unknown body fields", { spec, extra: 1 }, "k1", auth, 400],
    ["an empty Idempotency-Key", { spec }, "", auth, 400],
  ])("rejects %s", async (_name, payload, key, headers, code) => {
    const { post, exec } = await setup();
    expect((await post(payload, key, headers as Record<string, string>)).statusCode).toBe(code);
    expect(exec).not.toHaveBeenCalled();
  });

  it("404s unknown runs and ignores path tricks", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/v1/runs/run_missing", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/runs/..%2Fidempotency", headers: auth })).statusCode).toBe(404);
  });

  it("serves /healthz without auth", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true, queued: 0 });
  });
});
