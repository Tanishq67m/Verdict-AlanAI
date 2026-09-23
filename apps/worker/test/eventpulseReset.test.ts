import { describe, expect, it } from "vitest";
import { silentLogger } from "@verdict/engine";
import { eventPulseReset } from "../src/resets/eventpulse.ts";
import { ConfigError, resetFromEnv } from "../src/runner.ts";

type Call = { method: string; url: string; auth: string | null };

/** A fake EventPulse API: records calls, answers like the real handlers (`{ success, data }`). */
function fakeApi(bookings: Array<{ id: string; status: string; checkedIn?: boolean }>, opts: { loginStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ method, url, auth: headers.get("authorization") });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/auth/login")) {
      if (opts.loginStatus) return json(opts.loginStatus, { success: false, error: "nope" });
      return json(200, { success: true, data: { user: {}, tokens: { accessToken: "tok-1", refreshToken: "r" } } });
    }
    if (url.endsWith("/bookings/my")) return json(200, { success: true, data: bookings });
    if (url.endsWith("/cancel")) return json(200, { success: true, data: {} });
    return json(404, {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const creds = { apiUrl: "http://localhost:5001/api/", email: "t@e.st", password: "pw" };
const ctx = { criterionId: "book-ticket", attempt: 1, logger: silentLogger };

describe("EventPulse test-data reset", () => {
  it("cancels only the test user's active, not-checked-in bookings", async () => {
    const api = fakeApi([
      { id: "b1", status: "CONFIRMED" },
      { id: "b2", status: "CANCELLED" },
      { id: "b3", status: "PENDING" },
      { id: "b4", status: "CONFIRMED", checkedIn: true },
    ]);
    await eventPulseReset({ ...creds, fetchImpl: api.fetchImpl })(ctx);
    expect(api.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      "http://localhost:5001/api/bookings/b1/cancel",
      "http://localhost:5001/api/bookings/b3/cancel",
    ]);
    expect(api.calls.filter((c) => c.method === "DELETE").every((c) => c.auth === "Bearer tok-1")).toBe(true);
  });

  it("logs in once per run and reuses the token across attempts", async () => {
    const api = fakeApi([]);
    const reset = eventPulseReset({ ...creds, fetchImpl: api.fetchImpl });
    await reset(ctx);
    await reset({ ...ctx, attempt: 2 });
    expect(api.calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(1);
  });

  it("explains a rate-limited login instead of failing silently", async () => {
    const api = fakeApi([], { loginStatus: 429 });
    await expect(eventPulseReset({ ...creds, fetchImpl: api.fetchImpl })(ctx)).rejects.toThrow(/HTTP 429.*rate limit/);
  });
});

describe("resetFromEnv", () => {
  const spec = { version: 1 as const, task: "t", base_url: "http://localhost:3000", criteria: [], limits: { max_steps_per_criterion: 15, timeout_seconds: 300 } };
  it("is off unless VERDICT_RESET is set", () => {
    expect(resetFromEnv({}, spec)).toBeUndefined();
  });
  it("rejects unknown adapters and a missing auth block", () => {
    expect(() => resetFromEnv({ VERDICT_RESET: "wordpress" }, spec)).toThrow(ConfigError);
    expect(() => resetFromEnv({ VERDICT_RESET: "eventpulse" }, spec)).toThrow(/needs the spec's auth block/);
  });
  it("builds the EventPulse hook when configured", () => {
    expect(typeof resetFromEnv({ VERDICT_RESET: "eventpulse" }, { ...spec, auth: { email: "a@b.c", password: "pw" } })).toBe("function");
  });
});
